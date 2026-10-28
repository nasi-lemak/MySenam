import fs from "fs";
import path from "path";
import { describe, expect, it } from "vitest";

/**
 * Every staff write leaves a line in the activity log (lib/activity.ts).
 *
 * Read from the source, not run: each `POST`, `PUT`, `PATCH` and `DELETE`
 * handler under `src/app/api/admin` must call `logAction` or `logFromRequest`
 * itself, through a helper in its own file, or through a function of
 * `src/lib` that does (followed through the library's own imports). A new
 * write route that logs nothing fails here unless it is added to
 * `NEEDS_NO_ENTRY` below with the reason it needs none.
 *
 * It is a reading of the code, so it can be fooled (a function that logs on
 * one branch only counts as logging); the behaviour of the entries that
 * matter is tested where they are written (tests/activity-log-coverage.test.ts).
 */

const ROOT = path.join(__dirname, "..");
const LOGGERS = /\b(logAction|logFromRequest)\s*\(/;

/**
 * Handlers that write nothing a member of staff would be asked about, each
 * with why. `file` is the route's folder under `src/app/api/admin`.
 */
const NEEDS_NO_ENTRY: Record<string, string> = {
  // Signing in and out, and one's own password: nobody is signed in yet, or it changes nothing at a venue.
  "auth/login POST": "signing in: nobody is signed in yet, and nothing at a venue changes",
  "auth/logout POST": "signing out changes nothing at a venue",
  "auth/forgot POST": "asking for a reset link: nobody is signed in, and the answer must not show whether the address has an account",
  "auth/reset POST": "setting a password from a reset link: nobody is signed in, and nothing at a venue changes",
  "auth/password POST": "changing one's own password: nothing at a venue changes",
  // The platform owner running the install itself: no venue's day, bookings, money or settings.
  "errors POST": "the platform owner marking an error report dealt with",
  "system POST": "the platform owner clearing a system alert",
  "demo POST": "the platform owner loading or moving the demonstration data (refused once anything is sold for real)",
  "backup POST": "the platform owner taking a backup now",
  "retention POST": "the platform owner running the privacy retention policy now (each erasure is in the erasure ledger, lib/erasure-ledger.ts)",
  "businesses POST": "the platform owner grouping venues into a business",
  "venues POST": "the platform owner adding a venue",
  "venue-applications POST": "the platform owner deciding an application to list a venue, stored on the application",
  "storefronts POST": "the platform owner's marketplace storefronts",
  "storefronts DELETE": "the platform owner's marketplace storefronts",
  "billing POST": "the platform's own invoices to venues: the owner's records of them, or a venue starting an online payment the gateway confirms",
  // A business manager's new branch starts as a draft that sells nothing until it goes live (logged as venue.go_live).
  "branches POST": "a business manager adding a draft branch, which sells nothing until it goes live",
  "setup POST": "ticking off or hiding the set-up checklist: a reminder, not a setting",
};

interface Fn {
  name: string;
  body: string;
}

/** Top-level declarations of a file: each from its first line to the next top-level line. */
function topLevel(src: string): Fn[] {
  const lines = src.split("\n");
  const out: Fn[] = [];
  let cur: Fn | null = null;
  for (const line of lines) {
    const m =
      /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*(\w+)/.exec(line) ??
      /^(?:export\s+)?(?:const|let)\s+(\w+)\s*(?::[^=]+)?=/.exec(line);
    if (m) {
      cur = { name: m[1], body: line };
      out.push(cur);
    } else if (/^[A-Za-z/@]/.test(line)) {
      cur = null;
    } else if (cur) cur.body += "\n" + line;
  }
  return out;
}

/** `name -> module file` for what a file imports from inside src. */
function imports(file: string, src: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of src.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*"([^"]+)"/g)) {
    const spec = m[2];
    let target: string | null = null;
    if (spec.startsWith("@/")) target = path.join(ROOT, "src", spec.slice(2));
    else if (spec.startsWith(".")) target = path.join(path.dirname(file), spec);
    if (!target) continue;
    const resolved = [target + ".ts", target + ".tsx", path.join(target, "index.ts")].find((p) => fs.existsSync(p));
    if (!resolved) continue;
    for (const part of m[1].split(",")) {
      const [orig, alias] = part.replace(/\btype\s+/, "").trim().split(/\s+as\s+/);
      if (orig) out.set((alias ?? orig).trim(), `${resolved}#${orig.trim()}`);
    }
  }
  return out;
}

const parsed = new Map<string, { fns: Map<string, Fn>; imports: Map<string, string> }>();
function parse(file: string) {
  let p = parsed.get(file);
  if (!p) {
    const src = fs.readFileSync(file, "utf8");
    p = { fns: new Map(topLevel(src).map((f) => [f.name, f])), imports: imports(file, src) };
    parsed.set(file, p);
  }
  return p;
}

const memo = new Map<string, boolean>();
/** Does this function (`file#name`) write to the log, itself or through what it calls? */
function logs(key: string, seen = new Set<string>()): boolean {
  if (memo.has(key)) return memo.get(key)!;
  if (seen.has(key)) return false;
  seen.add(key);
  const [file, name] = key.split("#");
  const { fns, imports: imp } = parse(file);
  const fn = fns.get(name);
  let result = false;
  if (fn) {
    if (LOGGERS.test(fn.body)) result = true;
    else
      for (const m of fn.body.matchAll(/\b(\w+)\s*(?:<[^>()]*>)?\(/g)) {
        const callee = m[1];
        if (callee === name) continue;
        if (fns.has(callee) && logs(`${file}#${callee}`, seen)) {
          result = true;
          break;
        }
        const target = imp.get(callee);
        if (target && target.includes(`${path.sep}src${path.sep}lib${path.sep}`) && logs(target, seen)) {
          result = true;
          break;
        }
      }
  }
  memo.set(key, result);
  return result;
}

function routeFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? routeFiles(p) : e.name === "route.ts" ? [p] : [];
  });
}

const ADMIN = path.join(ROOT, "src", "app", "api", "admin");

function writeHandlers(): { id: string; key: string }[] {
  const out: { id: string; key: string }[] = [];
  for (const file of routeFiles(ADMIN)) {
    const rel = path.relative(ADMIN, path.dirname(file)).split(path.sep).join("/");
    const { fns } = parse(file);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"])
      if (fns.has(method)) out.push({ id: `${rel} ${method}`, key: `${file}#${method}` });
  }
  return out;
}

describe("every staff write is in the activity log", () => {
  const handlers = writeHandlers();

  it("finds the admin write routes", () => {
    expect(handlers.length).toBeGreaterThan(100);
  });

  it("each write handler logs, or calls a library that does, or is allowed with a reason", () => {
    const silent = handlers.filter((h) => !(h.id in NEEDS_NO_ENTRY) && !logs(h.key)).map((h) => h.id);
    expect(silent.sort()).toEqual([]);
  });

  it("the allow-list names only handlers that exist and do not log anyway", () => {
    const known = new Map(handlers.map((h) => [h.id, h.key]));
    const stale = Object.keys(NEEDS_NO_ENTRY).filter((id) => !known.has(id) || logs(known.get(id)!));
    expect(stale).toEqual([]);
  });
});
