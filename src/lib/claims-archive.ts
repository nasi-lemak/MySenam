import { getDb, withTransaction } from "./db";
import { todayISO } from "./time";

/**
 * Archiving past claims (migration 0267; docs/architecture/database.md
 * "Archiving past claims").
 *
 * `claims` is the table every booking is checked against, and it cannot be
 * partitioned by month (ADR 0004), so it would grow with every booking a
 * venue ever took. A claim whose time has gone, held by something finished or
 * cancelled, decides nothing: no new claim can overlap time that is over. This
 * moves such claims into `claims_archive` (the same columns, none of the
 * checks that make a live claim dear), in batches of bounded size, each batch
 * one transaction that inserts the archived row and deletes the live one
 * together, so a claim is always in exactly one of the two.
 *
 * Off unless `CLAIMS_ARCHIVE_AFTER_DAYS` is set (to 90, say). It never moves a
 * claim that has no end, one that ended within the horizon, or one whose owner
 * is still open: a booking held for payment, awaiting a payment page that may
 * yet come back, with a dispute not won, or on an application under a legal,
 * safety or dispute hold; a waiting-list offer not yet answered; a proposed
 * move not yet decided; an application not yet decided or under a hold. A row
 * another transaction is changing is left for the next run (SKIP LOCKED), so a
 * run never waits on a booking and a booking never waits on a run.
 *
 * Readers of the past read `claims_all` (the two together); readers that look
 * only from now on keep to `claims`, which every archived claim lies far
 * behind (see READ_THROUGH_DAYS).
 */

/** The shortest horizon: a smaller number is raised to it. Time this recent can still be looked at, corrected or disputed. */
export const MIN_ARCHIVE_DAYS = 30;
/**
 * A reader of a window that reaches back further than this many days reads
 * `claims_all`; a nearer one reads `claims`. Less than MIN_ARCHIVE_DAYS, so a
 * claim is never archived out of the sight of a reader that thinks it is live.
 */
export const READ_THROUGH_DAYS = 25;
/** Claims moved by one transaction, and the transactions of one run: the work of one tick is bounded. */
export const BATCH_SIZE = 500;
export const MAX_BATCHES = 20;
/** A pending online payment this recent for a booking keeps its claim where it is. */
const PENDING_PAYMENT_DAYS = 30;
/** Eligible claims older than the horizon by this much are the job falling behind. */
const SLACK_DAYS = 7;
/** Not caught up for this long is falling behind. */
const BEHIND_AFTER_DAYS = 3;
/** Between runs when the last one finished everything due, and the wait after a failure. */
const RUN_EVERY_MS = 60 * 60_000;
const RETRY_AFTER_FAILURE_MS = 10 * 60_000;
const DAY_MS = 86_400_000;

/**
 * The horizon from `CLAIMS_ARCHIVE_AFTER_DAYS`: unset or 0 is off; a whole
 * number of days from 30 up is itself; fewer than 30 is raised to 30; anything
 * else is a mistake, and the archive stays off rather than guess.
 */
export function claimsArchiveDays(env: Record<string, string | undefined> = process.env): {
  days: number;
  problem: "invalid" | "raised" | null;
} {
  const raw = (env.CLAIMS_ARCHIVE_AFTER_DAYS ?? "").trim();
  if (raw === "" || raw === "0") return { days: 0, problem: null };
  if (!/^\d+$/.test(raw)) return { days: 0, problem: "invalid" };
  const n = Number(raw);
  if (n === 0) return { days: 0, problem: null };
  return n < MIN_ARCHIVE_DAYS ? { days: MIN_ARCHIVE_DAYS, problem: "raised" } : { days: n, problem: null };
}

/** The columns of a claim as the live table and the archive both have them, in the order of the table. */
const COLUMNS = [
  "id", "venue_id", "court_id", "space_id", "places", "kind", "booking_id", "class_id", "block_id", "outage_id", "waitlist_id",
  "during", "occupied", "buffer_before", "buffer_after", "active", "expires_at", "created_at", "move_id", "approval_id",
  "separation_before", "separation_after", "facility_wide",
] as const;

const dbStamp = (at: Date) => at.toISOString().replace("T", " ").slice(0, 19);

/**
 * Which claims may move: ended before `cutoff`, and held by something no
 * longer open. One condition, used to count what is due and to move it, so
 * the two cannot drift. The arguments, in order: the cutoff, the earliest a
 * pending payment still counts (database text), and today (an application's
 * hold is in force through its review day).
 */
export function eligibleClaims(c = "c"): string {
  return `NOT upper_inf(${c}.occupied) AND upper(${c}.occupied) < ?::timestamptz AND (
    (${c}.kind = 'booking' AND EXISTS (
       SELECT 1 FROM bookings b WHERE b.id = ${c}.booking_id
          AND NOT (b.status = 'confirmed' AND b.payment_status = 'unpaid' AND b.hold_until IS NOT NULL)
          AND NOT EXISTS (
            SELECT 1 FROM online_payment_bookings pb JOIN online_payments p ON p.id = pb.payment_id
             WHERE pb.booking_id = b.id
               AND ((p.status = 'pending' AND p.created_at >= ?)
                    OR EXISTS (SELECT 1 FROM payment_disputes d WHERE d.payment_id = p.id AND COALESCE(d.outcome, '') <> 'won')))
          AND NOT EXISTS (
            SELECT 1 FROM approval_requests r JOIN approval_holds h ON h.request_id = r.id
             WHERE r.booking_id = b.id AND h.released_at IS NULL AND h.review_by >= ?)))
    OR ${c}.kind IN ('class', 'block', 'outage')
    OR (${c}.kind = 'offer' AND EXISTS (SELECT 1 FROM waitlist w WHERE w.id = ${c}.waitlist_id AND w.status IN ('claimed', 'expired', 'cancelled')))
    OR (${c}.kind = 'move' AND EXISTS (SELECT 1 FROM game_moves m WHERE m.id = ${c}.move_id AND m.status <> 'pending'))
    OR (${c}.kind = 'approval' AND EXISTS (
         SELECT 1 FROM approval_requests r WHERE r.id = ${c}.approval_id
            AND r.status NOT IN ('pending', 'info_requested', 'in_person_due')
            AND NOT EXISTS (SELECT 1 FROM approval_holds h WHERE h.request_id = r.id AND h.released_at IS NULL AND h.review_by >= ?)))
  )`;
}

/** `eligibleClaims`' arguments for claims that ended before `cutoff`. */
function eligibleArgs(cutoff: Date, now: Date): unknown[] {
  const today = todayISO();
  return [cutoff.toISOString(), dbStamp(new Date(now.getTime() - PENDING_PAYMENT_DAYS * DAY_MS)), today, today];
}

/** Move one batch: the live rows deleted and the archive's inserted by one statement, in one transaction. */
async function moveBatch(cutoff: Date, now: Date, size: number): Promise<number> {
  const list = COLUMNS.join(", ");
  const returned = COLUMNS.map((c) => `c.${c}`).join(", ");
  const moved = await withTransaction(async () =>
    getDb()
      .prepare(
        `WITH picked AS (
           SELECT c.id FROM claims c
            WHERE ${eligibleClaims("c")}
            ORDER BY upper(c.occupied), c.id
            LIMIT ?
              FOR UPDATE OF c SKIP LOCKED
         ), moved AS (
           DELETE FROM claims c USING picked p WHERE c.id = p.id RETURNING ${returned}
         )
         INSERT INTO claims_archive (${list}, archived_at) SELECT ${list}, now() FROM moved`
      )
      .run(...eligibleArgs(cutoff, now), size)
  );
  return moved.changes;
}

export interface ArchiveRun {
  /** Claims moved by this run. */
  moved: number;
  batches: number;
  /** It stopped at its limit with more due: the next tick carries on. */
  more: boolean;
}

/**
 * Move claims that ended more than `days` days before `now` and whose owners
 * are finished, `batch` at a time, up to `maxBatches` batches. Safe to run
 * again, at once or at any time after a stop: what has moved is no longer
 * there to move. Does nothing for `days` of 0.
 */
export async function archiveClaims(
  opts: { now?: Date; days?: number; batch?: number; maxBatches?: number } = {}
): Promise<ArchiveRun> {
  const now = opts.now ?? new Date();
  const days = opts.days ?? claimsArchiveDays().days;
  const size = opts.batch ?? BATCH_SIZE;
  const limit = opts.maxBatches ?? MAX_BATCHES;
  const run: ArchiveRun = { moved: 0, batches: 0, more: false };
  if (days <= 0) return run;
  const cutoff = new Date(now.getTime() - days * DAY_MS);
  while (run.batches < limit) {
    const moved = await moveBatch(cutoff, now, size);
    if (moved === 0) return run;
    run.moved += moved;
    run.batches++;
    if (moved < size) return run;
  }
  run.more = true;
  return run;
}

// ------------------------------------------------------------ the scheduled job and what it says about itself

const KEYS = {
  ranAt: "claims_archive_ran_at",
  firstRunAt: "claims_archive_first_run_at",
  cleanAt: "claims_archive_clean_at",
  more: "claims_archive_more",
  lastMoved: "claims_archive_last_moved",
  totalMoved: "claims_archive_total_moved",
  failedAt: "claims_archive_failed_at",
  failure: "claims_archive_failure",
} as const;

async function setting(key: string): Promise<string | null> {
  const row = (await getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key)) as { value: string } | undefined;
  return row?.value ?? null;
}
async function remember(entries: Partial<Record<keyof typeof KEYS, string | null>>): Promise<void> {
  const db = getDb();
  for (const [name, value] of Object.entries(entries) as [keyof typeof KEYS, string | null][]) {
    if (value === null) await db.prepare("DELETE FROM settings WHERE key = ?").run(KEYS[name]);
    else
      await db
        .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
        .run(KEYS[name], value);
  }
}

/** Claims due to move that ended more than `days` days ago, counted up to `limit`. */
async function dueAt(days: number, now: Date, limit: number): Promise<number> {
  const cutoff = new Date(now.getTime() - days * DAY_MS);
  const row = (await getDb()
    .prepare(`SELECT COUNT(*)::int AS n FROM (SELECT 1 FROM claims c WHERE ${eligibleClaims("c")} LIMIT ?) due`)
    .get(...eligibleArgs(cutoff, now), limit)) as { n: number };
  return row.n;
}
/** Those that have waited past the horizon by more than the slack: the job is not keeping up with them. */
const dueBeyondSlack = (days: number, now: Date, limit: number) => dueAt(days + SLACK_DAYS, now, limit);

export interface ClaimsArchiveStatus {
  /** CLAIMS_ARCHIVE_AFTER_DAYS in force (0: off). */
  days: number;
  problem: "invalid" | "raised" | null;
  ranAt: string | null;
  lastMoved: number;
  totalMoved: number;
  /** Due to move now, counted up to 1000 (so "1000" means at least that many). */
  waiting: number;
  /** Not caught up for three days: the job has stopped, or cannot keep pace. */
  behind: boolean;
  /** The last run's failure, until a run succeeds. */
  failure: { at: string; message: string } | null;
}

/** Where the archive job stands, for the platform owner; reads only. */
export async function claimsArchiveStatus(now = new Date()): Promise<ClaimsArchiveStatus> {
  const { days, problem } = claimsArchiveDays();
  const failedAt = await setting(KEYS.failedAt);
  const status: ClaimsArchiveStatus = {
    days,
    problem,
    ranAt: await setting(KEYS.ranAt),
    lastMoved: Number((await setting(KEYS.lastMoved)) ?? 0),
    totalMoved: Number((await setting(KEYS.totalMoved)) ?? 0),
    waiting: 0,
    behind: false,
    failure: failedAt ? { at: failedAt, message: (await setting(KEYS.failure)) ?? "" } : null,
  };
  if (days === 0) return status;
  status.waiting = await dueAt(days, now, 1000);
  const since = (await setting(KEYS.cleanAt)) ?? (await setting(KEYS.firstRunAt));
  status.behind = since !== null && now.getTime() - Date.parse(since) > BEHIND_AFTER_DAYS * DAY_MS && status.waiting > 0;
  return status;
}

export interface ArchiveTick extends ArchiveRun {
  /** It could not keep up: due claims have waited three days or more. */
  behind: boolean;
}

/**
 * From the scheduler, every tick: archive what is due, if the archive is on
 * and it is time. A run that left nothing due is repeated an hour later; one
 * that stopped at its limit, next tick; one that failed, ten minutes later (the
 * failure is thrown, for the scheduler to tell the owners, and kept for the
 * status). Null when nothing ran.
 */
export async function archiveClaimsIfDue(now = new Date(), limits: { batch?: number; maxBatches?: number } = {}): Promise<ArchiveTick | null> {
  const { days } = claimsArchiveDays();
  if (days === 0) return null;
  const ranAt = await setting(KEYS.ranAt);
  const failedAt = await setting(KEYS.failedAt);
  const more = (await setting(KEYS.more)) === "1";
  if (failedAt && now.getTime() - Date.parse(failedAt) < RETRY_AFTER_FAILURE_MS) return null;
  if (ranAt && !more && now.getTime() - Date.parse(ranAt) < RUN_EVERY_MS) return null;
  let run: ArchiveRun;
  try {
    run = await archiveClaims({ now, days, ...limits });
  } catch (err) {
    await remember({
      failedAt: now.toISOString(),
      failure: (err instanceof Error ? err.message : String(err)).slice(0, 500),
    }).catch(() => undefined);
    throw err;
  }
  // Caught up when nothing due has waited beyond the slack.
  const late = await dueBeyondSlack(days, now, 1);
  const first = (await setting(KEYS.firstRunAt)) ?? now.toISOString();
  const total = Number((await setting(KEYS.totalMoved)) ?? 0) + run.moved;
  await remember({
    ranAt: now.toISOString(),
    firstRunAt: first,
    cleanAt: late === 0 ? now.toISOString() : await setting(KEYS.cleanAt),
    more: run.more ? "1" : "0",
    lastMoved: String(run.moved),
    totalMoved: String(total),
    failedAt: null,
    failure: null,
  });
  const since = late === 0 ? now.getTime() : Date.parse((await setting(KEYS.cleanAt)) ?? first);
  return { ...run, behind: late > 0 && now.getTime() - since > BEHIND_AFTER_DAYS * DAY_MS };
}

/**
 * Claims in the archive that could still matter: one with no end, or ended
 * within the days a reader of `claims` alone relies on. The job cannot make
 * one; the integrity check looks for it, so a wrong hand or a restored half
 * would be found.
 */
export async function claimsArchivedTooSoon(
  limit: number,
  venueIds: number[] | null = null
): Promise<{ id: number; venue_id: number; kind: string; booking_id: number | null }[]> {
  const cutoff = new Date(Date.now() - READ_THROUGH_DAYS * DAY_MS).toISOString();
  const where = venueIds === null ? "" : ` AND venue_id IN (${venueIds.map(() => "?").join(",")})`;
  return (await getDb()
    .prepare(
      `SELECT id, venue_id, kind, booking_id FROM claims_archive
        WHERE COALESCE(upper(occupied), 'infinity'::timestamptz) >= ?::timestamptz${where} ORDER BY id LIMIT ${Math.floor(limit)}`
    )
    .all(cutoff, ...(venueIds ?? []))) as { id: number; venue_id: number; kind: string; booking_id: number | null }[];
}
