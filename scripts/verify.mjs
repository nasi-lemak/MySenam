#!/usr/bin/env node
/**
 * One way to check MySenam, the same on a developer's machine, on the AI
 * development VM and on a staging machine. It is the release gate: nothing in
 * GitHub Actions runs it automatically (those workflows are manual only).
 *
 *   node scripts/verify.mjs fast            # typecheck, lint, and the tests affected by uncommitted changes (PGlite)
 *   node scripts/verify.mjs fast tests/games.test.ts   # typecheck, lint and the files named
 *   node scripts/verify.mjs release --pg docker       # THE RELEASE PROFILE: typecheck, lint, docs, the whole suite on
 *                                           #   PGlite and on Postgres 16, a fresh production build, the browser
 *                                           #   tests and every acceptance scenario (UAT), one after the other
 *   node scripts/verify.mjs full            # the release profile without the acceptance scenarios (a checkpoint, never a release)
 *   node scripts/verify.mjs ci              # the same as release
 *   node scripts/verify.mjs pg              # the suite on Postgres only
 *   node scripts/verify.mjs e2e             # the browser tests, building first only if the source changed
 *   node scripts/verify.mjs uat [file|title]  # the visual acceptance scenarios (tests/uat): all, one file, or one by title
 *   node scripts/verify.mjs check [report.json]  # is a release report still true of the source in this checkout?
 *
 * Postgres is mandatory for release, full, ci and pg: a run with no Postgres
 * is BLOCKED (exit 3), never passed. TEST_DATABASE_URL names one; otherwise,
 * with `--pg docker` (the default), a throwaway postgres:16 container on a
 * free loopback port, removed when the run ends however it ends. A server that
 * is not Postgres 16, is not on this machine, or is the one DATABASE_URL names
 * is refused.
 *
 * A step passes only when its process exited 0, nothing in it failed, it ran
 * tests, and nothing was skipped that scripts/lib/expected-skips.mjs does not
 * allow (on Postgres, nothing may be skipped). A process that is killed, runs
 * past its time limit or crashes fails; the run being interrupted fails. There
 * is no retry: a test that failed in a run failed in that run, and a later
 * rerun of it is a new, separate fact that does not change this report.
 *
 * Every run writes artifacts/verify/<commit>-<time>.json (and the steps' logs
 * and raw results beside it): the commit, whether the tree was dirty, the
 * digest of the exact source tested (taken before AND after: a change during
 * the run fails it), Node, the machine, each step's result with test counts
 * (PGlite and Postgres apart), the Postgres server used, and the providers
 * that were NOT exercised. The verdict is PASS, FAIL or BLOCKED; exit 0, 1, 3.
 * A release PASS is of one source digest only: `check` says whether it still is.
 */
import { execFileSync, spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { INTEGRATIONS, PGLITE_EXPECTED_SKIPS } from "./lib/expected-skips.mjs";
import { ROOT, sourceState } from "./lib/source.mjs";

const args = process.argv.slice(2);
const profile = args[0] ?? "fast";
const VALUE_FLAGS = ["--pg", "--report", "--max-workers"];
const rest = args.slice(1).filter((a, i, all) => !a.startsWith("--") && !VALUE_FLAGS.includes(all[i - 1]));
const flag = (name) => {
  const i = args.indexOf(name);
  return i === -1 ? null : (args[i + 1] ?? null);
};
const PROFILES = ["fast", "full", "release", "ci", "pg", "e2e", "uat", "check"];
if (!PROFILES.includes(profile)) {
  console.error(`Profiles: ${PROFILES.join(", ")}.`);
  process.exit(2);
}
const REPORTS = path.join(ROOT, "artifacts", "verify");
const MAJOR = 16;
/** The only files a commit may change after a release was verified: the record of the verification itself. */
const RECORD_FILES = ["docs/development/testing.md"];
/** Release grade: every mandatory phase, Postgres included, fresh build, nothing skipped unexpectedly, a clean tree. */
const releaseGrade = profile === "release" || profile === "ci";
const strict = releaseGrade || profile === "full" || profile === "pg";
const TIME_LIMITS = { typecheck: 25, lint: 20, docs: 10, "tests (PGlite)": 90, "tests (Postgres 16)": 90, build: 40, "browser tests (e2e)": 30, "acceptance scenarios (uat)": 120 };

// ---------------------------------------------------------------- check: is a report still true?
if (profile === "check") {
  const given = rest[0];
  let file = given ? path.resolve(given) : null;
  if (!file) {
    const reports = fs.existsSync(REPORTS)
      ? fs
          .readdirSync(REPORTS)
          .filter((f) => f.endsWith(".json"))
          .map((f) => path.join(REPORTS, f))
          .filter((f) => {
            try {
              const r = JSON.parse(fs.readFileSync(f, "utf8"));
              return r.schema === 2 && r.releaseGrade === true;
            } catch {
              return false;
            }
          })
          .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)
      : [];
    file = reports[0] ?? null;
  }
  if (!file || !fs.existsSync(file)) {
    console.log("NOT VERIFIED: no release report found in artifacts/verify/ (run: node scripts/verify.mjs release --pg docker).");
    process.exit(1);
  }
  const report = JSON.parse(fs.readFileSync(file, "utf8"));
  const now = sourceState();
  const problems = [];
  let recordOnly = 0;
  if (!report.releaseGrade) problems.push(`${path.basename(file)} is a ${report.profile} report, not a release report`);
  if (report.verdict !== "PASS") problems.push(`the report's verdict is ${report.verdict}`);
  if (report.sourceDigest !== now.digest) {
    // The one change allowed after a verification is the release record itself: commits that touch only these files.
    let changed = null;
    try {
      changed = execFileSync("git", ["diff", "--name-only", `${report.commit}..HEAD`], { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
      recordOnly = Number(execFileSync("git", ["rev-list", "--count", `${report.commit}..HEAD`], { cwd: ROOT, encoding: "utf8" }).trim());
    } catch {
      // the verified commit is not in this checkout
    }
    const outside = (changed ?? []).filter((p) => !RECORD_FILES.includes(p));
    if (changed === null) problems.push(`the verified commit ${String(report.commit).slice(0, 12)} is not in this checkout`);
    else if (outside.length > 0 || now.dirty) problems.push(`the source has changed since the verified commit${outside.length ? `: ${outside.slice(0, 5).join(", ")}${outside.length > 5 ? ` and ${outside.length - 5} more` : ""}` : " (uncommitted changes)"}`);
  } else if (now.dirty) problems.push("the working tree has uncommitted or untracked changes");
  console.log(`${problems.length ? "NOT VERIFIED" : "VERIFIED"}: ${path.relative(ROOT, file)} (${report.profile}, ${report.at})`);
  for (const p of problems) console.log(`  - ${p}`);
  if (!problems.length) console.log(`  commit ${report.commit}\n  source digest ${report.sourceDigest}${recordOnly ? `\n  ${recordOnly} commit(s) since touch only the release record (${RECORD_FILES.join(", ")})` : ""}\n  providers not exercised: ${(report.integrations ?? []).length} (see the report)`);
  process.exit(problems.length ? 1 : 0);
}

const startedAt = new Date();
const source = sourceState();
const runId = `${source.short}-${startedAt.getTime()}`;
const runDir = path.join(REPORTS, runId);
fs.mkdirSync(runDir, { recursive: true });
const steps = [];
const reasons = [];
const cleanups = [];
let current = null;
let interrupted = null;
let postgresInfo = null;
let finished = false;

async function cleanup() {
  while (cleanups.length) {
    try {
      await cleanups.pop()();
    } catch (err) {
      console.error(`cleanup: ${err instanceof Error ? err.message : err}`);
    }
  }
}

function hostInfo() {
  let diskFreeGB = null;
  try {
    const s = fs.statfsSync(ROOT);
    diskFreeGB = Math.round((s.bavail * s.bsize) / 1e8) / 10;
  } catch {
    // not available on this platform
  }
  const diskUsedPercent = diskUsedPercentOf(ROOT);
  return {
    platform: `${os.platform()} ${os.release()}`,
    cpus: os.cpus().length,
    memoryGB: Math.round(os.totalmem() / 1e8) / 10,
    freeMemoryGB: Math.round(os.freemem() / 1e8) / 10,
    diskFreeGB,
    diskUsedPercent,
  };
}

/**
 * How full the disk holding `dir` is, as df says it (used over used plus what a normal process may still use), to one decimal; null where
 * the platform cannot say. The same idea as lib/disk-health.ts (the app's own check), with the same two variables where both are set
 * sensibly: warn at 80%, and at 95% the phases that write the most (the build, the browser tests, the acceptance scenarios' videos and
 * traces) are BLOCKED, never run into a full disk (a restore child once crashed with a no-space error at about 99%).
 */
function diskUsedPercentOf(dir) {
  try {
    const s = fs.statfsSync(dir);
    const used = Number(s.blocks) - Number(s.bfree);
    const free = Number(s.bavail);
    return Number(s.blocks) > 0 && used >= 0 && used + free > 0 ? Math.round((used / (used + free)) * 1000) / 10 : null;
  } catch {
    return null;
  }
}
function diskLimits() {
  const warn = Number(process.env.MYSENAM_DISK_WARN_PERCENT);
  const block = Number(process.env.MYSENAM_DISK_BLOCK_PERCENT);
  const sane = (n) => Number.isFinite(n) && n > 0 && n <= 100;
  return sane(warn) && sane(block) && warn < block ? { warn, block } : { warn: 80, block: 95 };
}
/** True, with the phase noted as blocked, when the disk is at or past the block percentage. */
function diskBlocks(phase) {
  const used = diskUsedPercentOf(ROOT);
  const { block } = diskLimits();
  if (used === null || used < block) return false;
  note(phase, "blocked", `the disk is ${used}% used, at or past the ${block}% limit; ${phase} writes build output, videos or traces and would fill it. Free some space and run it again`);
  return true;
}

function writeReport() {
  if (finished) return null;
  finished = true;
  const finishedAt = new Date();
  const after = sourceState();
  const sourceUnchanged = after.digest === source.digest;
  if (!sourceUnchanged) reasons.push(`the source changed while the run was going (digest ${source.digest.slice(0, 12)} → ${after.digest.slice(0, 12)}): nothing it says applies to either`);
  if (interrupted) reasons.push(`the run was interrupted (${interrupted})`);
  if (strict && releaseGrade && source.dirty) reasons.push("the working tree was not clean: commit first, a release is of one commit");
  const failed = steps.filter((s) => s.status === "failed");
  const blocked = steps.filter((s) => s.status === "blocked");
  for (const s of failed) reasons.push(`${s.name} failed${s.reason ? `: ${s.reason}` : ""}`);
  for (const s of blocked) reasons.push(`${s.name} is blocked: ${s.reason}`);
  const mandatory = releaseGrade ? ["typecheck", "lint", "docs", "tests (PGlite)", "tests (Postgres 16)", "build", "browser tests (e2e)", "acceptance scenarios (uat)"] : [];
  for (const m of mandatory) if (!steps.some((s) => s.name === m && s.status === "passed") && !steps.some((s) => s.name === m && (s.status === "failed" || s.status === "blocked"))) reasons.push(`${m} did not run`);
  let verdict = "PASS";
  const hardFail = failed.length > 0 || !sourceUnchanged || interrupted || (releaseGrade && source.dirty) || (blocked.length === 0 && mandatory.some((m) => !steps.some((s) => s.name === m)));
  if (hardFail) verdict = "FAIL";
  else if (blocked.length > 0) verdict = "BLOCKED";
  const report = {
    schema: 2,
    profile,
    releaseGrade,
    at: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationSeconds: Math.round((finishedAt - startedAt) / 1000),
    commit: source.commit,
    dirty: source.dirty,
    sourceDigest: source.digest,
    sourceDigestAfter: after.digest,
    sourceUnchanged,
    node: process.version,
    host: hostInfo(),
    postgres: postgresInfo,
    verdict,
    reasons,
    steps,
    // Said every time: a pass here proves the code against fakes and stand-ins, not any provider.
    integrations: INTEGRATIONS.map(([name, how]) => ({ name, status: "NOT EXERCISED by this run (unverified)", verifiedBy: how })),
  };
  const out = flag("--report") ?? path.join(REPORTS, `${source.short}-${startedAt.getTime()}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2));
  console.log(
    `\n${verdict} — ${steps.map((s) => `${s.name}: ${s.status}${s.tests ? ` (${s.tests.passed}/${s.tests.total}${s.tests.skipped ? `, ${s.tests.skipped} skipped` : ""})` : ""}`).join("; ")}` +
      (reasons.length ? `\n${reasons.map((r) => `  - ${r}`).join("\n")}` : "") +
      `\nCommit ${source.short}${source.dirty ? " (DIRTY tree)" : ""}, source digest ${source.digest.slice(0, 16)}, ${report.durationSeconds}s\nReport: ${path.relative(ROOT, out)}`,
  );
  return verdict;
}

for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, async () => {
    if (interrupted) return;
    interrupted = signal;
    try {
      current?.kill("SIGKILL");
    } catch {
      // gone
    }
    await cleanup();
    writeReport();
    process.exit(130);
  });

// ---------------------------------------------------------------- running a step
const nodeOptions = process.env.NODE_OPTIONS?.includes("max-old-space-size") ? process.env.NODE_OPTIONS : `${process.env.NODE_OPTIONS ?? ""} --max-old-space-size=4096`.trim();

/** Run one command to the end; false-y status when it exited non-zero, was killed, or ran out of time. Output goes to the screen and to a log. */
function exec(name, command, commandArgs, env = {}) {
  return new Promise((resolve) => {
    const started = Date.now();
    const log = path.join(runDir, `${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.log`);
    const logStream = fs.createWriteStream(log);
    console.log(`\n▶ ${name}: ${[command, ...commandArgs].join(" ")}`);
    const child = spawn(command, commandArgs, { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_OPTIONS: nodeOptions, ...env } });
    current = child;
    let timedOut = false;
    const limit = (TIME_LIMITS[name] ?? 60) * 60_000;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, limit);
    for (const [stream, sink] of [
      [child.stdout, process.stdout],
      [child.stderr, process.stderr],
    ]) {
      stream.on("data", (chunk) => {
        sink.write(chunk);
        logStream.write(chunk);
      });
    }
    child.on("error", (err) => {
      clearTimeout(timer);
      logStream.end();
      resolve({ exitCode: null, signal: null, timedOut, seconds: 0, log, error: err.message });
    });
    child.on("close", (exitCode, signal) => {
      clearTimeout(timer);
      logStream.end();
      current = null;
      resolve({ exitCode, signal, timedOut, seconds: Math.round((Date.now() - started) / 100) / 10, log });
    });
  });
}

const rel = (p) => path.relative(ROOT, p);

/** Counts, failures and skips out of vitest's JSON result. */
function readResults(file) {
  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  const tests = { files: raw.testResults.length, total: raw.numTotalTests, passed: raw.numPassedTests, failed: raw.numFailedTests, skipped: raw.numPendingTests, todo: raw.numTodoTests ?? 0 };
  const failures = [];
  const skippedByFile = {};
  let filesFailed = 0;
  let filesSkipped = 0;
  for (const f of raw.testResults) {
    const name = path.relative(ROOT, f.name);
    const asserts = f.assertionResults ?? [];
    const failedHere = asserts.filter((a) => a.status === "failed");
    if (f.status === "failed") {
      filesFailed++;
      if (failedHere.length === 0) failures.push({ file: name, test: "(the file did not run)", message: String(f.message ?? "").slice(0, 300) });
    }
    for (const a of failedHere) failures.push({ file: name, test: a.fullName, message: String((a.failureMessages ?? [])[0] ?? "").slice(0, 300) });
    const skipped = asserts.filter((a) => a.status === "pending" || a.status === "skipped").length;
    if (skipped > 0) skippedByFile[name] = skipped;
    if (asserts.length > 0 && skipped === asserts.length) filesSkipped++;
  }
  tests.filesFailed = filesFailed;
  tests.filesSkipped = filesSkipped;
  return { tests, failures, skippedByFile };
}

/** A vitest step. `skips`: "none" (nothing may be skipped), "pglite" (only the listed Postgres-only tests), "any" (not enforced). */
async function testStep(name, vitestArgs, { env = {}, skips = "any", allowEmpty = false } = {}) {
  const resultFile = path.join(runDir, `${name.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}.vitest.json`);
  const ran = await exec(name, npx("vitest"), ["run", ...vitestArgs, "--reporter=default", "--reporter=json", `--outputFile.json=${resultFile}`, ...(flag("--max-workers") ? ["--maxWorkers", flag("--max-workers")] : [])], env);
  const step = { name, status: "passed", exitCode: ran.exitCode, seconds: ran.seconds, log: rel(ran.log) };
  const fail = (reason) => {
    step.status = "failed";
    step.reason = step.reason ? `${step.reason}; ${reason}` : reason;
  };
  if (ran.signal) fail(`killed by ${ran.signal}${ran.timedOut ? ` after the ${TIME_LIMITS[name] ?? 60}-minute limit` : ""}`);
  else if (ran.timedOut) fail("ran past its time limit");
  if (ran.error) fail(ran.error);
  if (ran.exitCode !== 0) fail(`exit code ${ran.exitCode}`);
  if (fs.existsSync(resultFile)) {
    try {
      const { tests, failures, skippedByFile } = readResults(resultFile);
      step.tests = tests;
      step.result = rel(resultFile);
      if (failures.length) {
        step.failures = failures;
        fail(`${tests.failed} test(s) and ${tests.filesFailed} file(s) failed`);
      }
      if (tests.total === 0 && !allowEmpty) fail("no tests ran");
      if (skips !== "any" && tests.skipped > 0) {
        const unexpected = [];
        for (const [file, n] of Object.entries(skippedByFile)) {
          const allowed = skips === "pglite" ? (PGLITE_EXPECTED_SKIPS[file] ?? 0) : 0;
          if (n > allowed) unexpected.push(`${file}: ${n} skipped${allowed ? `, ${allowed} allowed` : ""}`);
        }
        if (unexpected.length) {
          step.unexpectedSkips = unexpected;
          fail(`unexpected skips: ${unexpected.join("; ")}`);
        }
      }
      if (skips === "pglite") {
        const missing = Object.entries(PGLITE_EXPECTED_SKIPS).filter(([f, n]) => (skippedByFile[f] ?? 0) !== n && step.tests.files > 100);
        if (missing.length) step.note = `the listed Postgres-only skips differ from the list: ${missing.map(([f, n]) => `${f} (${skippedByFile[f] ?? 0} of ${n})`).join(", ")}`;
      }
    } catch (err) {
      fail(`the result file could not be read: ${err instanceof Error ? err.message : err}`);
    }
  } else {
    fail("no result file: the run did not finish");
  }
  steps.push(step);
  console.log(`${step.status === "passed" ? "✔" : "✖"} ${name} (${step.seconds}s)${step.tests ? ` ${step.tests.passed} passed, ${step.tests.failed} failed, ${step.tests.skipped} skipped of ${step.tests.total}` : ""}${step.reason ? ` — ${step.reason}` : ""}`);
  return step.status === "passed";
}

/** A command that is not vitest (tsc, eslint, next build). */
async function plainStep(name, command, commandArgs, env = {}) {
  const ran = await exec(name, command, commandArgs, env);
  const step = { name, status: "passed", exitCode: ran.exitCode, seconds: ran.seconds, log: rel(ran.log) };
  if (ran.signal || ran.timedOut || ran.error || ran.exitCode !== 0) {
    step.status = "failed";
    step.reason = ran.signal ? `killed by ${ran.signal}${ran.timedOut ? ` after the ${TIME_LIMITS[name] ?? 60}-minute limit` : ""}` : ran.timedOut ? "ran past its time limit" : ran.error ?? `exit code ${ran.exitCode}`;
  }
  steps.push(step);
  console.log(`${step.status === "passed" ? "✔" : "✖"} ${name} (${step.seconds}s)${step.reason ? ` — ${step.reason}` : ""}`);
  return step.status === "passed";
}

function note(name, status, reason) {
  steps.push({ name, status, reason });
  console.log(`${status === "skipped" ? "–" : "■"} ${name}: ${status}, ${reason}`);
}

const npx = (bin) => path.join(ROOT, "node_modules", ".bin", bin);
const typecheck = () => plainStep("typecheck", npx("tsc"), ["--noEmit"]);
const lint = () => plainStep("lint", npx("eslint"), [".", "--max-warnings", "0"]);
const docs = () => testStep("docs", ["tests/docs.test.ts"], { env: { TEST_DATABASE_URL: "", MYSENAM_DB: ":memory:" }, skips: strict ? "none" : "any" });
const pglite = (extra = []) => testStep("tests (PGlite)", extra, { env: { TEST_DATABASE_URL: "", MYSENAM_DB: ":memory:" }, skips: strict ? "pglite" : "any", allowEmpty: extra.includes("--passWithNoTests") });

// ---------------------------------------------------------------- Postgres
function dockerAnswers() {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 });
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

/** What the server says it is, and how many transactions it has committed in all (to show later that the suite really used it). */
async function probe(url) {
  const { default: pg } = await import("pg");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    const version = (await client.query("SHOW server_version")).rows[0].server_version;
    const commits = Number((await client.query("SELECT COALESCE(SUM(xact_commit), 0) AS n FROM pg_stat_database")).rows[0].n);
    return { version, major: Number(String(version).split(".")[0]), commits };
  } finally {
    await client.end();
  }
}

/** A Postgres to test against, how it was found, and why not when there is none. A server that could hold real data is refused. */
async function postgres() {
  const fromEnv = process.env.TEST_DATABASE_URL;
  const want = flag("--pg") ?? "docker";
  if (!fromEnv && want === "none") return { url: null, how: "--pg none", blocked: "--pg none: Postgres was declined" };
  let url = fromEnv ?? (want !== "docker" ? want : null);
  let how = fromEnv ? "TEST_DATABASE_URL" : want !== "docker" ? "--pg" : "";
  if (!url) {
    if (!dockerAnswers()) return { url: null, how: "", blocked: "no TEST_DATABASE_URL, and Docker does not answer (start the daemon, or name a Postgres 16 server with TEST_DATABASE_URL)" };
    const port = await freePort();
    const name = `mysenam-verify-${crypto.randomBytes(4).toString("hex")}`;
    const password = crypto.randomBytes(12).toString("hex");
    const expires = Math.floor(Date.now() / 1000) + 3 * 3600;
    try {
      execFileSync(
        "docker",
        ["run", "-d", "--rm", "--name", name, "--label", "mysenam.purpose=verify", "--label", `mysenam.expires=${expires}`, "-e", `POSTGRES_PASSWORD=${password}`, "-p", `127.0.0.1:${port}:5432`, "postgres:16-alpine", "-c", "max_connections=300", "-c", "fsync=off"],
        { stdio: "ignore" },
      );
    } catch (err) {
      return { url: null, how: "", blocked: `the Postgres container would not start: ${err instanceof Error ? err.message.split("\n")[0] : err}` };
    }
    cleanups.push(async () => execFileSync("docker", ["rm", "-f", name], { stdio: "ignore" }));
    url = `postgres://postgres:${password}@127.0.0.1:${port}/postgres`;
    how = `throwaway container ${name} (postgres:16-alpine on 127.0.0.1:${port})`;
    const deadline = Date.now() + 90_000;
    for (;;) {
      try {
        execFileSync("docker", ["exec", name, "pg_isready", "-U", "postgres", "-h", "127.0.0.1"], { stdio: "ignore" });
        break;
      } catch {
        if (Date.now() > deadline) return { url: null, how, blocked: "the Postgres container did not become ready in 90 seconds" };
        await new Promise((r) => setTimeout(r, 500));
      }
    }
  }
  // Isolation: only this machine, and never the database the app itself is configured to use.
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return { url: null, how, blocked: "the Postgres URL cannot be read" };
  }
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host)) return { url: null, how, blocked: `refused: ${host} is not this machine, and a verification run empties tables` };
  if (process.env.DATABASE_URL && process.env.DATABASE_URL === url) return { url: null, how, blocked: "refused: that is the database DATABASE_URL names" };
  let info;
  try {
    info = await probe(url);
  } catch (err) {
    return { url: null, how, blocked: `the server did not answer: ${err instanceof Error ? err.message : err}` };
  }
  if (info.major !== MAJOR) return { url: null, how, blocked: `refused: the server is PostgreSQL ${info.version}, a release is verified on ${MAJOR}`, failed: true };
  return { url, how, version: info.version, commitsBefore: info.commits };
}

async function pgSuite(extra = []) {
  const pg = await postgres();
  postgresInfo = { how: pg.how || null, version: pg.version ?? null, isolated: Boolean(pg.url), exercised: false };
  if (!pg.url) {
    if (pg.failed) {
      steps.push({ name: "tests (Postgres 16)", status: "failed", reason: pg.blocked });
      console.log(`✖ tests (Postgres 16): ${pg.blocked}`);
      return false;
    }
    note("tests (Postgres 16)", "blocked", pg.blocked);
    return false;
  }
  console.log(`Postgres: ${pg.how}, server ${pg.version}`);
  const ok = await testStep("tests (Postgres 16)", extra, { env: { TEST_DATABASE_URL: pg.url }, skips: "none" });
  try {
    const after = await probe(pg.url);
    postgresInfo.transactionsCommitted = after.commits - pg.commitsBefore;
    postgresInfo.exercised = postgresInfo.transactionsCommitted > 1000;
  } catch (err) {
    postgresInfo.note = `the server could not be asked afterwards: ${err instanceof Error ? err.message : err}`;
  }
  const step = steps[steps.length - 1];
  if (step.name === "tests (Postgres 16)") step.postgres = postgresInfo;
  if (ok && extra.length === 0 && !postgresInfo.exercised) {
    step.status = "failed";
    step.reason = `the suite passed but the server shows only ${postgresInfo.transactionsCommitted ?? "an unknown number of"} committed transactions: Postgres was not really exercised`;
    return false;
  }
  return ok;
}

// ---------------------------------------------------------------- build and the browser
/** The production build; for a release always made afresh, otherwise made again only when the source it was made from differs. */
async function build() {
  if (diskBlocks("build")) return false;
  const stamp = path.join(ROOT, ".next", "mysenam-source.json");
  if (!strict) {
    try {
      const built = JSON.parse(fs.readFileSync(stamp, "utf8"));
      if (built.digest === source.digest && fs.existsSync(path.join(ROOT, ".next", "BUILD_ID"))) {
        note("build", "skipped", `the build in .next is of this source (${source.digest.slice(0, 12)})`);
        return true;
      }
    } catch {
      // no stamp: build
    }
  } else {
    fs.rmSync(path.join(ROOT, ".next"), { recursive: true, force: true });
  }
  const ok = await plainStep("build", npx("next"), ["build"]);
  if (ok) fs.writeFileSync(stamp, JSON.stringify({ ...source, builtAt: new Date().toISOString() }, null, 2));
  return ok;
}
const e2e = async () => (diskBlocks("browser tests (e2e)") ? false : testStep("browser tests (e2e)", ["--config", "vitest.e2e.config.mts"], { skips: strict ? "none" : "any" }));
/**
 * "Accounts AG" (tests/uat/round7.uat.ts) invoices a booking made for the next hour of the day at the venue, and from 23:00
 * Malaysian time there is none. A release does not start the acceptance scenarios from 22:15 until just after midnight there:
 * it waits (the machine is idle, nothing is spent), and the report says how long.
 */
async function clearOfMidnight() {
  const mytMinutes = () => {
    const now = new Date(Date.now() + 8 * 3_600_000);
    return now.getUTCHours() * 60 + now.getUTCMinutes();
  };
  const m = mytMinutes();
  if (m < 22 * 60 + 15) return 0;
  const waitMinutes = 24 * 60 - m + 1;
  console.log(`\n⏸ the acceptance scenarios wait ${waitMinutes} minutes for midnight in Malaysia (a scenario needs an hour of the day still to come)`);
  await new Promise((r) => setTimeout(r, waitMinutes * 60_000));
  return waitMinutes * 60;
}
// A file ("matchmaking", "tests/uat/booking.uat.ts") or one scenario by its title ("C:", "Booking 2").
const uat = async (scenario) => {
  const waited = strict && !scenario ? await clearOfMidnight() : 0;
  const ok = await uatSteps(scenario);
  if (waited) steps[steps.length - 1].waitedForMidnightSeconds = waited;
  return ok;
};
const uatSteps = async (scenario) =>
  diskBlocks("acceptance scenarios (uat)")
    ? false
    : testStep("acceptance scenarios (uat)", ["--config", "vitest.uat.config.mts", ...(!scenario ? [] : /^[a-z/._-]+$/.test(scenario) ? [scenario] : ["-t", scenario])], { skips: strict && !scenario ? "none" : "any" });

// ---------------------------------------------------------------- preflight
function preflight() {
  const h = hostInfo();
  const { warn, block } = diskLimits();
  console.log(`Machine: ${h.cpus} CPUs, ${h.memoryGB} GB memory (${h.freeMemoryGB} GB free), ${h.diskFreeGB ?? "?"} GB disk free (${h.diskUsedPercent ?? "?"}% used), Node ${process.version}`);
  if (h.diskUsedPercent !== null && h.diskUsedPercent >= warn) console.log(`⚠ the disk is ${h.diskUsedPercent}% used (warning at ${warn}%): the build, browser tests and acceptance scenarios are BLOCKED at ${block}%`);
  if (h.memoryGB < 6) note("preflight", "blocked", `${h.memoryGB} GB of memory; the build and the suites need about 6`);
  else if (h.diskFreeGB !== null && h.diskFreeGB < 3) note("preflight", "blocked", `${h.diskFreeGB} GB of disk free; the acceptance scenarios keep videos and traces, about 3 GB are needed`);
  else return true;
  return false;
}

let exitCode = 1;
try {
  if (strict && !preflight()) {
    // blocked before anything was spent
  } else if (profile === "fast") {
    await typecheck();
    await lint();
    await pglite(rest.length ? rest : ["--changed", "HEAD", "--passWithNoTests"]);
  } else if (profile === "pg") {
    await pgSuite(rest);
  } else if (profile === "e2e") {
    if (await build()) await e2e();
  } else if (profile === "uat") {
    if (await build()) await uat(rest[0]);
  } else {
    // full, release, ci: every step, one after the other (never two builds or suites at once), even after one fails,
    // so the report says everything that is wrong.
    await typecheck();
    await lint();
    await docs();
    await pglite();
    await pgSuite();
    if (await build()) {
      await e2e();
      if (releaseGrade) await uat();
    } else {
      note("browser tests (e2e)", "skipped", "the build did not pass");
      if (releaseGrade) note("acceptance scenarios (uat)", "skipped", "the build did not pass");
    }
  }
} catch (err) {
  reasons.push(`the verification itself crashed: ${err instanceof Error ? err.stack ?? err.message : err}`);
  steps.push({ name: "verify.mjs", status: "failed", reason: "crashed" });
} finally {
  await cleanup();
}
const verdict = writeReport();
exitCode = verdict === "PASS" ? 0 : verdict === "BLOCKED" ? 3 : 1;
process.exit(exitCode);
