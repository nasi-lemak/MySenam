import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import net from "net";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { uploaded } from "../src/lib/approval-documents";
import { apply, openDocument, saveRequirement } from "../src/lib/approvals";
import { registerUser } from "../src/lib/auth";
import {
  freshclamRunning,
  OnDemandClamd,
  onDemandOptionsFromEnv,
  processAlive,
  readClamdConf,
  signaturesOnDisk,
  type OnDemandOptions,
} from "../src/lib/clamd-on-demand";
import { getDb } from "../src/lib/db";
import { ClamdScanner, clamdAddress, setDocumentScanner } from "../src/lib/document-scanner";
import { documentsNeedingScanner, onDemandHooks, scannerHealth, setOnDemandScanner, tickOnDemandScanner } from "../src/lib/document-scanning";
import { createResources } from "../src/lib/resources";
import { createVenue } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * clamd started on demand (lib/clamd-on-demand.ts; ADR 0024, amended
 * 27 October 2026), against a stand-in clamd (tests/helpers/fake-clamd.mjs:
 * a Node process that speaks enough of clamd's protocol and misbehaves on
 * request). Every guard path: too little memory and freshclam running keep
 * documents waiting; a start that hangs is killed and tried again later; a
 * crash mid-scan leaves the document pending; an idle clamd is stopped;
 * concurrent ticks and a second process start one clamd; the app shutting
 * down stops it. Nothing is ever released because a scanner could not
 * start. The real engine, started on demand with the official signatures:
 * tests/clamd-on-demand-engine.test.ts.
 */

const HELPER = fileURLToPath(new URL("./helpers/fake-clamd.mjs", import.meta.url));
const MODULE = fileURLToPath(new URL("../src/lib/clamd-on-demand.ts", import.meta.url));
const PDF = Buffer.from(
  "%PDF-1.7\n1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n",
  "latin1"
);

const work = fs.mkdtempSync(path.join(os.tmpdir(), "mysenam-ondemand-"));
/** The "clamd binary": a shell script that runs the stand-in, as `<binary> -F --config-file=<path>` runs clamd. */
const BINARY = path.join(work, "clamd");
fs.writeFileSync(BINARY, `#!/bin/sh\nexec "${process.execPath}" "${HELPER}" "$@"\n`, { mode: 0o755 });
const DB_DIR = path.join(work, "db");
fs.mkdirSync(DB_DIR);
// A daily database header as ClamAV writes it, built a day ago: what the health check reads while clamd is stopped.
const BUILT = Math.floor((Date.now() - 24 * 3_600_000) / 1000);
fs.writeFileSync(path.join(DB_DIR, "daily.cvd"), Buffer.concat([Buffer.from(`ClamAV-VDB:26 Oct 2026 06-27 +0000:28165:355788:90:md5:dsig:builder:${BUILT}`), Buffer.alloc(400, 0x20)]));

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const p = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return p;
}

let seq = 0;
/** A clamd.conf for the stand-in, with `#fake` lines for how it should behave. */
function conf(port: number, fake: string[] = [], file = path.join(work, `clamd-${++seq}.conf`)): string {
  fs.writeFileSync(file, [`DatabaseDirectory ${DB_DIR}`, `TCPSocket ${port}`, "TCPAddr 127.0.0.1", ...fake.map((f) => `#fake ${f}`), ""].join("\n"));
  return file;
}

/** The pids the stand-in wrote as it started, in order. */
const startsIn = (file: string): number[] => (fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(Number) : []);
/** Gone, and not a zombie either: nothing left in /proc. */
const reaped = (pid: number) => !fs.existsSync(`/proc/${pid}`);

async function until(check: () => boolean | Promise<boolean>, ms = 10_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("timed out waiting");
}

let clock = Date.now();
const managers: OnDemandClamd[] = [];
function manager(o: Partial<OnDemandOptions> & { configFile: string; port: number }): OnDemandClamd {
  const m = new OnDemandClamd({
    binary: BINARY,
    host: "127.0.0.1",
    lockDir: path.join(work, `lock-${++seq}`),
    idleMs: 60_000,
    startTimeoutMs: 8_000,
    killGraceMs: 1_000,
    minAvailableMiB: 1200,
    memAvailableMiB: () => 4000,
    freshclamRunning: () => null,
    now: () => clock,
    ...onDemandHooks(),
    log: () => undefined,
    ...o,
  });
  managers.push(m);
  return m;
}

let venueId: number;
let n = 0;
async function applyWithPdf() {
  const made = await registerUser({ name: `OnDemand ${++n}`, email: `ondemand${n}@clamd.test`, phone: `0179${String(n).padStart(6, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  await getDb().prepare("UPDATE users SET phone_verified_at = datetime('now') WHERE id = ?").run(made.user.id);
  const applied = await apply(
    made.user,
    { venueId, sport: "kayak", declaration: true, adult: true, certReference: "PADI 12345, PADI", certExpiresOn: addDays(todayISO(), 300) },
    [uploaded(Buffer.from(PDF), "card.pdf", "application/pdf")]
  );
  if (!applied.ok) throw new Error(`${applied.code}: ${applied.error}`);
  return { user: made.user, id: applied.request.documents[0].id };
}

const docStatus = async (id: number) =>
  (await getDb().prepare("SELECT scan_status, scan_error, scan_attempts FROM approval_documents WHERE id = ?").get(id)) as { scan_status: string; scan_error: string | null; scan_attempts: number };
const alertRow = async () =>
  (await getDb().prepare("SELECT count, last_detail FROM system_alerts WHERE key = 'document-scanner-ondemand'").get()) as { count: number; last_detail: string } | undefined;

/** Point the app's scanner at the stand-in's port, and the on-demand scanner at this manager. */
function use(m: OnDemandClamd) {
  setDocumentScanner(new ClamdScanner("127.0.0.1", m.port, 5_000));
  setOnDemandScanner(m);
}

beforeAll(async () => {
  vi.spyOn(console, "error").mockImplementation(() => undefined);
  vi.spyOn(console, "info").mockImplementation(() => undefined);
  vi.spyOn(console, "warn").mockImplementation(() => undefined);
  const v = await createVenue({ name: "On Demand Pool", area: "Puchong", address: "x", phone: "0312349502", openMin: 7 * 60, closeMin: 23 * 60 });
  if (!v.ok) throw new Error("venue");
  venueId = v.venue.id;
  const r = await createResources({ venueId, sport: "kayak", name: "Dive pool", offPeakRate: 30, peakRate: 30, capacity: 10 });
  if (!r.ok) throw new Error(r.error);
  const saved = await saveRequirement(venueId, {
    sport: "kayak",
    kind: "certification",
    documentLabel: "Your diving certification card",
    documentPurpose: "Diving here needs proof of an open-water certification.",
    declaration: "The certification I send is my own and in force.",
    validDays: 365,
  });
  if (!saved.ok) throw new Error(saved.error);
});

afterEach(async () => {
  for (const m of managers.splice(0)) {
    await m.whenReady();
    await m.stop();
    m.stopNow();
  }
  setOnDemandScanner(null);
  setDocumentScanner(null);
  // Nothing from one test waits for the next.
  await getDb().prepare("UPDATE approval_documents SET scan_status = 'failed', scan_failure = 'unscannable', scanned_at = now(), scan_next_at = NULL WHERE scan_status = 'pending'").run();
  await getDb().prepare("UPDATE approval_documents SET scan_failure = 'unscannable' WHERE scan_failure = 'scanner_unavailable'").run();
  await getDb().prepare("DELETE FROM system_alerts").run();
  clock = Date.now();
});

afterAll(() => {
  fs.rmSync(work, { recursive: true, force: true });
});

describe("the guards: documents wait, nothing is released", () => {
  it("too little free memory: clamd is not started, the document waits in quarantine, and the owners are told after a bounded time", async () => {
    const port = await freePort();
    const starts = path.join(work, `starts-${++seq}`);
    let free = 800;
    const m = manager({ configFile: conf(port, [`starts ${starts}`]), port, memAvailableMiB: () => free });
    use(m);
    const { user, id } = await applyWithPdf();
    // The upload's own try found no scanner: pending, never clean.
    expect(await docStatus(id)).toMatchObject({ scan_status: "pending" });
    expect((await docStatus(id)).scan_error).toMatch(/^unavailable/);
    expect(await documentsNeedingScanner()).toBe(1);

    expect(await tickOnDemandScanner()).toBe("blocked_memory");
    expect(startsIn(starts)).toEqual([]);
    expect(m.state().blocked).toMatchObject({ reason: "memory" });
    expect(m.state().blocked!.detail).toMatch(/800 MiB available, below the 1200 MiB/);
    expect(fs.existsSync(path.join(m.lockDir, "clamd-ondemand.lock"))).toBe(false);
    expect(await openDocument(id, { kind: "customer", userId: user.id, name: user.name })).toEqual({ withheld: "pending" });
    expect(await alertRow()).toBeUndefined();

    // Still held back half an hour later: the owners are told, once; still nothing released.
    clock += 31 * 60_000;
    expect(await tickOnDemandScanner()).toBe("blocked_memory");
    await m.saved();
    await until(async () => (await alertRow()) !== undefined);
    expect((await alertRow())!.last_detail).toMatch(/not started: 800 MiB available.*stay in quarantine/);
    expect((await scannerHealth(clock)).problems).toContain("ondemand_blocked");
    expect((await docStatus(id)).scan_status).toBe("pending");

    // Memory back: started, and the document scanned once it answers.
    free = 1500;
    expect(await tickOnDemandScanner()).toBe("started");
    expect(await m.whenReady()).toBe(true);
    expect((await docStatus(id)).scan_status).toBe("clean");
    expect(m.state().blocked).toBeNull();
  });

  it("freshclam running (its process, or the kit wrapper's lock file): clamd is not started beside it", async () => {
    const port = await freePort();
    let fresh: number | null = 4242;
    const m = manager({ configFile: conf(port), port, freshclamRunning: () => fresh });
    use(m);
    const { id } = await applyWithPdf();
    expect(await tickOnDemandScanner()).toBe("blocked_freshclam");
    expect(m.state().blocked).toMatchObject({ reason: "freshclam" });
    expect((await docStatus(id)).scan_status).toBe("pending");
    fresh = null;
    expect(await tickOnDemandScanner()).toBe("started");
    expect(await m.whenReady()).toBe(true);
    expect((await docStatus(id)).scan_status).toBe("clean");

    // How freshclam is recognised: the wrapper's lock file naming a live process, or a process named freshclam.
    const dir = path.join(work, `fresh-${++seq}`);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, "freshclam.lock"), `${process.pid}\n`);
    expect(freshclamRunning(dir)).toBe(process.pid);
    fs.rmSync(path.join(dir, "freshclam.lock"));
    const sleeper = path.join(dir, "freshclam");
    fs.copyFileSync("/bin/sleep", sleeper);
    fs.chmodSync(sleeper, 0o755);
    const named = spawn(sleeper, ["30"], { stdio: "ignore" });
    try {
      await until(() => freshclamRunning(dir) !== null);
      expect(processAlive(named.pid!)).toBe(true);
    } finally {
      named.kill("SIGKILL");
      await new Promise((r) => named.once("exit", r));
    }
  });
});

describe("starting and stopping clamd", () => {
  it("a start that hangs is killed (SIGKILL when SIGTERM is ignored), left no zombie, and is tried again after a pause", async () => {
    const port = await freePort();
    const starts = path.join(work, `starts-${++seq}`);
    const file = conf(port, [`starts ${starts}`, "never-listen 1", "ignore-term 1"]);
    const m = manager({ configFile: file, port, startTimeoutMs: 1_500, killGraceMs: 500 });
    use(m);
    const { id } = await applyWithPdf();
    expect(await tickOnDemandScanner()).toBe("started");
    expect(await tickOnDemandScanner()).toBe("starting");
    expect(await m.whenReady()).toBe(false);
    const [pid] = startsIn(starts);
    expect(pid).toBeGreaterThan(0);
    expect(reaped(pid)).toBe(true);
    expect(m.state()).toMatchObject({ phase: "stopped", pid: null, lastStopReason: "start_timeout", consecutiveFailures: 1 });
    expect(m.state().lastFailure).toMatch(/did not answer within 2 s and was stopped/);
    expect(fs.existsSync(path.join(m.lockDir, "clamd-ondemand.lock"))).toBe(false);
    await until(async () => (await alertRow()) !== undefined);
    expect((await docStatus(id)).scan_status).toBe("pending");
    await m.saved();
    expect((await scannerHealth(clock)).problems).toContain("ondemand_failed");

    // Not again at once: after a pause.
    expect(await tickOnDemandScanner()).toBe("backing_off");
    clock += 2 * 60_000;
    conf(port, [`starts ${starts}`], file);
    expect(await tickOnDemandScanner()).toBe("started");
    expect(await m.whenReady()).toBe(true);
    expect((await docStatus(id)).scan_status).toBe("clean");
    expect(m.state()).toMatchObject({ phase: "running", consecutiveFailures: 0 });
    expect(startsIn(starts)).toHaveLength(2);
  });

  it("a clamd that exits before answering is a failed start, with its last words", async () => {
    const port = await freePort();
    const m = manager({ configFile: conf(port, ["exit-at-start 2"]), port });
    expect(await m.tick(1)).toBe("started");
    expect(await m.whenReady()).toBe(false);
    expect(m.state()).toMatchObject({ phase: "stopped", lastStopReason: "start_failed", consecutiveFailures: 1 });
    expect(m.state().lastFailure).toMatch(/exited \(code 2\) before it answered; its last words: .*Can't open database/);

    const missing = manager({ configFile: conf(port), port, binary: path.join(work, "no-such-clamd") });
    expect(await missing.tick(1)).toBe("started");
    expect(await missing.whenReady()).toBe(false);
    expect(missing.state().lastFailure).toMatch(/could not be started .*ENOENT/);
  });

  it("a crash mid-scan leaves the document pending (no answer is never clean); the crash is recorded and it is scanned after the restart", async () => {
    const port = await freePort();
    const marker = path.join(work, `crashed-${++seq}`);
    const m = manager({ configFile: conf(port, [`crash-on-scan ${marker}`]), port });
    use(m);
    const { user, id } = await applyWithPdf();
    const before = (await docStatus(id)).scan_attempts;
    expect(await tickOnDemandScanner()).toBe("started");
    expect(await m.whenReady()).toBe(true);
    await until(() => m.state().lastStopReason === "crashed");
    const row = await docStatus(id);
    expect(row.scan_status).toBe("pending");
    expect(row.scan_attempts).toBe(before + 1);
    expect(row.scan_error).toMatch(/^unavailable/);
    expect(await openDocument(id, { kind: "customer", userId: user.id, name: user.name })).toEqual({ withheld: "pending" });
    expect(m.state()).toMatchObject({ phase: "stopped", consecutiveFailures: 1 });
    expect(m.state().lastFailure).toMatch(/stopped by itself \(code 70\).*crash mid-scan/);
    await until(async () => (await alertRow()) !== undefined);

    expect(await tickOnDemandScanner()).toBe("backing_off");
    clock += 2 * 60_000;
    expect(await tickOnDemandScanner()).toBe("started");
    expect(await m.whenReady()).toBe(true);
    expect((await docStatus(id)).scan_status).toBe("clean");
  });

  it("stops after the idle period with nothing waiting, leaving no zombie; records the load time and peak memory; health tells stopped from down", async () => {
    const port = await freePort();
    const starts = path.join(work, `starts-${++seq}`);
    const m = manager({ configFile: conf(port, [`starts ${starts}`, "delay 300", "ballast 64"]), port });
    use(m);
    const { id } = await applyWithPdf();
    expect(await tickOnDemandScanner()).toBe("started");
    expect(await m.whenReady()).toBe(true);
    expect((await docStatus(id)).scan_status).toBe("clean");
    const [pid] = startsIn(starts);
    expect(processAlive(pid)).toBe(true);
    expect(m.state().lastLoadMs).toBeGreaterThanOrEqual(300);

    // Nothing waiting, but not idle long enough yet.
    clock += 30_000;
    expect(await tickOnDemandScanner()).toBe("running");
    clock += 31_000;
    expect(await tickOnDemandScanner()).toBe("stopped_idle");
    await m.whenStopped();
    expect(reaped(pid)).toBe(true);
    expect(m.state()).toMatchObject({ phase: "stopped", pid: null, lastStopReason: "idle", consecutiveFailures: 0 });
    expect(m.state().peakRssMiB).toBeGreaterThanOrEqual(64);
    expect(fs.existsSync(path.join(m.lockDir, "clamd-ondemand.lock"))).toBe(false);
    expect(await tickOnDemandScanner()).toBe("nothing_waiting");

    // Stopped on purpose is not "does not answer"; the signatures' age is read from the database on disk.
    await m.saved();
    const health = await scannerHealth(clock);
    expect(health.mode).toBe("scanner");
    expect(health.reachable).toBeNull();
    expect(health.problems).not.toContain("unreachable");
    expect(health.problems).not.toContain("ondemand_failed");
    expect(health.signaturesAt).toBe(new Date(BUILT * 1000).toISOString());
    expect(health.onDemand).toMatchObject({ error: null, idleMinutes: 1, signaturesVersion: 28165, state: { phase: "stopped", lastStopReason: "idle" } });
    // Kept for the owner's panel, wherever it is read.
    const kept = (await getDb().prepare("SELECT value FROM settings WHERE key = 'clamd_ondemand'").get()) as { value: string };
    expect(JSON.parse(kept.value)).toMatchObject({ phase: "stopped", lastStopReason: "idle", peakRssMiB: m.state().peakRssMiB });
  });

  it("starts one clamd however many ticks come at once, in this process or from another, and takes over from an app process that is gone", async () => {
    const port = await freePort();
    const starts = path.join(work, `starts-${++seq}`);
    const file = conf(port, [`starts ${starts}`, "delay 400"]);
    const lockDir = path.join(work, `shared-lock-${++seq}`);
    const a = manager({ configFile: file, port, lockDir });
    const b = manager({ configFile: file, port, lockDir });
    const outcomes = await Promise.all([a.tick(1), a.tick(1), b.tick(1), a.tick(1), b.tick(1)]);
    expect(outcomes.filter((o) => o === "started")).toHaveLength(1);
    for (const o of outcomes) expect(["started", "starting", "blocked_lock"]).toContain(o);
    expect(outcomes).toContain("blocked_lock");
    const [winner, loser] = a.state().phase === "stopped" ? [b, a] : [a, b];
    expect(await winner.whenReady()).toBe(true);
    expect(await loser.whenReady()).toBe(false);
    // Once it answers, nobody else starts one either.
    expect(await loser.tick(1)).toBe("answering_already");
    expect(startsIn(starts)).toHaveLength(1);
    await winner.stop();
    expect(startsIn(starts)).toHaveLength(1);

    // Another app process (alive) holds the lock: this one does not start a second clamd.
    const other = spawn("/bin/sleep", ["30"], { stdio: "ignore" });
    const boot = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    fs.writeFileSync(path.join(lockDir, "clamd-ondemand.lock"), `app=${other.pid}\nclamd=0\nboot=${boot}\nconf=${file}\n`);
    try {
      const c = manager({ configFile: file, port, lockDir });
      expect(await c.tick(1)).toBe("blocked_lock");
      expect(c.state().blocked!.detail).toMatch(new RegExp(`another process \\(pid ${other.pid}\\)`));
    } finally {
      other.kill("SIGKILL");
      await new Promise((r) => other.once("exit", r));
    }

    // That process died and left its clamd running: the clamd (its exact pid, recognised by its config file) is stopped and the lock taken over.
    const orphan = spawn(BINARY, ["-F", `--config-file=${file}`], { stdio: "ignore", detached: true });
    orphan.unref();
    await until(() => startsIn(starts).length === 2);
    const orphanPid = startsIn(starts)[1];
    fs.writeFileSync(path.join(lockDir, "clamd-ondemand.lock"), `app=${other.pid}\nclamd=${orphanPid}\nboot=${boot}\nconf=${file}\n`);
    const d = manager({ configFile: file, port, lockDir });
    expect(await d.tick(0)).toBe("nothing_waiting");
    await until(() => !processAlive(orphanPid));
    expect(fs.existsSync(path.join(lockDir, "clamd-ondemand.lock"))).toBe(false);
    expect(await d.tick(1)).toBe("started");
    expect(await d.whenReady()).toBe(true);
    expect(startsIn(starts)).toHaveLength(3);
  });

  it("the app shutting down stops the clamd it started, whether or not something else handles the signal", async () => {
    for (const mode of ["plain", "next"] as const) {
      const port = await freePort();
      const starts = path.join(work, `starts-${++seq}`);
      const file = conf(port, [`starts ${starts}`]);
      const lockDir = path.join(work, `lock-${++seq}`);
      const script = path.join(work, `app-${seq}.mts`);
      fs.writeFileSync(
        script,
        [
          `import { OnDemandClamd } from ${JSON.stringify(MODULE)};`,
          // Next's own handler, which closes the server and exits.
          mode === "next" ? `process.on("SIGTERM", () => setTimeout(() => process.exit(0), 50));` : "",
          `const m = new OnDemandClamd({ binary: ${JSON.stringify(BINARY)}, configFile: ${JSON.stringify(file)}, host: "127.0.0.1", port: ${port}, lockDir: ${JSON.stringify(lockDir)}, memAvailableMiB: () => 4000, freshclamRunning: () => null });`,
          "await m.tick(1);",
          "const ok = await m.whenReady();",
          "console.log(JSON.stringify({ ok, pid: m.state().pid }));",
          "setInterval(() => undefined, 1000);",
        ].join("\n")
      );
      const app: ChildProcess = spawn(process.execPath, ["--experimental-strip-types", "--no-warnings", script], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      let err = "";
      app.stdout!.on("data", (d) => (out += d));
      app.stderr!.on("data", (d) => (err += d));
      await until(() => out.includes("\n"), 20_000).catch(() => {
        throw new Error(`the app process did not start clamd: ${err}`);
      });
      const said = JSON.parse(out.trim()) as { ok: boolean; pid: number };
      expect(said.ok).toBe(true);
      const clamd = startsIn(starts)[0];
      expect(processAlive(clamd)).toBe(true);
      expect(fs.existsSync(path.join(lockDir, "clamd-ondemand.lock"))).toBe(true);
      const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => app.once("exit", (code, signal) => r({ code, signal })));
      app.kill("SIGTERM");
      const how = await exited;
      expect(mode === "next" ? how.code : how.signal).toBe(mode === "next" ? 0 : "SIGTERM");
      await until(() => !processAlive(clamd), 5_000);
      expect(fs.existsSync(path.join(lockDir, "clamd-ondemand.lock"))).toBe(false);
    }
  });
});

describe("the kit's freshclam wrapper and the app take turns", () => {
  const WRAPPER = fileURLToPath(new URL("../deploy/digitalocean/freshclam.sh", import.meta.url));
  const boot = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();

  /** A stand-in freshclam on the PATH: it notes that it ran, and whether the wrapper's mark was there meanwhile. */
  function fakeFreshclam(dir: string, lockDir: string, seconds = 0) {
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin, { recursive: true });
    fs.writeFileSync(
      path.join(bin, "freshclam"),
      `#!/bin/sh\necho "ran $*" >> "${dir}/ran"\n[ -f "${lockDir}/freshclam.lock" ] && echo marked >> "${dir}/ran"\nsleep ${seconds}\n`,
      { mode: 0o755 }
    );
    return bin;
  }

  function wrapper(lockDir: string, bin: string, waitSeconds: number) {
    const run = spawn("bash", [WRAPPER, lockDir, String(waitSeconds)], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    let stderr = "";
    run.stderr.on("data", (d) => (stderr += d));
    const done = new Promise<{ code: number | null; stderr: string }>((r) => run.once("exit", (code) => r({ code, stderr })));
    return { run, done };
  }

  it("runs freshclam when no clamd is up, marking that it runs, and removes the mark after", async () => {
    const dir = path.join(work, `wrap-${++seq}`);
    const lockDir = path.join(dir, "scanner");
    const bin = fakeFreshclam(dir, lockDir);
    const { done } = wrapper(lockDir, bin, 5);
    expect((await done).code).toBe(0);
    expect(fs.readFileSync(path.join(dir, "ran"), "utf8")).toBe("ran --stdout\nmarked\n");
    expect(fs.existsSync(path.join(lockDir, "freshclam.lock"))).toBe(false);

    // A clamd lock left by an app process that is gone does not hold it back.
    const gone = spawn("/bin/true");
    await new Promise((r) => gone.once("exit", r));
    fs.writeFileSync(path.join(lockDir, "clamd-ondemand.lock"), `app=${gone.pid}\nclamd=0\nboot=${boot}\n`);
    expect((await wrapper(lockDir, bin, 5).done).code).toBe(0);
    expect(fs.readFileSync(path.join(dir, "ran"), "utf8").match(/ran/g)).toHaveLength(2);
  });

  it("does not run freshclam while the app's clamd lock is held: it waits, then skips this update", async () => {
    const dir = path.join(work, `wrap-${++seq}`);
    const lockDir = path.join(dir, "scanner");
    fs.mkdirSync(lockDir, { recursive: true });
    const bin = fakeFreshclam(dir, lockDir);
    fs.writeFileSync(path.join(lockDir, "clamd-ondemand.lock"), `app=${process.pid}\nclamd=0\nboot=${boot}\n`);
    const { code, stderr } = await wrapper(lockDir, bin, 1).done;
    expect(code).toBe(0);
    expect(stderr).toMatch(/skipped until the next run/);
    expect(fs.existsSync(path.join(dir, "ran"))).toBe(false);
    expect(fs.existsSync(path.join(lockDir, "freshclam.lock"))).toBe(false);
  });

  it("while freshclam runs, the app does not start clamd; once it is done, it does", async () => {
    const dir = path.join(work, `wrap-${++seq}`);
    const lockDir = path.join(dir, "scanner");
    const bin = fakeFreshclam(dir, lockDir, 3);
    const port = await freePort();
    // The real detection: the wrapper's mark and any process named freshclam.
    const m = manager({ configFile: conf(port), port, lockDir, freshclamRunning: undefined });
    const { done } = wrapper(lockDir, bin, 5);
    await until(() => fs.existsSync(path.join(dir, "ran")));
    expect(await m.tick(1)).toBe("blocked_freshclam");
    expect(fs.existsSync(path.join(lockDir, "clamd-ondemand.lock"))).toBe(false);
    expect((await done).code).toBe(0);
    // Another freshclam elsewhere on this machine would rightly hold it back too.
    await until(async () => (await m.tick(1)) !== "blocked_freshclam", 20_000);
    expect(await m.whenReady()).toBe(true);
  });
});

describe("configuration", () => {
  it("reads where clamd listens from its clamd.conf (the loopback only) and its signatures' date from disk", () => {
    expect(readClamdConf(conf(3310))).toEqual({ host: "127.0.0.1", port: 3310, databaseDirectory: DB_DIR });
    const wide = path.join(work, "wide.conf");
    fs.writeFileSync(wide, "TCPSocket 3310\nTCPAddr 0.0.0.0\n");
    expect(readClamdConf(wide)).toEqual({ error: expect.stringMatching(/loopback only/) });
    fs.writeFileSync(wide, "TCPSocket 3310\n");
    expect(readClamdConf(wide)).toEqual({ error: expect.stringMatching(/no TCPAddr/) });
    fs.writeFileSync(wide, "LocalSocket /run/clamav/clamd.ctl\n");
    expect(readClamdConf(wide)).toEqual({ error: expect.stringMatching(/no TCPSocket/) });
    expect(readClamdConf(path.join(work, "missing.conf"))).toEqual({ error: expect.stringMatching(/cannot read/) });
    expect(signaturesOnDisk(DB_DIR)).toEqual({ version: 28165, builtAt: new Date(BUILT * 1000).toISOString() });
    expect(signaturesOnDisk(path.join(work, "nothing-here"))).toBeNull();
  });

  it("takes the scanner's address from the on-demand clamd.conf when MYSENAM_CLAMD is unset, and refuses a config it cannot use", () => {
    const saved = { clamd: process.env.MYSENAM_CLAMD, ondemand: process.env.MYSENAM_CLAMD_ONDEMAND };
    try {
      delete process.env.MYSENAM_CLAMD;
      process.env.MYSENAM_CLAMD_ONDEMAND = conf(34567);
      expect(clamdAddress()).toEqual({ host: "127.0.0.1", port: 34567 });
      process.env.MYSENAM_CLAMD = "127.0.0.1:3310";
      expect(clamdAddress()).toEqual({ host: "127.0.0.1", port: 3310 });
    } finally {
      if (saved.clamd === undefined) delete process.env.MYSENAM_CLAMD;
      else process.env.MYSENAM_CLAMD = saved.clamd;
      if (saved.ondemand === undefined) delete process.env.MYSENAM_CLAMD_ONDEMAND;
      else process.env.MYSENAM_CLAMD_ONDEMAND = saved.ondemand;
    }
    const file = conf(3311);
    expect(onDemandOptionsFromEnv({}, work)).toBeNull();
    expect(onDemandOptionsFromEnv({ MYSENAM_CLAMD_ONDEMAND: file, MYSENAM_CLAMD_BINARY: path.join(work, "nope") }, work)).toEqual({
      error: expect.stringMatching(/not installed/),
    });
    expect(
      onDemandOptionsFromEnv(
        { MYSENAM_CLAMD_ONDEMAND: file, MYSENAM_CLAMD_BINARY: BINARY, MYSENAM_CLAMD_IDLE_MINUTES: "10", MYSENAM_CLAMD_START_SECONDS: "300", MYSENAM_CLAMD_MIN_MEMORY_MB: "1000" },
        work
      )
    ).toMatchObject({ binary: BINARY, configFile: file, host: "127.0.0.1", port: 3311, lockDir: path.join(work, "scanner"), idleMs: 600_000, startTimeoutMs: 300_000, minAvailableMiB: 1000 });
    // Out of bounds: the defaults.
    expect(onDemandOptionsFromEnv({ MYSENAM_CLAMD_ONDEMAND: file, MYSENAM_CLAMD_BINARY: BINARY, MYSENAM_CLAMD_IDLE_MINUTES: "0" }, work)).toMatchObject({ idleMs: 300_000, startTimeoutMs: 120_000, minAvailableMiB: 1200 });
  });
});
