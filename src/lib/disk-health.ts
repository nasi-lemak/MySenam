import fs from "node:fs";
import path from "node:path";
// Imported with its extension, and lightly: lib/backup.ts, which the backup and restore scripts run under plain Node, uses this.
import { dataDirectory } from "./db.ts";

/**
 * How full the disk is that holds the install's data, and what that does (operations/monitoring.md#disk-space).
 *
 * The Droplet holds Postgres, the backups and the uploaded documents, so a full disk is an outage, and the first
 * anybody hears of it is the database refusing writes. This reads the volume's own answer (`fs.statfs`; where the
 * platform cannot give one, the answer is "unknown", never a guess) and turns it into a state:
 *
 * - `ok` below the warning percentage, `warn`, `critical`, and `full` at or past the block percentage;
 * - the owners are told as the state worsens and the alert clears when usage falls (`checkDiskHealth`, from the
 *   scheduler's short unit, at most every 15 minutes);
 * - at `full` a backup is refused before it starts (it writes a copy of everything, which must not fill the disk
 *   further), and so is an off-site copy that would write an encrypted scratch copy. Bookings and payments are never
 *   blocked by it: the point is to keep the room that is left for them.
 *
 * The three percentages are MYSENAM_DISK_WARN_PERCENT (80), MYSENAM_DISK_CRITICAL_PERCENT (90) and
 * MYSENAM_DISK_BLOCK_PERCENT (95). Used percent is as `df` reports it: used / (used + what a normal process may still
 * use), so space reserved for root does not hide a full disk. Only the volume of the data directory is watched; a
 * database on another volume (a managed database, a separate Postgres disk) is that provider's to monitor.
 */

export type DiskState = "ok" | "warn" | "critical" | "full" | "unknown";

export const DEFAULT_THRESHOLDS = { warn: 80, critical: 90, block: 95 } as const;

type Env = Record<string, string | undefined>;

export interface DiskThresholds {
  warn: number;
  critical: number;
  block: number;
  /** False when the configuration was refused and the defaults are in force; `problem` says why. */
  valid: boolean;
  problem: string | null;
}

/** The three percentages in force. A set that is not numbers in (0, 100] in increasing order falls back to the defaults, whole, and says so. */
export function diskThresholds(env: Env = process.env): DiskThresholds {
  const names = [
    ["warn", "MYSENAM_DISK_WARN_PERCENT"],
    ["critical", "MYSENAM_DISK_CRITICAL_PERCENT"],
    ["block", "MYSENAM_DISK_BLOCK_PERCENT"],
  ] as const;
  const out: Record<"warn" | "critical" | "block", number> = { ...DEFAULT_THRESHOLDS };
  const problems: string[] = [];
  for (const [key, name] of names) {
    const raw = env[name]?.trim();
    if (!raw) continue;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0 || n > 100) problems.push(`${name} must be a number above 0 and at most 100 (it is "${raw.slice(0, 20)}")`);
    else out[key] = n;
  }
  if (problems.length === 0 && !(out.warn < out.critical && out.critical < out.block))
    problems.push(`the warning (${out.warn}), critical (${out.critical}) and block (${out.block}) percentages must increase in that order`);
  if (problems.length > 0)
    return { ...DEFAULT_THRESHOLDS, valid: false, problem: `${problems.join("; ")}. The defaults ${DEFAULT_THRESHOLDS.warn}/${DEFAULT_THRESHOLDS.critical}/${DEFAULT_THRESHOLDS.block} are in force.` };
  return { ...out, valid: true, problem: null };
}

export interface DiskReading {
  totalBytes: number;
  freeBytes: number;
  /** As `df` says it, to one decimal. */
  usedPercent: number;
}

/** What `fs.promises.statfs` answers; tests give their own. */
export type StatFn = (path: string) => Promise<{ bsize: number | bigint; blocks: number | bigint; bfree: number | bigint; bavail: number | bigint }>;

/**
 * The volume holding `dir`, or the nearest folder above it that exists (a backup folder is made when the first backup
 * is). null when the platform cannot say (no `statfs`, or it fails, or it reports a volume with no blocks).
 */
export async function readDisk(dir: string = dataDirectory(), statfs: StatFn = (p) => fs.promises.statfs(p)): Promise<DiskReading | null> {
  let at = path.resolve(dir);
  for (let hops = 0; hops < 64; hops++) {
    try {
      const s = await statfs(at);
      const size = Number(s.bsize);
      const blocks = Number(s.blocks);
      const free = Number(s.bavail);
      const used = blocks - Number(s.bfree);
      if (!(blocks > 0) || !(size > 0) || used < 0 || used + free <= 0) return null;
      return { totalBytes: blocks * size, freeBytes: free * size, usedPercent: Math.round((used / (used + free)) * 1000) / 10 };
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") return null;
      const parent = path.dirname(at);
      if (parent === at) return null;
      at = parent;
    }
  }
  return null;
}

export function stateOf(usedPercent: number | null, t: Pick<DiskThresholds, "warn" | "critical" | "block">): DiskState {
  if (usedPercent === null) return "unknown";
  if (usedPercent >= t.block) return "full";
  if (usedPercent >= t.critical) return "critical";
  if (usedPercent >= t.warn) return "warn";
  return "ok";
}

export interface DiskHealth {
  state: DiskState;
  usedPercent: number | null;
  freeBytes: number | null;
  totalBytes: number | null;
  thresholds: { warn: number; critical: number; block: number; valid: boolean; problem: string | null };
}

/** For the owner's system answer (`GET /api/admin/system`, `disk`). Reads nothing but the volume's own counters. */
export async function diskHealth(env: Env = process.env, statfs?: StatFn): Promise<DiskHealth> {
  const thresholds = diskThresholds(env);
  const reading = await readDisk(dataDirectory(), statfs);
  return {
    state: stateOf(reading?.usedPercent ?? null, thresholds),
    usedPercent: reading?.usedPercent ?? null,
    freeBytes: reading?.freeBytes ?? null,
    totalBytes: reading?.totalBytes ?? null,
    thresholds,
  };
}

const gigabytes = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);

/**
 * Is there too little room to start writing a copy of the data into `dir` (the volume at or past the block percentage)?
 * null when there is room, and also when the platform cannot say: not knowing is not a reason to stop a backup.
 * Nothing about the path is in the answer beyond the volume's numbers.
 */
export async function diskRefusal(dir: string, env: Env = process.env, statfs?: StatFn): Promise<{ usedPercent: number; freeBytes: number; block: number; message: string } | null> {
  const { block } = diskThresholds(env);
  const reading = await readDisk(dir, statfs);
  if (!reading || reading.usedPercent < block) return null;
  return {
    usedPercent: reading.usedPercent,
    freeBytes: reading.freeBytes,
    block,
    message: `Not started: the disk it would write to is ${reading.usedPercent}% used (${gigabytes(reading.freeBytes)} GB free), at or past the ${block}% limit (MYSENAM_DISK_BLOCK_PERCENT). Free some space and it is tried again.`,
  };
}

const STATE_ALERTS = { warn: "disk:warn", critical: "disk:critical", full: "disk:full" } as const;
const ALERT_KEYS = Object.values(STATE_ALERTS);

/** The interval between looks. */
export const DISK_CHECK_MINUTES = 15;
let lastChecked = 0;
let lastProblemSaid: string | null = null;

/**
 * The periodic look the scheduler's short unit takes, at most every 15 minutes: the owners are told through `raiseAlert`
 * (told once, again after six hours if it persists) as the disk fills, `disk:warn`, `disk:critical`, `disk:full`, and only
 * the alert for the current state stands: the others, and all of them once usage falls under the warning, are cleared. An
 * unknown answer leaves what stands as it is. Never throws.
 */
export async function checkDiskHealth(now = Date.now(), env: Env = process.env, statfs?: StatFn): Promise<DiskHealth | null> {
  if (now - lastChecked < DISK_CHECK_MINUTES * 60_000) return null;
  lastChecked = now;
  try {
    const health = await diskHealth(env, statfs);
    if (health.thresholds.problem && health.thresholds.problem !== lastProblemSaid) {
      lastProblemSaid = health.thresholds.problem;
      console.error(`[mysenam] disk thresholds: ${health.thresholds.problem}`);
    } else if (!health.thresholds.problem) lastProblemSaid = null;
    const { raiseAlert, clearAlert } = await import("./alerts");
    const { englishOf, said } = await import("./staff-text");
    if (health.state === "unknown") return health;
    for (const key of ALERT_KEYS) if (health.state === "ok" || STATE_ALERTS[health.state as keyof typeof STATE_ALERTS] !== key) await clearAlert(key);
    if (health.state !== "ok") {
      const t = health.thresholds;
      const detail = said(health.state === "full" ? "srv.disk.fullDetail" : "srv.disk.detail", {
        used: health.usedPercent!,
        free: gigabytes(health.freeBytes!),
        warn: t.warn,
        critical: t.critical,
        block: t.block,
      });
      await raiseAlert(STATE_ALERTS[health.state], said(`srv.disk.${health.state}.alert`), englishOf(detail), [detail]);
    }
    return health;
  } catch (err) {
    console.error("[mysenam] could not check the disk:", err instanceof Error ? err.message : "unknown error");
    return null;
  }
}

/** Tests: forget when the periodic look last ran. */
export function resetDiskHealthClock(): void {
  lastChecked = 0;
  lastProblemSaid = null;
}
