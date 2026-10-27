import { spawn, type ChildProcess } from "child_process";
import fs from "fs";
import net from "net";
import path from "path";

/**
 * clamd started on demand (ADR 0024, amended 27 October 2026): on a machine
 * too small to keep ClamAV's signatures in memory all day beside the app and
 * Postgres (the 2 GB Droplet), the app starts clamd itself when supporting
 * documents are waiting and no scanner answers, lets the existing quarantine
 * and retry pipeline scan them, and stops clamd after an idle period with
 * nothing waiting.
 *
 * Nothing here decides whether a document is released: that stays the scan's
 * alone (lib/document-scanning.ts). When clamd cannot be started (too little
 * memory, freshclam running, a start that hangs or crashes) documents simply
 * keep waiting in quarantine, and the owners are told.
 *
 * - **One clamd.** The scheduler's lease makes one app instance the
 *   scheduler; within a machine, a lock file (created exclusively, naming
 *   this process, the clamd it started and the boot) keeps a second process
 *   from starting another, and a start in progress is shared by concurrent
 *   ticks. A lock left by a process that is gone is taken over, and a clamd
 *   it left behind (recognised by its exact pid and its command line) stopped.
 * - **Memory guard.** Started only while `MemAvailable` is above a threshold
 *   and freshclam is not running (its process, or the lock file the kit's
 *   freshclam timer holds). freshclam's wrapper does the same the other way
 *   round, so the two are never resident together.
 * - **Bounded start.** clamd must answer PING within a time limit, or it is
 *   stopped (SIGTERM, then SIGKILL) and tried again later, after a growing
 *   pause; a clamd that exits on its own is recorded as a crash. Children are
 *   always waited for (no zombies), and stopped when the app shuts down.
 * - **Measured.** Each start records how long clamd took to answer and its
 *   peak resident memory (`VmHWM` in `/proc/<pid>/status`).
 *
 * This module uses Node's built-ins only, so it can run on its own (the
 * shutdown test starts it in a separate Node process); the database and the
 * owners' alerts reach it through the hooks it is given.
 */

// ------------------------------------------------------------ clamd.conf

export interface ClamdConf {
  host: string;
  port: number;
  databaseDirectory: string;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "localhost"]);

/**
 * The parts of a clamd.conf the app relies on: where clamd listens (TCP, on
 * the loopback only: clamd has no authentication) and where its signatures
 * are. An error, in words, when the file cannot be used.
 */
export function readClamdConf(file: string): ClamdConf | { error: string } {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { error: `cannot read ${file}` };
  }
  const values = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(\S+)\s+(.+)$/.exec(line);
    if (m) values.set(m[1], m[2].trim().replace(/^"(.*)"$/, "$1"));
  }
  const port = Number(values.get("TCPSocket"));
  if (!Number.isInteger(port) || port < 1 || port > 65535) return { error: `${file} sets no TCPSocket: the app reaches clamd over TCP on the loopback` };
  const host = values.get("TCPAddr");
  if (!host) return { error: `${file} sets no TCPAddr: clamd would listen on every interface; set TCPAddr 127.0.0.1` };
  if (!LOOPBACK.has(host)) return { error: `${file} has clamd listen on ${host}: on-demand clamd listens on the loopback only (TCPAddr 127.0.0.1)` };
  return { host: host === "localhost" ? "127.0.0.1" : host, port, databaseDirectory: values.get("DatabaseDirectory") ?? "/var/lib/clamav" };
}

/**
 * The daily signature database's version and build time, read from its
 * header on disk (`ClamAV-VDB:<date>:<version>:<sigs>:<flevel>:<md5>:<dsig>:<builder>:<stime>`),
 * so the signatures' age is known while clamd is stopped. Null when there is
 * none or it cannot be read.
 */
export function signaturesOnDisk(databaseDirectory: string): { version: number; builtAt: string } | null {
  let best: { version: number; builtAt: string } | null = null;
  for (const name of ["daily.cld", "daily.cvd"]) {
    let header: string;
    try {
      const fd = fs.openSync(path.join(databaseDirectory, name), "r");
      try {
        const buf = Buffer.alloc(512);
        const read = fs.readSync(fd, buf, 0, 512, 0);
        header = buf.subarray(0, read).toString("latin1");
      } finally {
        fs.closeSync(fd);
      }
    } catch {
      continue;
    }
    const parts = header.replace(/\0[\s\S]*$/, "").trim().split(":");
    if (parts[0] !== "ClamAV-VDB" || parts.length < 9) continue;
    const version = Number(parts[2]);
    const stime = Number(parts[8]);
    if (!Number.isInteger(version) || !Number.isFinite(stime) || stime <= 0) continue;
    if (!best || version > best.version) best = { version, builtAt: new Date(stime * 1000).toISOString() };
  }
  return best;
}

// ------------------------------------------------------------ the machine

/** `MemAvailable` from /proc/meminfo, in MiB; null where it cannot be read. */
export function memAvailableMiB(meminfo = "/proc/meminfo"): number | null {
  try {
    const m = /^MemAvailable:\s+(\d+)\s+kB/m.exec(fs.readFileSync(meminfo, "utf8"));
    return m ? Math.floor(Number(m[1]) / 1024) : null;
  } catch {
    return null;
  }
}

/** A process's peak resident memory (`VmHWM`), in MiB; null once it is gone. */
export function peakRssMiB(pid: number): number | null {
  try {
    const m = /^VmHWM:\s+(\d+)\s+kB/m.exec(fs.readFileSync(`/proc/${pid}/status`, "utf8"));
    return m ? Math.round(Number(m[1]) / 1024) : null;
  } catch {
    return null;
  }
}

/** Whether a process is running (not gone, not a zombie waiting to be collected). */
export function processAlive(pid: number): boolean {
  return alive(pid);
}

function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
  // A zombie is not running: it only waits to be collected.
  try {
    return !/^State:\s+Z/m.test(fs.readFileSync(`/proc/${pid}/status`, "utf8"));
  } catch {
    return true;
  }
}

function bootId(): string {
  try {
    return fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  } catch {
    return "";
  }
}

const FRESHCLAM_LOCK = "freshclam.lock";
const CLAMD_LOCK = "clamd-ondemand.lock";

/**
 * A freshclam that is running, by its pid: a process named `freshclam`, or
 * the lock file the kit's freshclam wrapper holds while it runs (a pid that
 * is still alive). Null when there is none.
 */
export function freshclamRunning(lockDir: string): number | null {
  try {
    const pid = Number(fs.readFileSync(path.join(lockDir, FRESHCLAM_LOCK), "utf8").trim().split(/\s+/)[0]);
    if (alive(pid)) return pid;
  } catch {
    // no wrapper running
  }
  let entries: string[];
  try {
    entries = fs.readdirSync("/proc");
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (fs.readFileSync(`/proc/${entry}/comm`, "utf8").trim() === "freshclam") return Number(entry);
    } catch {
      // gone meanwhile
    }
  }
  return null;
}

/** clamd's answer to PING, on its own short connection. */
export function pingClamd(host: string, port: number, timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let reply = "";
    const done = (ok: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(ok);
    };
    const timer = setTimeout(() => done(false), timeoutMs);
    socket.on("connect", () => socket.write("zPING\0"));
    socket.on("data", (d: Buffer) => {
      reply += d.toString("utf8");
      if (reply.includes("\0") || reply.length > 64) done(reply.replace(/\0/g, "").trim() === "PONG");
    });
    socket.on("end", () => done(reply.replace(/\0/g, "").trim() === "PONG"));
    socket.on("error", () => done(false));
  });
}

// ------------------------------------------------------------ the manager

export type StopReason = "idle" | "shutdown" | "crashed" | "start_timeout" | "start_failed";
export type BlockReason = "memory" | "freshclam" | "lock";

/** What the owners see of the on-demand scanner (and what is kept in `settings`). */
export interface OnDemandState {
  phase: "stopped" | "starting" | "running" | "stopping";
  pid: number | null;
  /** The last start: when clamd was launched, how long it took to answer PING, and its peak resident memory. */
  lastStartAt: string | null;
  lastLoadMs: number | null;
  peakRssMiB: number | null;
  lastStopAt: string | null;
  lastStopReason: StopReason | null;
  lastFailureAt: string | null;
  lastFailure: string | null;
  /** Failed starts and crashes since the last start that answered. */
  consecutiveFailures: number;
  /** No new start before this, after a failure. */
  nextStartAfter: string | null;
  /** Documents are waiting, but clamd was not started, since when and why. */
  blocked: { reason: BlockReason; since: string; detail: string } | null;
  /** Starts that answered, by this process. */
  starts: number;
}

export type TickOutcome =
  | "nothing_waiting"
  | "running"
  | "starting"
  | "started"
  | "stopped_idle"
  | "stopping"
  | "backing_off"
  | "blocked_memory"
  | "blocked_freshclam"
  | "blocked_lock"
  | "answering_already";

export interface OnDemandOptions {
  /** clamd's binary (`/usr/sbin/clamd`), started as `<binary> -F --config-file=<configFile>`. */
  binary: string;
  configFile: string;
  host: string;
  port: number;
  /** Where the lock file lives, beside the freshclam wrapper's. */
  lockDir: string;
  /** Stopped after this long with nothing waiting. */
  idleMs?: number;
  /** clamd must answer PING within this, or it is stopped and tried again later. */
  startTimeoutMs?: number;
  /** Started only while `MemAvailable` is above this. */
  minAvailableMiB?: number;
  /** The owners are told once documents have waited this long for a start that is held back. */
  blockedAlertMs?: number;
  /** Between SIGTERM and SIGKILL when stopping clamd. */
  killGraceMs?: number;
  memAvailableMiB?: () => number | null;
  freshclamRunning?: () => number | null;
  now?: () => number;
  /** Called with a copy of the state whenever it changes (the app keeps it in `settings`). */
  persist?: (state: OnDemandState) => Promise<void> | void;
  /** Tell the owners (the app raises an alert). */
  alert?: (kind: "start_failed" | "crashed" | "blocked", detail: string) => Promise<void> | void;
  /** Where clamd's own output goes, a line at a time (the last lines are also kept for a failure's detail). */
  log?: (line: string) => void;
}

/** Pauses after a failed start or a crash, by how many in a row: then every hour. */
export const START_BACKOFF_MINUTES = [1, 2, 5, 10, 30, 60];
export const DEFAULTS = {
  idleMinutes: 5,
  startSeconds: 120,
  minAvailableMiB: 1200,
  blockedAlertMinutes: 30,
  binary: "/usr/sbin/clamd",
};

const live = new Set<OnDemandClamd>();
let hooked = false;

/** On the app's way out, every clamd it started is told to stop, and its lock removed. */
function hookShutdown(): void {
  if (hooked) return;
  hooked = true;
  process.once("exit", () => {
    for (const m of live) m.stopNow();
  });
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    const handler = () => {
      for (const m of live) m.stopNow();
      // Nobody else handles it (Next does, and exits by itself): end the process as the signal would have.
      if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
    };
    process.once(signal, handler);
  }
}

export class OnDemandClamd {
  readonly binary: string;
  readonly configFile: string;
  readonly host: string;
  readonly port: number;
  readonly lockDir: string;
  readonly idleMs: number;
  readonly startTimeoutMs: number;
  readonly minAvailableMiB: number;
  readonly blockedAlertMs: number;
  private readonly killGraceMs: number;
  private readonly opts: OnDemandOptions;
  private child: ChildProcess | null = null;
  private exited: Promise<void> | null = null;
  private starting: Promise<boolean> | null = null;
  private stopping: Promise<void> | null = null;
  private lastWork = 0;
  private blockedAlerted = false;
  private tail: string[] = [];
  private saving: Promise<void> = Promise.resolve();
  private ticking: Promise<unknown> = Promise.resolve();
  private st: OnDemandState = {
    phase: "stopped",
    pid: null,
    lastStartAt: null,
    lastLoadMs: null,
    peakRssMiB: null,
    lastStopAt: null,
    lastStopReason: null,
    lastFailureAt: null,
    lastFailure: null,
    consecutiveFailures: 0,
    nextStartAfter: null,
    blocked: null,
    starts: 0,
  };

  constructor(opts: OnDemandOptions) {
    this.opts = opts;
    this.binary = opts.binary;
    this.configFile = opts.configFile;
    this.host = opts.host;
    this.port = opts.port;
    this.lockDir = opts.lockDir;
    this.idleMs = opts.idleMs ?? DEFAULTS.idleMinutes * 60_000;
    this.startTimeoutMs = opts.startTimeoutMs ?? DEFAULTS.startSeconds * 1000;
    this.minAvailableMiB = opts.minAvailableMiB ?? DEFAULTS.minAvailableMiB;
    this.blockedAlertMs = opts.blockedAlertMs ?? DEFAULTS.blockedAlertMinutes * 60_000;
    this.killGraceMs = opts.killGraceMs ?? 10_000;
  }

  private now(): number {
    return this.opts.now ? this.opts.now() : Date.now();
  }

  private iso(at = this.now()): string {
    return new Date(at).toISOString();
  }

  state(): OnDemandState {
    return { ...this.st, blocked: this.st.blocked && { ...this.st.blocked } };
  }

  /** Kept in order, one write after another; keeping the state is a convenience, never a reason to fail. */
  private save(): void {
    const copy = this.state();
    const persist = this.opts.persist;
    if (!persist) return;
    this.saving = this.saving.then(() => persist(copy)).catch(() => undefined);
  }

  /** Every state written so far has been kept. */
  saved(): Promise<void> {
    return this.saving;
  }

  private tell(kind: "start_failed" | "crashed" | "blocked", detail: string): void {
    try {
      void Promise.resolve(this.opts.alert?.(kind, detail)).catch(() => undefined);
    } catch {
      // as above
    }
  }

  /** A scan used the scanner: it is not idle. */
  noteUse(): void {
    this.lastWork = this.now();
  }

  /** The start in progress, if any: true once clamd answers. */
  whenReady(): Promise<boolean> {
    return this.starting ?? Promise.resolve(this.st.phase === "running");
  }

  /** The stop in progress, if any. */
  whenStopped(): Promise<void> {
    return this.stopping ?? Promise.resolve();
  }

  /**
   * Once a minute, from the scheduler: `waiting` documents need a scanner.
   * Starts clamd when some wait and none runs (and the guards allow it), and
   * stops it once nothing has waited for the idle period. Does not wait for a
   * start to finish: `afterReady` is called once clamd answers. Ticks that
   * overlap run one after the other.
   */
  tick(waiting: number, afterReady?: () => Promise<void>): Promise<TickOutcome> {
    const run = this.ticking.then(() => this.tickOnce(waiting, afterReady));
    this.ticking = run.catch(() => undefined);
    return run;
  }

  private async tickOnce(waiting: number, afterReady?: () => Promise<void>): Promise<TickOutcome> {
    const now = this.now();
    if (waiting > 0) this.lastWork = now;
    if (this.st.phase === "starting") return "starting";
    if (this.st.phase === "stopping") return "stopping";
    if (this.st.phase === "running") {
      this.sample();
      if (waiting === 0 && now - this.lastWork >= this.idleMs) {
        void this.stop("idle");
        return "stopped_idle";
      }
      return "running";
    }
    // A lock left by an app process that is gone: the clamd it left running stopped, so it neither holds memory nor answers for us.
    this.clearStaleLock();
    if (waiting === 0) {
      if (this.st.blocked) {
        this.st.blocked = null;
        this.blockedAlerted = false;
        this.save();
      }
      return "nothing_waiting";
    }
    if (this.st.nextStartAfter && now < Date.parse(this.st.nextStartAfter)) return "backing_off";
    // A clamd this manager did not start already answers there (an always-on one): nothing to start.
    if (await pingClamd(this.host, this.port, 1000)) return "answering_already";
    const held = this.guard();
    if (held) return held;
    this.start(afterReady);
    return "started";
  }

  /** The memory and freshclam guards, and the lock. A reason not to start, or null with the lock taken. */
  private guard(): TickOutcome | null {
    const lock = this.takeLock();
    if (lock !== true) return this.block("lock", lock);
    const fresh = (this.opts.freshclamRunning ?? (() => freshclamRunning(this.lockDir)))();
    if (fresh !== null) {
      this.dropLock();
      return this.block("freshclam", `freshclam is running (pid ${fresh}): clamd is not started beside it`);
    }
    const mem = (this.opts.memAvailableMiB ?? (() => memAvailableMiB()))();
    if (mem === null || mem < this.minAvailableMiB) {
      this.dropLock();
      return this.block(
        "memory",
        mem === null ? "the memory available cannot be read (/proc/meminfo)" : `${mem} MiB available, below the ${this.minAvailableMiB} MiB clamd is started with`
      );
    }
    return null;
  }

  private block(reason: BlockReason, detail: string): TickOutcome {
    const now = this.now();
    if (!this.st.blocked || this.st.blocked.reason !== reason) this.st.blocked = { reason, since: this.st.blocked?.since ?? this.iso(now), detail };
    else this.st.blocked.detail = detail;
    if (!this.blockedAlerted && now - Date.parse(this.st.blocked.since) >= this.blockedAlertMs) {
      this.blockedAlerted = true;
      this.tell("blocked", `Supporting documents have waited ${Math.round((now - Date.parse(this.st.blocked.since)) / 60_000)} minutes for the on-demand malware scanner, which was not started: ${detail}. They stay in quarantine, unopened.`);
    }
    this.save();
    return reason === "memory" ? "blocked_memory" : reason === "freshclam" ? "blocked_freshclam" : "blocked_lock";
  }

  // -------------------------------------------------------------- the lock

  private lockPath(): string {
    return path.join(this.lockDir, CLAMD_LOCK);
  }

  private writeLock(flag: "wx" | "w"): void {
    fs.writeFileSync(this.lockPath(), `app=${process.pid}\nclamd=${this.child?.pid ?? 0}\nboot=${bootId()}\nconf=${this.configFile}\n`, { flag, mode: 0o640 });
  }

  /** True with the lock taken; otherwise why not. A lock left by a process that is gone is taken over. */
  private takeLock(): true | string {
    try {
      fs.mkdirSync(this.lockDir, { recursive: true, mode: 0o750 });
    } catch {
      // reported by the write below
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        this.writeLock("wx");
        return true;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") return `the lock file cannot be written in ${this.lockDir} (${(err as NodeJS.ErrnoException).code ?? "error"})`;
      }
      const held = this.readLock();
      if (held && held.app !== process.pid && held.boot === bootId() && alive(held.app)) return `another process (pid ${held.app}) runs the on-demand scanner`;
      if (held && held.app === process.pid && held.boot === bootId()) return "another start in this process holds the lock";
      this.clearStaleLock();
    }
    return "the lock is being taken over by another process";
  }

  /** A lock whose app process is gone (or from a previous boot): the clamd it names stopped, if it is still that clamd, and the lock removed. */
  private clearStaleLock(): void {
    const held = this.readLock();
    if (!held) return;
    const sameBoot = held.boot === bootId();
    if (sameBoot && (held.app === process.pid || alive(held.app))) return;
    if (sameBoot && held.clamd > 0) this.killOrphan(held.clamd);
    try {
      fs.unlinkSync(this.lockPath());
    } catch {
      // somebody else cleared it first
    }
  }

  private readLock(): { app: number; clamd: number; boot: string } | null {
    try {
      const text = fs.readFileSync(this.lockPath(), "utf8");
      const get = (k: string) => new RegExp(`^${k}=(.*)$`, "m").exec(text)?.[1]?.trim() ?? "";
      return { app: Number(get("app")) || 0, clamd: Number(get("clamd")) || 0, boot: get("boot") };
    } catch {
      return null;
    }
  }

  /** A clamd a vanished app started: stopped only if that exact pid is still running with this config file. */
  private killOrphan(pid: number): void {
    try {
      const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
      if (!cmdline.includes(`--config-file=${this.configFile}`)) return;
      process.kill(pid, "SIGKILL");
      this.log(`stopped clamd ${pid}, left running by an app process that is gone`);
    } catch {
      // gone already
    }
  }

  private dropLock(): void {
    try {
      const held = this.readLock();
      if (!held || held.app === process.pid) fs.unlinkSync(this.lockPath());
    } catch {
      // gone already
    }
  }

  // -------------------------------------------------------------- start and stop

  private note(line: string): void {
    this.tail.push(line);
    if (this.tail.length > 20) this.tail.shift();
  }

  private log(line: string): void {
    this.opts.log?.(line);
  }

  private sample(): void {
    if (!this.child?.pid) return;
    const peak = peakRssMiB(this.child.pid);
    if (peak !== null && peak !== this.st.peakRssMiB) {
      this.st.peakRssMiB = peak;
      this.save();
    }
  }

  private start(afterReady?: () => Promise<void>): void {
    const launchedAt = Date.now();
    this.st.blocked = null;
    this.blockedAlerted = false;
    this.st.phase = "starting";
    this.st.lastStartAt = this.iso();
    this.st.lastLoadMs = null;
    this.st.peakRssMiB = null;
    this.tail = [];
    let child: ChildProcess;
    try {
      // None of the app's settings or secrets in its environment: clamd needs none of them.
      child = spawn(this.binary, ["-F", `--config-file=${this.configFile}`], {
        stdio: ["ignore", "pipe", "pipe"],
        env: { PATH: process.env.PATH ?? "/usr/sbin:/usr/bin:/sbin:/bin", NODE_ENV: process.env.NODE_ENV },
      });
    } catch (err) {
      this.failed("start_failed", `clamd could not be started: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    this.child = child;
    let spawnError: string | null = null;
    let exitedEarly: string | null = null;
    this.exited = new Promise<void>((resolve) => {
      child.once("error", (err: NodeJS.ErrnoException) => {
        spawnError = err.code ?? err.message;
        resolve();
      });
      child.once("exit", (code, signal) => {
        exitedEarly = signal ? `signal ${signal}` : `code ${code}`;
        resolve();
      });
    });
    for (const stream of [child.stdout, child.stderr]) {
      let rest = "";
      stream?.on("data", (d: Buffer) => {
        const lines = (rest + d.toString("utf8")).split("\n");
        rest = lines.pop() ?? "";
        // clamd's own words are kept for a failure's detail, not logged: it says a lot at every start.
        for (const l of lines) if (l.trim()) this.note(l.trim().slice(0, 300));
      });
    }
    live.add(this);
    hookShutdown();
    try {
      if (child.pid) this.writeLock("w");
    } catch {
      // the lock still names this process; the clamd pid is only for clearing up after a crash
    }
    this.st.pid = child.pid ?? null;
    this.save();
    this.log(`starting clamd (pid ${child.pid ?? "?"})`);

    this.starting = (async () => {
      const until = launchedAt + this.startTimeoutMs;
      let ready = false;
      while (Date.now() < until && !spawnError && !exitedEarly) {
        if (await pingClamd(this.host, this.port, Math.min(2000, Math.max(200, until - Date.now())))) {
          // Only this clamd's answer counts: one that has already exited did not give it.
          ready = !spawnError && !exitedEarly;
          break;
        }
        await new Promise((r) => setTimeout(r, 250));
      }
      if (!ready) {
        if (spawnError) this.failed("start_failed", `clamd could not be started (${this.binary}): ${spawnError}`);
        else if (exitedEarly) this.failed("start_failed", `clamd exited (${exitedEarly}) before it answered${this.tailText()}`);
        else {
          await this.kill();
          this.failed("start_timeout", `clamd did not answer within ${Math.round(this.startTimeoutMs / 1000)} s and was stopped${this.tailText()}`);
        }
        return false;
      }
      this.st.phase = "running";
      this.st.lastLoadMs = Date.now() - launchedAt;
      this.st.consecutiveFailures = 0;
      this.st.nextStartAfter = null;
      this.st.starts += 1;
      this.lastWork = this.now();
      this.sample();
      this.save();
      this.log(`clamd answers after ${this.st.lastLoadMs} ms`);
      // From now on, clamd ending by itself is a crash.
      child.once("exit", (code, signal) => {
        if (this.child !== child || this.st.phase !== "running") return;
        this.failed("crashed", `clamd stopped by itself (${signal ? `signal ${signal}` : `code ${code}`})${this.tailText()}`);
      });
      if (afterReady) await afterReady().catch((err) => this.log(`scanning after the start failed: ${err instanceof Error ? err.message : String(err)}`));
      return true;
    })().finally(() => {
      this.starting = null;
    });
  }

  private tailText(): string {
    const last = this.tail.slice(-3);
    return last.length ? `; its last words: ${last.join(" | ")}` : "";
  }

  /** A start that failed, or a crash: clamd gone, the lock released, the next start after a pause, the owners told. */
  private failed(reason: "start_failed" | "start_timeout" | "crashed", detail: string): void {
    const now = this.now();
    const peak = this.child?.pid ? peakRssMiB(this.child.pid) : null;
    if (peak !== null) this.st.peakRssMiB = peak;
    this.child = null;
    live.delete(this);
    this.dropLock();
    this.st.phase = "stopped";
    this.st.pid = null;
    this.st.lastStopAt = this.iso(now);
    this.st.lastStopReason = reason;
    this.st.lastFailureAt = this.iso(now);
    this.st.lastFailure = detail.slice(0, 500);
    this.st.consecutiveFailures += 1;
    const pause = START_BACKOFF_MINUTES[Math.min(this.st.consecutiveFailures, START_BACKOFF_MINUTES.length) - 1];
    this.st.nextStartAfter = this.iso(now + pause * 60_000);
    this.save();
    this.log(detail);
    this.tell(reason === "crashed" ? "crashed" : "start_failed", `${detail}. Documents stay in quarantine, unopened; tried again after ${pause} minute(s).`);
  }

  /** SIGTERM, then SIGKILL after the grace period; resolves once the child has been waited for. */
  private async kill(): Promise<void> {
    const child = this.child;
    if (!child || !this.exited) return;
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    let timer: ReturnType<typeof setTimeout> | undefined;
    const graceful = await Promise.race([this.exited.then(() => true), new Promise<boolean>((r) => (timer = setTimeout(() => r(false), this.killGraceMs)))]);
    clearTimeout(timer);
    if (!graceful) {
      child.kill("SIGKILL");
      await this.exited;
    }
  }

  /** Stop clamd and wait for it: after the idle period, or when asked. */
  stop(reason: "idle" | "shutdown" = "shutdown"): Promise<void> {
    if (this.stopping) return this.stopping;
    if (!this.child || this.st.phase !== "running") return Promise.resolve();
    this.st.phase = "stopping";
    this.sample();
    this.save();
    this.stopping = (async () => {
      await this.kill();
      this.child = null;
      live.delete(this);
      this.dropLock();
      this.st.phase = "stopped";
      this.st.pid = null;
      this.st.lastStopAt = this.iso();
      this.st.lastStopReason = reason;
      this.save();
      this.log(`clamd stopped (${reason})`);
    })().finally(() => {
      this.stopping = null;
    });
    return this.stopping;
  }

  /** On the way out of the process: no waiting is possible, so clamd is told to stop and the lock removed. */
  stopNow(): void {
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    this.child = null;
    live.delete(this);
    this.dropLock();
    this.st.phase = "stopped";
    this.st.pid = null;
  }
}

// ------------------------------------------------------------ from the environment

/**
 * The on-demand scanner as the environment configures it: null when
 * `MYSENAM_CLAMD_ONDEMAND` is unset; an error, in words, when it cannot be
 * used. `dataDir` is the app's data folder: the lock file goes in its
 * `scanner/` folder, where the kit's freshclam wrapper looks for it.
 */
export function onDemandOptionsFromEnv(env: Record<string, string | undefined>, dataDir: string): Omit<OnDemandOptions, "persist" | "alert" | "log"> | { error: string } | null {
  const configFile = env.MYSENAM_CLAMD_ONDEMAND?.trim();
  if (!configFile) return null;
  const conf = readClamdConf(configFile);
  if ("error" in conf) return conf;
  const num = (value: string | undefined, fallback: number, min: number, max: number) => {
    const n = Number(value);
    return value?.trim() && Number.isFinite(n) && n >= min && n <= max ? n : fallback;
  };
  const binary = env.MYSENAM_CLAMD_BINARY?.trim() || DEFAULTS.binary;
  try {
    fs.accessSync(binary, fs.constants.X_OK);
  } catch {
    return { error: `clamd is not installed at ${binary} (MYSENAM_CLAMD_BINARY)` };
  }
  return {
    binary,
    configFile,
    host: conf.host,
    port: conf.port,
    lockDir: path.join(dataDir, "scanner"),
    idleMs: num(env.MYSENAM_CLAMD_IDLE_MINUTES, DEFAULTS.idleMinutes, 1, 1440) * 60_000,
    startTimeoutMs: num(env.MYSENAM_CLAMD_START_SECONDS, DEFAULTS.startSeconds, 10, 3600) * 1000,
    minAvailableMiB: num(env.MYSENAM_CLAMD_MIN_MEMORY_MB, DEFAULTS.minAvailableMiB, 0, 1_048_576),
  };
}
