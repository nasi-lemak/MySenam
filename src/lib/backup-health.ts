import { hoursSinceLastBackup, listBackups } from "./backup";
import { MAX_UPLOAD, NEAR_LIMIT, offsiteStatus, type OffsiteStatus } from "./offsite";

/**
 * Whether the install could be recovered, and from how long ago: one answer
 * for the Backups panel and the scheduler's alerts, so a paused or failing
 * off-site copy is a line somebody reads, not a setting nobody looks at.
 *
 * The recovery point that counts is the newest copy that would survive losing
 * the server: the newest off-site copy when off-site copies are set up, the
 * newest local snapshot when they are not (which a lost disk takes with it).
 */

export type OffsiteState = "off" | "active" | "paused" | "failing";
export type BackupState = "ok" | "local_only" | "stale" | "paused" | "failing" | "none";

export interface BackupHealth {
  state: BackupState;
  /** The recovery-point target, in hours: older than this and the owners are told. */
  rpoHours: number;
  lastLocalAt: string | null;
  hoursSinceLocal: number | null;
  offsite: OffsiteState;
  lastOffsiteAt: string | null;
  hoursSinceOffsite: number | null;
  /** Age of the newest copy that would survive losing the server; null when there is none. */
  recoverableHours: number | null;
  /** The largest part of the last off-site set is past 80% of what one upload can take. */
  nearSizeLimit: boolean;
  /** What is wrong, in words, worst first. */
  problems: string[];
}

/** `MYSENAM_BACKUP_RPO_HOURS`: the nightly cycle and two hours' slack unless set. */
export function rpoHours(): number {
  const n = Number(process.env.MYSENAM_BACKUP_RPO_HOURS ?? 26);
  return Number.isFinite(n) && n >= 1 && n <= 24 * 14 ? n : 26;
}

function offsiteState(s: OffsiteStatus): OffsiteState {
  if (!s.configured) return "off";
  if (s.paused) return "paused";
  if (s.lastError && (!s.lastCopied || s.lastError.at > s.lastCopied.at)) return "failing";
  return "active";
}

const hoursSince = (iso: string | null, now: number) => (iso ? (now - Date.parse(iso)) / 3_600_000 : null);

export async function backupHealth(now = Date.now()): Promise<BackupHealth> {
  const rpo = rpoHours();
  const [newest] = listBackups();
  const hoursSinceLocal = hoursSinceLastBackup();
  const status = await offsiteStatus();
  const offsite = offsiteState(status);
  const lastOffsiteAt = status.lastCopied?.at ?? null;
  const hoursSinceOffsite = hoursSince(lastOffsiteAt, now);
  const recoverableHours = offsite === "off" ? hoursSinceLocal : hoursSinceOffsite;
  const nearSizeLimit = (status.lastCopied?.largestBytes ?? 0) > MAX_UPLOAD * NEAR_LIMIT;

  const problems: string[] = [];
  if (!newest) problems.push("There is no backup on this server yet.");
  if (offsite === "failing") problems.push(`Off-site copies are failing: ${status.lastError!.error}`);
  if (offsite === "paused") problems.push(status.paused!);
  if (recoverableHours === null && newest && offsite !== "off") problems.push("Nothing has been copied off-site yet.");
  if (recoverableHours !== null && recoverableHours > rpo)
    problems.push(`The newest ${offsite === "off" ? "backup" : "off-site copy"} is ${Math.floor(recoverableHours)} hours old, past the ${rpo}-hour recovery-point target.`);
  if (nearSizeLimit)
    problems.push(
      `The largest part of the last off-site set is ${(status.lastCopied!.largestBytes! / 1024 ** 3).toFixed(1)} GB; one upload, in parts, takes about ${Math.floor(MAX_UPLOAD / 1024 ** 3)} GB. Move photos to their own bucket before it is reached.`
    );

  const stale = recoverableHours === null ? offsite !== "off" : recoverableHours > rpo;
  const state: BackupState = !newest
    ? "none"
    : offsite === "failing"
      ? "failing"
      : offsite === "paused"
        ? "paused"
        : stale
          ? "stale"
          : offsite === "off"
            ? "local_only"
            : "ok";

  return {
    state,
    rpoHours: rpo,
    lastLocalAt: newest?.takenAt || null,
    hoursSinceLocal,
    offsite,
    lastOffsiteAt,
    hoursSinceOffsite,
    recoverableHours,
    nearSizeLimit,
    problems,
  };
}
