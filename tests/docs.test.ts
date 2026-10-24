import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

/**
 * The documentation's references to the repository, checked without a
 * network: links, file paths, npm scripts, environment variables, routes and
 * the feature-status matrix. It cannot check that documented behaviour is
 * true; see docs/development/testing.md.
 */

const ROOT = path.join(__dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");
const exists = (p: string) => fs.existsSync(path.join(ROOT, p));

function walk(dir: string, ext: string, out: string[] = []): string[] {
  for (const e of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory()) walk(rel, ext, out);
    else if (rel.endsWith(ext)) out.push(rel);
  }
  return out;
}

const DOCS = ["README.md", "AGENTS.md", "deploy/digitalocean/README.md", ...walk("docs", ".md")];

/**
 * Dated audits and research describe the repository as it was when they were
 * written, so their paths and scripts may since have moved; only their links
 * are checked. Their index pages are maintained and checked in full.
 */
const HISTORICAL = /^docs\/(audits|research)\/(?!(.*\/)?index\.md$)/;
const CURRENT = DOCS.filter((d) => !HISTORICAL.test(d));

/** The text outside fenced code blocks. */
function prose(text: string): string {
  let fence = false;
  return text
    .split("\n")
    .filter((l) => {
      if (/^\s*```/.test(l)) {
        fence = !fence;
        return false;
      }
      return !fence;
    })
    .join("\n");
}

/** GitHub's anchors for a document's headings. */
function anchors(text: string): Set<string> {
  const seen = new Map<string, number>();
  const out = new Set<string>();
  for (const line of prose(text).split("\n")) {
    const m = /^#{1,6}\s+(.*)$/.exec(line);
    if (!m) continue;
    const base = m[1]
      .trim()
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, "")
      .replace(/\s/g, "-");
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    out.add(n === 0 ? base : `${base}-${n}`);
  }
  return out;
}

describe("documentation links", () => {
  for (const doc of DOCS) {
    it(`${doc}: every relative link and anchor resolves`, () => {
      const text = prose(read(doc));
      const broken: string[] = [];
      for (const m of text.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
        const target = m[1];
        if (/^(https?:|mailto:|tel:)/.test(target)) continue;
        const [file, anchor] = target.split("#");
        const resolved = file === "" ? doc : path.posix.normalize(path.posix.join(path.posix.dirname(doc), file));
        if (!exists(resolved)) {
          broken.push(target);
          continue;
        }
        if (anchor && resolved.endsWith(".md") && !anchors(read(resolved)).has(anchor)) broken.push(target);
      }
      expect(broken).toEqual([]);
    });
  }
});

describe("documentation references to the repository", () => {
  it("names only files and folders that exist", () => {
    const missing: string[] = [];
    for (const doc of CURRENT) {
      for (const m of prose(read(doc)).matchAll(/`((?:src|tests|db|scripts|deploy|docs|\.github)\/[^`\s]*)`/g)) {
        const p = m[1].replace(/[.,:;)]+$/, "");
        if (/[*<>…{}]/.test(p)) continue;
        // A module may be named as it is imported, without its extension.
        if (!exists(p) && !exists(`${p}.ts`)) missing.push(`${doc}: ${p}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("names only npm scripts that exist", () => {
    const scripts = Object.keys(JSON.parse(read("package.json")).scripts);
    const missing: string[] = [];
    for (const doc of CURRENT)
      for (const m of read(doc).matchAll(/npm run ([a-z][\w:-]*)/g))
        if (!scripts.includes(m[1])) missing.push(`${doc}: npm run ${m[1]}`);
    expect(missing).toEqual([]);
  });
});

describe("configuration", () => {
  const config = read("docs/development/configuration.md");
  const documented = new Set([...config.matchAll(/`([A-Z][A-Z0-9_]+)(\*?)`/g)].map((m) => m[1] + m[2]));
  const covered = (name: string) =>
    documented.has(name) || [...documented].some((d) => d.endsWith("*") && name.startsWith(d.slice(0, -1)));
  const code = [...walk("src", ".ts"), ...walk("src", ".tsx"), ...walk("scripts", ".mjs"), "next.config.ts"].map(read).join("\n");

  it("documents every environment variable the code reads", () => {
    const read = new Set([...code.matchAll(/process\.env\.([A-Z][A-Z0-9_]+)|process\.env\[["']([A-Z][A-Z0-9_]+)["']\]/g)].map((m) => m[1] ?? m[2]));
    // Gateway keys for the platform's own account are read by destructuring the environment (src/lib/gateways).
    for (const m of code.matchAll(/\b((?:STRIPE|BILLPLZ)_[A-Z][A-Z0-9_]+)\b/g)) read.add(m[1]);
    expect([...read].filter((v) => !covered(v)).sort()).toEqual([]);
  });

  it("lists no variable the code does not read", () => {
    const table = [...config.matchAll(/^\|\s*(`[^|]+`)\s*\|/gm)].flatMap((m) => [...m[1].matchAll(/`([A-Z][A-Z0-9_]+\*?)`/g)].map((x) => x[1]));
    const unused = table.filter((v) => (v.endsWith("*") ? !code.includes(v.slice(0, -1)) : !new RegExp(`\\b${v}\\b`).test(code)));
    expect(unused).toEqual([]);
  });

  it("puts every one of them in .env.example", () => {
    const example = read(".env.example");
    const table = [...config.matchAll(/^\|\s*(`[^|]+`)\s*\|/gm)].flatMap((m) => [...m[1].matchAll(/`([A-Z][A-Z0-9_]+\*?)`/g)].map((x) => x[1]));
    const absent = table.filter((v) => !new RegExp(`^# ?${v.endsWith("*") ? v.slice(0, -1) + "[A-Z_]+" : v}=`, "m").test(example));
    expect(absent).toEqual([]);
  });
});

describe("the HTTP route reference", () => {
  it("lists only routes that have a route.ts", () => {
    const missing: string[] = [];
    for (const m of read("docs/architecture/http-api.md").matchAll(/^\|\s*[A-Z/]+\s*\|\s*`(\/api\/[^`?]*)/gm)) {
      const parts = m[1].replace(/\/$/, "").split("/").filter(Boolean);
      // Walk the route folders, letting :param match any [dynamic] folder.
      let dirs = [path.join(ROOT, "src", "app")];
      for (const part of parts) {
        dirs = dirs.flatMap((d) => {
          if (!fs.existsSync(d)) return [];
          if (!part.startsWith(":")) return [path.join(d, part)];
          return fs.readdirSync(d).filter((e) => e.startsWith("[")).map((e) => path.join(d, e));
        });
      }
      if (!dirs.some((d) => fs.existsSync(path.join(d, "route.ts")))) missing.push(m[1]);
    }
    expect(missing).toEqual([]);
  });

  it("lists every route.ts", () => {
    const listed = new Set(
      [...read("docs/architecture/http-api.md").matchAll(/^\|\s*[A-Z/]+\s*\|\s*`(\/api\/[^`?]*)/gm)].map((m) =>
        m[1].replace(/\/$/, "").replace(/:[^/]+/g, ":")
      )
    );
    const routes = walk("src/app/api", "/route.ts").map((f) => path.posix.dirname(f).replace(/^src\/app/, "").replace(/\[[^\]]+\]/g, ":"));
    expect(routes.filter((r) => !listed.has(r)).sort()).toEqual([]);
  });

  it("lists each method a route answers, and only those", () => {
    const listed = new Map<string, Set<string>>();
    for (const m of read("docs/architecture/http-api.md").matchAll(/^\|\s*([A-Z/]+)\s*\|\s*`(\/api\/[^`?]*)/gm)) {
      const route = m[2].replace(/\/$/, "").replace(/:[^/]+/g, ":");
      for (const method of m[1].split("/")) listed.set(route, (listed.get(route) ?? new Set()).add(method));
    }
    const wrong: string[] = [];
    for (const f of walk("src/app/api", "/route.ts")) {
      const route = path.posix.dirname(f).replace(/^src\/app/, "").replace(/\[[^\]]+\]/g, ":");
      const answers = new Set([...read(f).matchAll(/export\s+(?:async\s+)?(?:function|const)\s+(GET|POST|PUT|PATCH|DELETE)\b/g)].map((m) => m[1]));
      const documented = listed.get(route) ?? new Set();
      for (const method of answers) if (!documented.has(method)) wrong.push(`${method} ${route} is not listed`);
      for (const method of documented) if (!answers.has(method)) wrong.push(`${method} ${route} is listed but not answered`);
    }
    expect(wrong.sort()).toEqual([]);
  });
});

describe("the feature-status matrix", () => {
  const STATUSES = [
    "IMPLEMENTED_AND_TESTED",
    "IMPLEMENTED_UNTESTED",
    "INTEGRATION_VERIFICATION_REQUIRED",
    "PARTIALLY_IMPLEMENTED",
    "PLANNED",
    "BLOCKED",
    "DEFERRED",
    "UNSUPPORTED",
    "UNKNOWN",
  ];
  const matrix = read("docs/product/feature-status.md");
  // Capability rows: | Capability | Status | Behaviour | Code | Tests | Gaps |
  const rows = matrix
    .split("\n")
    .filter((l) => /^\|\s*[^-|\s]/.test(l) && l.split("|").length >= 8 && !/^\|\s*Capability\s*\|/.test(l));

  const cell = (r: string, i: number) => r.split(/(?<!\\)\|/)[i]?.trim() ?? "";

  it("gives every capability a known status", () => {
    const bad = rows.filter((r) => !STATUSES.includes(cell(r, 2)));
    expect(bad).toEqual([]);
  });

  it("marks a capability tested only with a test file to show for it", () => {
    const bad = rows.filter((r) => cell(r, 2) === "IMPLEMENTED_AND_TESTED" && !/`tests\/[^`]+`/.test(cell(r, 5)));
    expect(bad).toEqual([]);
  });

  it("claims no tests for what is untested or not built", () => {
    const NONE = ["IMPLEMENTED_UNTESTED", "PLANNED", "BLOCKED", "DEFERRED", "UNSUPPORTED"];
    const bad = rows.filter((r) => NONE.includes(cell(r, 2)) && cell(r, 5) !== "—");
    expect(bad).toEqual([]);
  });

  it("names code that exists, at the root too", () => {
    const bad: string[] = [];
    for (const r of rows)
      for (const m of cell(r, 4).matchAll(/`([^`\s]+)`/g))
        if ((m[1].includes("/") || /^[\w.-]+\.(m?[jt]s|mts|ya?ml|json)$/.test(m[1])) && !exists(m[1]))
          bad.push(`${cell(r, 1)}: ${m[1]}`);
    expect(bad).toEqual([]);
  });

  it("names each capability once", () => {
    const names = rows.map((r) => cell(r, 1));
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
  });

  it("fills every column, with the code for anything built", () => {
    const BUILT = ["IMPLEMENTED_AND_TESTED", "IMPLEMENTED_UNTESTED", "INTEGRATION_VERIFICATION_REQUIRED", "PARTIALLY_IMPLEMENTED"];
    const bad = rows.filter(
      (r) => [1, 3, 4, 5, 6].some((i) => cell(r, i) === "") || (BUILT.includes(cell(r, 2)) && !/`[^`]*\/[^`]*`/.test(cell(r, 4)))
    );
    expect(bad).toEqual([]);
  });

  it("shows a tested capability's tests, not helpers or benchmarks", () => {
    const bad: string[] = [];
    for (const r of rows.filter((r) => cell(r, 2) === "IMPLEMENTED_AND_TESTED"))
      for (const m of cell(r, 5).matchAll(/`(tests\/[^`]+)`/g))
        if (!/\.(test|e2e|uat)\.tsx?$/.test(m[1])) bad.push(`${cell(r, 1)}: ${m[1]}`);
    expect(bad).toEqual([]);
  });

  it("states summary counts that match the rows", () => {
    const summary = new Map([...matrix.matchAll(/^\|\s*([A-Z_]+)\s*\|\s*(\d+)\s*\|\s*$/gm)].map((m) => [m[1], Number(m[2])]));
    const counted = new Map<string, number>();
    for (const r of rows) {
      const s = cell(r, 2);
      counted.set(s, (counted.get(s) ?? 0) + 1);
    }
    expect(Object.fromEntries(summary)).toEqual(Object.fromEntries(counted));
  });
});

describe("known limitations", () => {
  const limits = read("docs/roadmap/known-limitations.md");
  const ids = [...limits.matchAll(/^\|\s*([SBM]\d+)\s*\|/gm)].map((m) => m[1]);

  it("gives each defect one identifier, never reused", () => {
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });

  it("records every defect the other documents cite", () => {
    const bad: string[] = [];
    for (const file of DOCS.filter((f) => !f.endsWith("known-limitations.md")))
      for (const m of read(file).matchAll(/\(([SBM]\d{1,2})\)/g)) if (!ids.includes(m[1])) bad.push(`${file}: ${m[1]}`);
    expect(bad).toEqual([]);
  });
});
