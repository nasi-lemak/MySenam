import fs from "fs";
import path from "path";
import type { TestProject } from "vitest/node";

/**
 * Where this run's evidence goes: UAT_ARTIFACTS, or artifacts/uat/<time>,
 * one folder per scenario inside it, and a summary of every scenario run.
 *
 * Runs before the app starts (tests/e2e/server.ts), so it also says how the
 * app runs: as the marketplace (MYSENAM_MARKETPLACE=on), the way MySenam
 * itself is deployed, so a venue can sign itself up at /list-your-venue;
 * and where its output goes (server.log beside the evidence).
 */
export default function setup(project: TestProject) {
  process.env.MYSENAM_MARKETPLACE ??= "on";
  const root = path.join(import.meta.dirname, "..", "..");
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  const dir = path.resolve(process.env.UAT_ARTIFACTS ?? path.join(root, "artifacts", "uat", stamp));
  fs.mkdirSync(dir, { recursive: true });
  project.provide("uatDir", dir);
  // The app's own output, kept with the evidence (tests/e2e/server.ts writes it). It sends with
  // MYSENAM_SEND=log, so this is also where a scenario reads the emails the app sent.
  if (!process.env.E2E_URL) process.env.E2E_SERVER_LOG ??= path.join(dir, "server.log");
  project.provide("uatServerLog", process.env.E2E_URL ? null : (process.env.E2E_SERVER_LOG ?? null));
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
    uatServerLog: string | null;
  }
}
