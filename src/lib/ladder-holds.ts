import { getDb, withTransaction } from "./db";
import { policyFor } from "./booking-policy";
import { instantOf, formatMinute } from "./interval";
import type { ErrorCode } from "./i18n";
import { blockSlots, getCourt, offerSlotPlace, venueHours } from "./store";
import { isValidDateString, todayISO } from "./time";
import { DEFAULT_HOLD_LIMITS } from "./ladder-holds-constants";

/**
 * Court time held by the venue for a ladder's accepted challenges (docs/features/tournaments.md#court-time-and-booking-for-a-challenge,
 * ADR 0040; migration 0283).
 *
 * Off unless a manager turns it on for the ladder: a challenge then holds nothing, as the owner decided on 4 November 2026
 * (lib/ladders.ts `attachBooking`). When it is on, a challenge that is accepted at an agreed day **and time** has a court held for it
 * for the match's length plus the court's operational time (set-up and cleaning) either side, as **blocks the hold owns**
 * (`blocks.ladder_hold_id`), the way a team league's fixture holds court time: under the claims exclusion constraints, so no booking
 * path can take it, and a staff block or unblock over it leaves it. Nothing is sold: **no money moves**, no price, no booking, no payment.
 *
 * This module only reads and writes the hold: it is called inside the ladder's transaction and lock (lib/ladders.ts `withLadder`), tells
 * nobody and logs nothing (the callers do), and refuses with a code the caller turns into a sentence in the reader's language. A hold
 * is all there or not at all: a court is held for every minute of it or none, and a move is made new-time-first inside one savepoint, so a
 * refused move leaves the old court held.
 */

/** The install's caps, with the numbers they are seeded with (migration 0283). A row in `ladder_hold_limits` replaces them. */
export { DEFAULT_HOLD_LIMITS };

export async function holdLimits(): Promise<typeof DEFAULT_HOLD_LIMITS> {
  const row = (await getDb().prepare("SELECT max_live_per_ladder, max_per_player_week FROM ladder_hold_limits WHERE id = 1").get()) as
    | { max_live_per_ladder: number; max_per_player_week: number }
    | undefined;
  return row ? { maxLivePerLadder: row.max_live_per_ladder, maxPerPlayerWeek: row.max_per_player_week } : DEFAULT_HOLD_LIMITS;
}

export interface HoldView {
  id: number;
  courtId: number | null;
  court: string;
  date: string;
  /** The match, without the operational time either side. */
  startMin: number;
  endMin: number;
  madeBy: "players" | "staff";
}

export type HoldRefusal = { ok: false; code: ErrorCode; vars: Record<string, string | number> };
const refuse = (code: ErrorCode, vars: Record<string, string | number> = {}): HoldRefusal => ({ ok: false, code, vars });

interface HoldRow {
  id: number;
  ladder_id: number;
  challenge_id: number;
  court_id: number | null;
  date: string;
  start_min: number;
  end_min: number;
  held_from: number;
  held_to: number;
  made_by: "players" | "staff";
  court?: string | null;
}

/** The live holds of these challenges, each with its court's name. */
export async function holdViews(challengeIds: number[]): Promise<Map<number, HoldView>> {
  const out = new Map<number, HoldView>();
  if (challengeIds.length === 0) return out;
  const rows = (await getDb()
    .prepare(
      `SELECT h.*, c.name AS court FROM ladder_court_holds h LEFT JOIN courts c ON c.id = h.court_id
        WHERE h.released_at IS NULL AND h.challenge_id IN (${challengeIds.map(() => "?").join(",")})`
    )
    .all(...challengeIds)) as HoldRow[];
  for (const r of rows) out.set(r.challenge_id, { id: r.id, courtId: r.court_id, court: r.court ?? "", date: r.date, startMin: r.start_min, endMin: r.end_min, madeBy: r.made_by });
  return out;
}

export async function liveHold(challengeId: number): Promise<HoldView | null> {
  return (await holdViews([challengeId])).get(challengeId) ?? null;
}

/** The courts a ladder names for its holds, or none (any court of the venue for the sport). */
export async function ladderCourts(ladderId: number): Promise<number[]> {
  return ((await getDb().prepare("SELECT court_id FROM ladder_courts WHERE ladder_id = ? ORDER BY court_id").all(ladderId)) as { court_id: number }[]).map((r) => r.court_id);
}

/** Minutes already in use on a court that day, and whether something starts where the match ends or ends where it starts. */
async function crowding(courtId: number, date: string, from: number, to: number): Promise<{ busy: number; touching: number }> {
  const db = getDb();
  const rows = (await db
    .prepare(
      `SELECT start_min, end_min FROM bookings WHERE court_id = ? AND date = ? AND status = 'confirmed'
       UNION ALL SELECT start_min, end_min FROM blocks WHERE court_id = ? AND date = ?`
    )
    .all(courtId, date, courtId, date)) as { start_min: number; end_min: number }[];
  return {
    busy: rows.reduce((n, r) => n + (r.end_min - r.start_min), 0),
    touching: rows.filter((r) => r.end_min === from || r.start_min === to).length,
  };
}

export interface HoldRequest {
  ladder: { id: number; venueId: number; sport: string; name: string };
  challengeId: number;
  /** What the schedule says the block is for (staff see it): the ladder and the two sides. */
  label: string;
  /** The two places in the challenge, whose holds made in the last 7 days are counted. */
  playerIds: [number, number];
  date: string;
  startMin: number;
  minutes: number;
  /** A manager naming the court; otherwise the ladder's courts, or any court of the venue for the sport. */
  courtId?: number | null;
  by: { kind: "players" } | { kind: "staff"; name: string };
  /** A move or a manager's release-and-hold: not counted against the live cap twice, and a manager's act is not counted against a player's week. */
  replacing?: boolean;
}

/**
 * Hold a court for a challenge at a day and time agreed. The court is the ladder's own (named in `ladder_courts`) or any court of the venue
 * for the sport with one place, **chosen deterministically**: those that are free for the whole time, the one that sits against something
 * already on the court that day (the least fragmenting), then the busiest that day (so the emptier courts stay open to customers), then the
 * lowest id. Refused, with nothing held, when the time has gone, the venue is not open for all of it, a cap is reached, or no court is free.
 */
export async function makeHold(req: HoldRequest): Promise<{ ok: true; hold: HoldView } | HoldRefusal> {
  const db = getDb();
  const { ladder } = req;
  if (!isValidDateString(req.date) || !Number.isInteger(req.startMin) || req.startMin < 0 || req.startMin > 1439) return refuse("LAD2_TIME");
  const hours = await venueHours(ladder.venueId, req.date);
  const end = req.startMin + req.minutes;
  const time = `${formatMinute(req.startMin)}–${formatMinute(end)}`;
  if (instantOf(req.date, req.startMin, hours.zone).getTime() <= Date.now()) return refuse("LAD2_PAST", { date: req.date, time: formatMinute(req.startMin) });
  if (hours.closed || req.startMin < hours.openMin || end > hours.closeMin) return refuse("LAD2_CLOSED", { date: req.date, time });
  // The caps: a ladder cannot swallow a venue.
  const limits = await holdLimits();
  const today = todayISO(hours.zone);
  const own = (await db.prepare("SELECT id FROM ladder_court_holds WHERE challenge_id = ? AND released_at IS NULL").get(req.challengeId)) as { id: number } | undefined;
  const live = (await db.prepare("SELECT COUNT(*)::int AS n FROM ladder_court_holds WHERE ladder_id = ? AND released_at IS NULL AND date >= ? AND id <> ?").get(ladder.id, today, own?.id ?? 0)) as { n: number };
  if (live.n >= limits.maxLivePerLadder) return refuse("LAD2_CAP_LADDER", { n: limits.maxLivePerLadder });
  if (req.by.kind === "players" && !req.replacing)
    for (const p of req.playerIds) {
      const week = (await db
        .prepare(
          `SELECT COUNT(*)::int AS n FROM ladder_court_holds h JOIN ladder_challenges c ON c.id = h.challenge_id
            WHERE h.made_by = 'players' AND h.created_at > datetime('now', '-7 days') AND (c.challenger = ? OR c.challenged = ?)`
        )
        .get(p, p)) as { n: number };
      if (week.n >= limits.maxPerPlayerWeek) return refuse("LAD2_CAP_PLAYER", { n: limits.maxPerPlayerWeek });
    }
  // The courts it may be on.
  const named = await ladderCourts(ladder.id);
  const wanted = req.courtId ? [req.courtId] : named;
  const rows = (await db
    .prepare(
      `SELECT c.id FROM courts c JOIN court_activities ca ON ca.court_id = c.id AND ca.sport = ?
        WHERE c.venue_id = ? AND c.capacity = 1 ${wanted.length > 0 ? `AND c.id IN (${wanted.map(() => "?").join(",")})` : ""} ORDER BY c.id`
    )
    .all(ladder.sport, ladder.venueId, ...wanted)) as { id: number }[];
  if (rows.length === 0) return refuse("LAD2_NO_COURTS");
  // Each candidate with the operational time its court keeps either side.
  const candidates: { id: number; from: number; to: number; busy: number; touching: number }[] = [];
  for (const r of rows) {
    const court = await getCourt(r.id);
    if (!court) continue;
    const policy = await policyFor({ id: court.id, venueId: court.venueId, sport: ladder.sport as never });
    const from = Math.max(hours.openMin, req.startMin - policy.operationalBefore);
    const to = Math.min(hours.closeMin, end + policy.operationalAfter);
    candidates.push({ id: court.id, from, to, ...(await crowding(court.id, req.date, from, to)) });
  }
  candidates.sort((a, b) => Number(b.touching > 0) - Number(a.touching > 0) || b.busy - a.busy || a.id - b.id);
  for (const c of candidates) {
    const made = await tryCourt(req, c.id, c.from, c.to, end);
    if (made) return { ok: true, hold: made };
  }
  return refuse("LAD2_NO_COURT", { date: req.date, time });
}

/** Hold one court for the whole of `from`–`to`, or nothing: the blocks are written, counted, and taken back if they do not cover it all. */
async function tryCourt(req: HoldRequest, courtId: number, from: number, to: number, matchEnd: number): Promise<HoldView | null> {
  const db = getDb();
  return withTransaction(async (): Promise<HoldView | null> => {
    const row = (await db
      .prepare(
        `INSERT INTO ladder_court_holds (ladder_id, challenge_id, court_id, date, start_min, end_min, held_from, held_to, made_by, made_by_name)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
      )
      .get(req.ladder.id, req.challengeId, courtId, req.date, req.startMin, matchEnd, from, to, req.by.kind, req.by.kind === "staff" ? req.by.name : null)) as { id: number };
    const held = await blockSlots(courtId, req.date, { start: from, end: to }, req.label, undefined, { ladderHoldId: row.id });
    const covered = held.ok
      ? ((await db.prepare("SELECT COALESCE(SUM(LEAST(end_min, ?) - GREATEST(start_min, ?)), 0)::int AS n FROM blocks WHERE ladder_hold_id = ? AND court_id = ? AND date = ?").get(to, from, row.id, courtId, req.date)) as { n: number }).n
      : 0;
    if (covered >= to - from) return (await holdViews([req.challengeId])).get(req.challengeId) ?? null;
    await db.prepare("DELETE FROM blocks WHERE ladder_hold_id = ?").run(row.id);
    await db.prepare("DELETE FROM ladder_court_holds WHERE id = ?").run(row.id);
    return null;
  });
}

/**
 * Let a challenge's hold go, once: its blocks deleted, the row kept with why and by whom, and the freed day offered to the waiting list (after
 * the caller's transaction, `offerFreed`). Running it on a challenge with no live hold does nothing and returns null.
 */
export async function releaseHold(challengeId: number, reason: string, by: string | null = null, note: string | null = null): Promise<{ courtId: number | null; date: string; hold: HoldView } | null> {
  const db = getDb();
  const hold = (await holdViews([challengeId])).get(challengeId);
  if (!hold) return null;
  await db.prepare("DELETE FROM blocks WHERE ladder_hold_id = ?").run(hold.id);
  await db.prepare("UPDATE ladder_court_holds SET released_at = datetime('now'), released_reason = ?, released_by = ?, release_note = ? WHERE id = ? AND released_at IS NULL").run(reason, by, note, hold.id);
  return { courtId: hold.courtId, date: hold.date, hold };
}

/** The freed time is offered to whoever is waiting for it (a hold that was in the future), once the change is committed. */
export async function offerFreed(freed: ({ courtId: number | null; date: string } | null)[]): Promise<void> {
  const seen = new Set<string>();
  for (const f of freed) {
    if (!f || f.courtId === null || f.date < todayISO()) continue;
    const key = `${f.courtId}:${f.date}`;
    if (seen.has(key)) continue;
    seen.add(key);
    await offerSlotPlace(f.courtId, f.date).catch(() => null);
  }
}

/** A refusal thrown out of a savepoint, so everything written under it is taken back. */
export class HoldRolledBack extends Error {
  constructor(readonly refusal: HoldRefusal) {
    super(refusal.code);
  }
}

/**
 * Move a challenge's hold to a new time: the old time is let go and the new one held in one savepoint, so that a move to a time that overlaps
 * the old one works, and a refused move leaves the old court held exactly as it was.
 */
export async function moveHold(req: HoldRequest, reason: string, by: string | null, note: string | null = null): Promise<{ ok: true; hold: HoldView; freed: { courtId: number | null; date: string } | null } | HoldRefusal> {
  try {
    return await withTransaction(async () => {
      const old = await releaseHold(req.challengeId, reason, by, note);
      const made = await makeHold({ ...req, replacing: true });
      if (!made.ok) throw new HoldRolledBack(made);
      return { ok: true as const, hold: made.hold, freed: old ? { courtId: old.courtId, date: old.date } : null };
    });
  } catch (err) {
    if (err instanceof HoldRolledBack) return err.refusal;
    throw err;
  }
}

/**
 * Holds whose court time is no longer all there (a court taken out of service lets go of the blocks on it, as it does a tournament's): marked
 * lost, once, and returned for the caller to tell the players. Past holds are not looked at. Running it again finds nothing new.
 */
export async function reconcileHolds(): Promise<{ challengeId: number; ladderId: number }[]> {
  const db = getDb();
  const today = todayISO();
  const live = (await db.prepare("SELECT * FROM ladder_court_holds WHERE released_at IS NULL AND date >= ? ORDER BY id").all(today)) as HoldRow[];
  const lost: { challengeId: number; ladderId: number }[] = [];
  for (const h of live) {
    const covered = (await db
      .prepare("SELECT COALESCE(SUM(LEAST(end_min, ?) - GREATEST(start_min, ?)), 0)::int AS n FROM blocks WHERE ladder_hold_id = ? AND court_id = ? AND date = ?")
      .get(h.held_to, h.held_from, h.id, h.court_id ?? 0, h.date)) as { n: number };
    if (covered.n >= h.held_to - h.held_from) continue;
    const done = await db.prepare("UPDATE ladder_court_holds SET released_at = datetime('now'), released_reason = 'lost' WHERE id = ? AND released_at IS NULL").run(h.id);
    if (done.changes !== 1) continue;
    await db.prepare("DELETE FROM blocks WHERE ladder_hold_id = ?").run(h.id);
    lost.push({ challengeId: h.challenge_id, ladderId: h.ladder_id });
  }
  return lost;
}
