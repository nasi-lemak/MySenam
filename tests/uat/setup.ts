import fs from "fs";
import path from "path";
import type { TestProject } from "vitest/node";

/**
 * Where this run's evidence goes: UAT_ARTIFACTS, or artifacts/uat/<time>,
 * one folder per scenario inside it, and a summary of every scenario run.
 */
export default function setup(project: TestProject) {
  const root = path.join(import.meta.dirname, "..", "..");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const dir = path.resolve(process.env.UAT_ARTIFACTS ?? path.join(root, "artifacts", "uat", stamp));
  fs.mkdirSync(dir, { recursive: true });
  project.provide("uatDir", dir);
  return () => {
    const scenarios = fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory() && fs.existsSync(path.join(dir, d.name, "steps.json")))
      .map((d) => JSON.parse(fs.readFileSync(path.join(dir, d.name, "steps.json"), "utf8")));
    fs.writeFileSync(path.join(dir, "summary.json"), JSON.stringify({ dir, scenarios }, null, 2));
    console.log(`\nAcceptance evidence: ${dir} (${scenarios.filter((s) => s.ok).length} of ${scenarios.length} scenarios passed)`);
  };
}

declare module "vitest" {
  export interface ProvidedContext {
    uatDir: string;
  }
}
