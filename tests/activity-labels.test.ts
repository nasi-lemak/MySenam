import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";
import { ACTION_LABELS } from "../src/lib/activity-labels";

/**
 * Every kind of entry the code writes to the staff activity log has words of
 * its own (lib/activity-labels.ts), so the log never shows staff a raw name
 * such as `tournament.match_moved`. A new `logAction(..., { action })` without
 * a label fails here.
 */

function sources(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? sources(p) : /\.tsx?$/.test(e.name) ? [p] : [];
  });
}

describe("the staff activity log's words", () => {
  it("name every kind of entry the code writes", () => {
    const written = new Set<string>();
    for (const file of sources(path.join(__dirname, "..", "src")))
      for (const m of fs.readFileSync(file, "utf8").matchAll(/action: "([a-z_]+\.[a-z_.]+)"/g)) written.add(m[1]);
    expect(written.size).toBeGreaterThan(50);
    expect([...written].filter((a) => !(a in ACTION_LABELS)).sort()).toEqual([]);
  });
});
