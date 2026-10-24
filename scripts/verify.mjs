#!/usr/bin/env node
/**
 * One way to check MySenam, the same here, on a staging machine and in CI:
 *
 *   node scripts/verify.mjs fast            # typecheck, lint, and the tests affected by uncommitted changes (PGlite)
 *   node scripts/verify.mjs fast tests/games.test.ts   # typecheck, lint and the files named
 *   node scripts/verify.mjs full            # everything: typecheck, lint, docs, PGlite, Postgres, build, browser tests
 *   node scripts/verify.mjs ci              # what CI runs: full
 *   node scripts/verify.mjs pg              # the suite on Postgres only
 *   node scripts/verify.mjs e2e             # the browser tests, building first only if the source changed
 *   node scripts/verify.mjs uat [scenario]  # the visual acceptance scenarios (tests/uat)
 *
 * Postgres: TEST_DATABASE_URL if set; otherwise, with `--pg docker` (the
 * default for full and pg when Docker answers), a throwaway postgres:16
 * container on a free port, removed when the run ends however it ends. With
 * neither, the Postgres step is reported as blocked, never as passed.
 *
 * Every run writes artifacts/verify/<commit>-<time>.json: the commit, whether
 * the tree was dirty, the content digest tested, and each step's result and
 * time. Exits non-zero if any step failed.
 */
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { ROOT, sourceState } from "./lib/source.mjs";

const args = process.argv.slice(2);
const profile = args[0] ?? "fast";
const rest = args.slice(1).filter((a, i, all) => !a.startsWith("--") && all[i - 1] !== "--pg" && all[i - 1] !== "--report");
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : args[i + 1] ?? null;
};
const PROFILES = ["fast", "full", "ci", "pg", "e2e", "uat"];
if (!PROFILES.includes(profile)) {
  console.error(`Profiles: ${PROFILES.join(", ")}.`);
  process.exit(2);
}

const source = sourceState();
const steps = [];
const cleanups = [];
let stopping = false;
async function cleanup() {
  while (cleanups.length) {
    try {
      await cleanups.pop()();
    } catch (err) {
      console.error(`cleanup: ${err instanceof Error ? err.message : err}`);
    }
  }
}
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    await cleanup();
    process.exit(130);
  });

function run(name, command, commandArgs, env = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    console.log(`\n▶ ${name}: ${[command, ...commandArgs].join(" ")}`);
    const child = spawn(command, commandArgs, { cwd: ROOT, stdio: "inherit", env: { ...process.env, ...env } });
    child.on("close", (code) => {
      const step = { name, status: code === 0 ? "passed" : "failed", exitCode: code, seconds: Math.round((Date.now() - started) / 100) / 10 };
      steps.push(step);
      console.log(`${code === 0 ? "✔" : "✖"} ${name} (${step.seconds}s)`);
      resolve(code === 0);
    });
  });
}
const note = (name, status, detail) => {
  steps.push({ name, status, detail });
  console.log(`${status === "skipped" ? "–" : "■"} ${name}: ${status}, ${detail}`);
};

const npx = (bin) => path.join(ROOT, "node_modules", ".bin", bin);
const typecheck = () => run("typecheck", npx("tsc"), ["--noEmit"]);
const lint = () => run("lint", npx("eslint"), [".", "--max-warnings", "0"]);
const docs = () => run("docs", npx("vitest"), ["run", "tests/docs.test.ts"]);
const pglite = (extra = []) => run("tests (PGlite)", npx("vitest"), ["run", ...extra], { TEST_DATABASE_URL: "", MYSENAM_DB: ":memory:" });

function dockerAnswers() {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

const freePort = () =>
  new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });

/** A Postgres to test against, and how it was found; null with why when there is none. */
async function postgres() {
  if (process.env.TEST_DATABASE_URL) return { url: process.env.TEST_DATABASE_URL, how: "TEST_DATABASE_URL" };
  const want = flag("--pg") ?? "docker";
  if (want === "none") return { url: null, how: "--pg none" };
  if (want !== "docker") return { url: want, how: "--pg" };
  if (!dockerAnswers()) return { url: null, how: "no TEST_DATABASE_URL and Docker is not available" };
  const port = await freePort();
  const name = `mysenam-verify-${crypto.randomBytes(4).toString("hex")}`;
  const password = crypto.randomBytes(12).toString("hex");
  const expires = Math.floor(Date.now() / 1000) + 2 * 3600;
  execFileSync("docker", [
    "run", "-d", "--rm", "--name", name,
    "--label", "mysenam.purpose=verify", "--label", `mysenam.expires=${expires}`,
    "-e", `POSTGRES_PASSWORD=${password}`, "-p", `127.0.0.1:${port}:5432`,
    "postgres:16-alpine", "-c", "max_connections=300", "-c", "fsync=off",
  ], { stdio: "ignore" });
  cleanups.push(async () => execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" }));
  const url = `postgres://postgres:${password}@127.0.0.1:${port}/postgres`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      execFileSync("docker", ["exec", name, "pg_isready", "-U", "postgres", "-h", "127.0.0.1"], { stdio: "ignore" });
      break;
    } catch {
      if (Date.now() > deadline) throw new Error("The Postgres container did not become ready.");
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  return { url, how: `throwaway container ${name}` };
}

async function pgSuite(extra = []) {
  const pg = await postgres();
  if (!pg.url) return note("tests (Postgres 16)", "blocked", pg.how), true;
  console.log(`Postgres: ${pg.how}`);
  return run("tests (Postgres 16)", npx("vitest"), ["run", ...extra], { TEST_DATABASE_URL: pg.url });
}

/** The production build, made again only when the source it was made from differs. */
async function build() {
  const stamp = path.join(ROOT, ".next", "mysenam-source.json");
  try {
    const built = JSON.parse(fs.readFileSync(stamp, "utf8"));
    if (built.digest === source.digest && fs.existsSync(path.join(ROOT, ".next", "BUILD_ID")) && profile !== "full" && profile !== "ci") {
      note("build", "skipped", `the build in .next is of this source (${source.digest.slice(0, 12)})`);
      return true;
    }
  } catch {
    // no stamp: build
  }
  const ok = await run("build", npx("next"), ["build"]);
  if (ok) fs.writeFileSync(stamp, JSON.stringify({ ...source, builtAt: new Date().toISOString() }, null, 2));
  return ok;
}
const e2e = () => run("browser tests (e2e)", npx("vitest"), ["run", "--config", "vitest.e2e.config.mts"]);
const uat = (scenario) =>
  run("acceptance scenarios (uat)", npx("vitest"), ["run", "--config", "vitest.uat.config.mts", ...(scenario ? [scenario] : [])]);

let ok = true;
const all = (...results) => results.every(Boolean);
try {
  if (profile === "fast") {
    ok = all(await typecheck(), await lint(), await pglite(rest.length ? rest : ["--changed", "HEAD", "--passWithNoTests"]));
  } else if (profile === "pg") {
    ok = await pgSuite(rest);
  } else if (profile === "e2e") {
    ok = (await build()) && (await e2e());
  } else if (profile === "uat") {
    ok = (await build()) && (await uat(rest[0]));
  } else {
    // full and ci: every step, even after one fails, so the report says everything that is wrong.
    const results = [await typecheck(), await lint(), await docs(), await pglite(), await pgSuite()];
    const built = await build();
    results.push(built, built ? await e2e() : (note("browser tests (e2e)", "skipped", "the build failed"), false));
    ok = all(...results);
  }
} finally {
  await cleanup();
}

const report = {
  profile,
  at: new Date().toISOString(),
  commit: source.commit,
  dirty: source.dirty,
  sourceDigest: source.digest,
  node: process.version,
  ok,
  steps,
};
const out = flag("--report") ?? path.join(ROOT, "artifacts", "verify", `${source.short}-${Date.now()}.json`);
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(report, null, 2));
console.log(`\n${ok ? "All passed" : "FAILED"} — ${steps.map((s) => `${s.name}: ${s.status}`).join(", ")}\nReport: ${path.relative(ROOT, out)}`);
process.exit(ok ? 0 : 1);
