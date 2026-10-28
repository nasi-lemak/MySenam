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
      for (const m of fs.readFileSync(file, "utf8").matchAll(/action:([\s\S]{0,400})/g)) {
        // The whole value, up to the next property: a kind chosen by `? :` (over lines) is a kind written too.
        const [first, ...rest] = m[1].split("\n");
        const lines = [first];
        for (const line of rest) {
          // A value starting on the next line, then the `? :` lines that go on with it.
          if (!/^\s*[?:]/.test(line) && lines.join("").trim() !== "") break;
          lines.push(line);
        }
        const value = lines.join("\n").split(/,\s*(?:[a-zA-Z_]+\s*[:,]|\.\.\.)|\}/)[0];
        for (const s of value.matchAll(/"([a-z_]+\.[a-z_.]+)"/g)) written.add(s[1]);
      }
    expect(written.size).toBeGreaterThan(50);
    // Read through a choice over lines and a typed parameter too (once missed, so shown raw in the log).
    expect([...written]).toEqual(expect.arrayContaining(["tournament.final_chosen", "league.result_cleared", "league.joined"]));
    expect([...written].filter((a) => !(a in ACTION_LABELS)).sort()).toEqual([]);
  });
});
