import { getDb, withTransaction } from "./db";
import { policyFor } from "./booking-policy";
import { isConflict } from "./claims";
import { instantOf, formatMinute, rangeLiteral } from "./interval";
import type { ErrorCode } from "./i18n";
import { blockSlots, getCourt, offerSlotPlace, venueHours } from "./store";
import { isValidDateString, todayISO } from "./time";
import { DEFAULT_HOLD_BOUNDS, DEFAULT_HOLD_EXPIRY, DEFAULT_HOLD_LIMITS } from "./ladder-holds-constants";
import { sweepExpiredHolds } from "./ladder-hold-sweep";

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
 *
 * ADR 0048 (migration 0290) adds to this: the caps are defaults resolved ladder, then venue, then install, inside install bounds (`resolveHoldLimits`,
 * `setHoldLimits`); a hold is tentative until both players or a manager confirm it and lapses at its confirm-by moment (`confirmHold`, `extendHold`,
 * `confirmDeadline`), a lapse being enforced lazily (the claims carry the moment as their `expires_at`, `lib/claims.ts` lets go of lapsed holds when a
 * claim meets one, `lib/ladder-hold-sweep.ts`) and by the scheduler (`expiredHoldsToTell`); and live holds of one court cannot overlap, by a constraint
 * on this table as well as the claims'. A cap only ever refuses: nothing here creates a hold except through `makeHold` and the one claim path.
 */

/** The install's caps, with the numbers they are seeded with (migration 0283). A row in `ladder_hold_limits` replaces them. */
export { DEFAULT_HOLD_LIMITS, DEFAULT_HOLD_BOUNDS, DEFAULT_HOLD_EXPIRY };

type Limits = typeof DEFAULT_HOLD_LIMITS;
type Bounds = typeof DEFAULT_HOLD_BOUNDS;
type Expiry = typeof DEFAULT_HOLD_EXPIRY;

/** What the install says (the one row of `ladder_hold_limits`, install data): the default caps, the bounds a setting must stay within, and the expiry windows. */
export async function installHoldPolicy(): Promise<{ limits: Limits; bounds: Bounds; expiry: Expiry }> {
  const row = (await getDb()
    .prepare("SELECT max_live_per_ladder, max_per_player_week, live_min, live_max, week_min, week_max, confirm_hours, min_notice_minutes, extend_hours FROM ladder_hold_limits WHERE id = 1")
    .get()) as
    | { max_live_per_ladder: number; max_per_player_week: number; live_min: number; live_max: number; week_min: number; week_max: number; confirm_hours: number; min_notice_minutes: number; extend_hours: number }
    | undefined;
  if (!row) return { limits: DEFAULT_HOLD_LIMITS, bounds: DEFAULT_HOLD_BOUNDS, expiry: DEFAULT_HOLD_EXPIRY };
  return {
    limits: { maxLivePerLadder: row.max_live_per_ladder, maxPerPlayerWeek: row.max_per_player_week },
    bounds: { liveMin: row.live_min, liveMax: row.live_max, weekMin: row.week_min, weekMax: row.week_max },
    expiry: { confirmHours: row.confirm_hours, minNoticeMinutes: row.min_notice_minutes, extendHours: row.extend_hours },
  };
}

/** The install's default caps. */
export async function holdLimits(): Promise<Limits> {
  return (await installHoldPolicy()).limits;
}

type Source = "ladder" | "venue" | "install";

/** The caps that apply to one ladder, and where each comes from (ADR 0048): the ladder's own override, else the venue's setting, else the install default. */
export interface HoldLimitsView {
  /** What applies now. */
  maxLivePerLadder: number;
  maxPerPlayerWeek: number;
  from: { live: Source; week: Source };
  install: Limits;
  /** The venue's setting (null: none) and the ladder's override (null: none). */
  venue: { maxLivePerLadder: number | null; maxPerPlayerWeek: number | null };
  ladder: { maxLivePerLadder: number | null; maxPerPlayerWeek: number | null };
  bounds: Bounds;
  /** Holds live on the ladder now: a cap set below this blocks new holds and releases none. */
  inUse: number;
}

/** Resolved in this order, each only ever a number a holder set: ladder override, venue setting, install default. */
export async function resolveHoldLimits(ladder: { id: number; venueId: number }): Promise<HoldLimitsView> {
  const db = getDb();
  const policy = await installHoldPolicy();
  const venue = (await db.prepare("SELECT max_live_per_ladder, max_per_player_week FROM venue_ladder_hold_limits WHERE venue_id = ?").get(ladder.venueId)) as
    | { max_live_per_ladder: number | null; max_per_player_week: number | null }
    | undefined;
  const own = (await db.prepare("SELECT cap_live, cap_week FROM ladders WHERE id = ?").get(ladder.id)) as { cap_live: number | null; cap_week: number | null } | undefined;
  const v = { maxLivePerLadder: venue?.max_live_per_ladder ?? null, maxPerPlayerWeek: venue?.max_per_player_week ?? null };
  const l = { maxLivePerLadder: own?.cap_live ?? null, maxPerPlayerWeek: own?.cap_week ?? null };
  const pick = (a: number | null, b: number | null, c: number): [number, Source] => (a !== null ? [a, "ladder"] : b !== null ? [b, "venue"] : [c, "install"]);
  const [live, liveFrom] = pick(l.maxLivePerLadder, v.maxLivePerLadder, policy.limits.maxLivePerLadder);
  const [week, weekFrom] = pick(l.maxPerPlayerWeek, v.maxPerPlayerWeek, policy.limits.maxPerPlayerWeek);
  const inUse = ((await db.prepare(`SELECT COUNT(*)::int AS n FROM ladder_court_holds h WHERE h.ladder_id = ? AND ${LIVE} AND h.date >= ?`).get(ladder.id, todayISO())) as { n: number }).n;
  return { maxLivePerLadder: live, maxPerPlayerWeek: week, from: { live: liveFrom, week: weekFrom }, install: policy.limits, venue: v, ladder: l, bounds: policy.bounds, inUse };
}

/** A hold that is not released and not lapsed: one still tentative past its confirm-by moment is, to every read, already gone. */
const LIVE = "h.released_at IS NULL AND NOT (h.confirmed_at IS NULL AND h.confirm_by IS NOT NULL AND h.confirm_by <= now())";

/** A number a holder may set, `null` to go back to the default above it, or why not (with the bounds). */
function limitOk(raw: unknown, min: number, max: number, what: "live" | "week"): number | null | HoldRefusal {
  if (raw === null || raw === "") return null;
  const n = typeof raw === "number" ? raw : typeof raw === "string" && /^\d+$/.test(raw.trim()) ? Number(raw) : NaN;
  if (!Number.isInteger(n) || n < min || n > max) return refuse("LAD3_BOUNDS", { what, min, max });
  return n;
}

/**
 * A manager's change to the caps of a venue (`scope: "venue"`, for every ladder without its own) or one ladder. Each value is a number within the install's
 * bounds, `null` to go back to the default above it, or left out to stay as it is; outside the bounds it is refused with them. It applies to holds
 * made from now on and releases none, however far below current use it goes. Returns what applied before and after, for the log.
 */
export async function setHoldLimits(
  ladder: { id: number; venueId: number },
  scope: "venue" | "ladder",
  change: { maxLive?: unknown; maxWeek?: unknown }
): Promise<{ ok: true; before: HoldLimitsView; after: HoldLimitsView } | HoldRefusal> {
  const db = getDb();
  const before = await resolveHoldLimits(ladder);
  const { bounds } = before;
  const live = change.maxLive === undefined ? undefined : limitOk(change.maxLive, bounds.liveMin, bounds.liveMax, "live");
  const week = change.maxWeek === undefined ? undefined : limitOk(change.maxWeek, bounds.weekMin, bounds.weekMax, "week");
  if (typeof live === "object" && live !== null) return live;
  if (typeof week === "object" && week !== null) return week;
  const current = scope === "venue" ? before.venue : before.ladder;
  const nextLive = live === undefined ? current.maxLivePerLadder : live;
  const nextWeek = week === undefined ? current.maxPerPlayerWeek : week;
  if (scope === "venue")
    await db
      .prepare(
        `INSERT INTO venue_ladder_hold_limits (venue_id, max_live_per_ladder, max_per_player_week) VALUES (?, ?, ?)
         ON CONFLICT (venue_id) DO UPDATE SET max_live_per_ladder = EXCLUDED.max_live_per_ladder, max_per_player_week = EXCLUDED.max_per_player_week`
      )
      .run(ladder.venueId, nextLive, nextWeek);
  else await db.prepare("UPDATE ladders SET cap_live = ?, cap_week = ? WHERE id = ?").run(nextLive, nextWeek, ladder.id);
  return { ok: true, before, after: await resolveHoldLimits(ladder) };
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
  /**
   * Confirmation (ADR 0048). A hold is tentative until both players (or a manager) confirm it and lapses at `confirmBy`; one with no `confirmBy`
   * (made before confirmation existed, by a manager, or on a ladder that does not ask for it) is confirmed.
   */
  tentative: boolean;
  /** When a tentative hold lapses (ISO). */
  confirmBy: string | null;
  /** Which of the two sides has confirmed it. */
  confirmedBy: { challenger: boolean; challenged: boolean };
  /** A manager extended the time to confirm (once). */
  extended: boolean;
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
  confirm_by: Date | string | null;
  confirmed_at: Date | string | null;
  confirmed_challenger_at: Date | string | null;
  confirmed_challenged_at: Date | string | null;
  extended_at: Date | string | null;
  court?: string | null;
}

const iso = (v: Date | string): string => new Date(v).toISOString();

/**
 * The live holds of these challenges, each with its court's name. A hold still tentative past its confirm-by moment is not live, whether or not the
 * scheduler has let it go yet: this is the lazy half of expiry (the claims carry the same moment, so a booking never sees it either).
 */
export async function holdViews(challengeIds: number[]): Promise<Map<number, HoldView>> {
  const out = new Map<number, HoldView>();
  if (challengeIds.length === 0) return out;
  const rows = (await getDb()
    .prepare(
      `SELECT h.*, c.name AS court FROM ladder_court_holds h LEFT JOIN courts c ON c.id = h.court_id
        WHERE ${LIVE} AND h.challenge_id IN (${challengeIds.map(() => "?").join(",")})`
    )
    .all(...challengeIds)) as HoldRow[];
  for (const r of rows) {
    const tentative = r.confirm_by !== null && r.confirmed_at === null;
    out.set(r.challenge_id, {
      id: r.id,
      courtId: r.court_id,
      court: r.court ?? "",
      date: r.date,
      startMin: r.start_min,
      endMin: r.end_min,
      madeBy: r.made_by,
      tentative,
      confirmBy: tentative && r.confirm_by !== null ? iso(r.confirm_by) : null,
      confirmedBy: { challenger: r.confirmed_challenger_at !== null, challenged: r.confirmed_challenged_at !== null },
      extended: r.extended_at !== null,
    });
  }
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
  /** `needsConfirmation`: the ladder asks both players to confirm a hold (ADR 0048); unset, a hold is confirmed when made, as before. */
  ladder: { id: number; venueId: number; sport: string; name: string; needsConfirmation?: boolean };
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
  /**
   * Made confirmed, not tentative: a move of a hold that was confirmed (both players agreed the move), and anything a manager makes. A manager's hold
   * is always confirmed, whatever this says.
   */
  confirmed?: boolean;
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
  // A hold nobody confirmed in time lets go of its court first, so it is counted as gone and cannot be in this one's way (idempotent; ADR 0048).
  await sweepExpiredHolds();
  // The caps: a ladder cannot swallow a venue. They only ever refuse (ADR 0048): the court is still got through the claim below, under the database's
  // constraints, so a cap raised as far as it goes holds nothing that is not free. A move or a re-hold replaces a hold and adds none, so a ladder that
  // is over a cap lowered under it can still move what it has.
  const limits = await resolveHoldLimits(ladder);
  const today = todayISO(hours.zone);
  const own = (await db.prepare("SELECT id FROM ladder_court_holds WHERE challenge_id = ? AND released_at IS NULL").get(req.challengeId)) as { id: number } | undefined;
  const live = (await db.prepare("SELECT COUNT(*)::int AS n FROM ladder_court_holds WHERE ladder_id = ? AND released_at IS NULL AND date >= ? AND id <> ?").get(ladder.id, today, own?.id ?? 0)) as { n: number };
  if (!req.replacing && live.n >= limits.maxLivePerLadder) return refuse("LAD2_CAP_LADDER", { n: limits.maxLivePerLadder });
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
  // Tentative until both players (or a manager) confirm, unless a manager makes it, it is a move of a confirmed hold, or the ladder does not ask (ADR 0048).
  const confirmBy = req.by.kind === "staff" || req.confirmed === true || ladder.needsConfirmation !== true ? null : await confirmDeadline(req.date, req.startMin, hours.zone);
  for (const c of candidates) {
    const made = await tryCourt(req, c.id, c.from, c.to, end, hours.zone, confirmBy);
    if (made) return { ok: true, hold: made };
  }
  return refuse("LAD2_NO_COURT", { date: req.date, time });
}

/**
 * When a tentative hold lapses: the install's window after it is made, but never later than the match's start less the minimum notice, and, when that
 * has already gone (a match arranged at short notice), at the latest at the start (ADR 0048).
 */
export async function confirmDeadline(date: string, startMin: number, zone: string): Promise<Date> {
  const { expiry } = await installHoldPolicy();
  const now = Date.now();
  const start = instantOf(date, startMin, zone).getTime();
  const by = Math.min(now + expiry.confirmHours * 3_600_000, start - expiry.minNoticeMinutes * 60_000);
  return new Date(by > now ? by : start);
}

/** Hold one court for the whole of `from`–`to`, or nothing: the blocks are written, counted, and taken back if they do not cover it all. */
async function tryCourt(req: HoldRequest, courtId: number, from: number, to: number, matchEnd: number, zone: string, confirmBy: Date | null): Promise<HoldView | null> {
  const db = getDb();
  try {
    return await withTransaction(async (): Promise<HoldView | null> => {
      // Whatever on this court nobody confirmed in time has let go of it (also done by every claim that finds it in the way).
      await sweepExpiredHolds();
      const row = (await db
        .prepare(
          `INSERT INTO ladder_court_holds (ladder_id, challenge_id, court_id, date, start_min, end_min, held_from, held_to, made_by, made_by_name, confirm_by, held_during)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?::timestamptz, ?::tstzrange) RETURNING id`
        )
        .get(
          req.ladder.id,
          req.challengeId,
          courtId,
          req.date,
          req.startMin,
          matchEnd,
          from,
          to,
          req.by.kind,
          req.by.kind === "staff" ? req.by.name : null,
          confirmBy ? confirmBy.toISOString() : null,
          rangeLiteral(req.date, from, to, zone)
        )) as { id: number };
      const held = await blockSlots(courtId, req.date, { start: from, end: to }, req.label, undefined, { ladderHoldId: row.id, expiresAt: confirmBy });
      const covered = held.ok
        ? ((await db.prepare("SELECT COALESCE(SUM(LEAST(end_min, ?) - GREATEST(start_min, ?)), 0)::int AS n FROM blocks WHERE ladder_hold_id = ? AND court_id = ? AND date = ?").get(to, from, row.id, courtId, req.date)) as { n: number }).n
        : 0;
      if (covered >= to - from) return (await holdViews([req.challengeId])).get(req.challengeId) ?? null;
      await db.prepare("DELETE FROM blocks WHERE ladder_hold_id = ?").run(row.id);
      await db.prepare("DELETE FROM ladder_court_holds WHERE id = ?").run(row.id);
      return null;
    });
  } catch (err) {
    // The table of holds is itself under an exclusion constraint (migration 0290): another hold of this court overlapping this one is this court not being free.
    if (isConflict(err)) return null;
    throw err;
  }
}

/**
 * Let a challenge's hold go, once: its blocks deleted, the row kept with why and by whom, and the freed day offered to the waiting list (after
 * the caller's transaction, `offerFreed`). Running it on a challenge with no live hold does nothing and returns null.
 */
export async function releaseHold(challengeId: number, reason: string, by: string | null = null, note: string | null = null): Promise<{ courtId: number | null; date: string; hold: HoldView } | null> {
  const db = getDb();
  const hold = (await holdViews([challengeId])).get(challengeId);
  if (!hold) return null;
  // Marked first, and only if nothing else let it go meanwhile (the expiry sweep runs without the ladder's lock): whoever marks it owns its release.
  const done = await db
    .prepare("UPDATE ladder_court_holds SET released_at = datetime('now'), released_reason = ?, released_by = ?, release_note = ? WHERE id = ? AND released_at IS NULL")
    .run(reason, by, note, hold.id);
  if (done.changes !== 1) return null;
  await db.prepare("DELETE FROM blocks WHERE ladder_hold_id = ?").run(hold.id);
  return { courtId: hold.courtId, date: hold.date, hold };
}

/**
 * A player confirms a tentative hold, or a manager does for both (ADR 0048). Once both players have, the hold is confirmed and its claims stop carrying
 * the lapse moment; one confirmed after its time is refused (`LAD3_EXPIRED`), and the sweep that lets it go and this cannot both win, because each
 * acts only on a hold that is still unreleased, unconfirmed and (for this) before its confirm-by moment, in one statement.
 */
export async function confirmHold(
  challengeId: number,
  by: { side: "challenger" | "challenged" } | { manager: string }
): Promise<{ ok: true; hold: HoldView; complete: boolean; changed: boolean } | HoldRefusal> {
  const db = getDb();
  const row = (await db
    .prepare(
      `SELECT h.id, h.confirm_by, h.confirmed_at, h.confirmed_challenger_at, h.confirmed_challenged_at, h.released_at, h.released_reason,
              (h.confirm_by IS NOT NULL AND h.confirm_by <= now()) AS lapsed
         FROM ladder_court_holds h WHERE h.challenge_id = ? ORDER BY h.id DESC LIMIT 1`
    )
    .get(challengeId)) as
    | { id: number; confirm_by: unknown; confirmed_at: unknown; confirmed_challenger_at: unknown; confirmed_challenged_at: unknown; released_at: string | null; released_reason: string | null; lapsed: boolean }
    | undefined;
  if (!row || (row.released_at !== null && row.released_reason !== "expired")) return refuse("LAD2_NO_HOLD");
  if (row.released_reason === "expired" || (row.confirmed_at === null && row.confirm_by !== null && row.lapsed)) return refuse("LAD3_EXPIRED");
  if (row.confirm_by === null || row.confirmed_at !== null) {
    const view = (await holdViews([challengeId])).get(challengeId);
    return view ? { ok: true, hold: view, complete: true, changed: false } : refuse("LAD2_NO_HOLD");
  }
  const column = "manager" in by ? null : by.side === "challenger" ? "confirmed_challenger_at" : "confirmed_challenged_at";
  // Confirming twice is a repeat, not a change: nothing is written and nobody is told again.
  if (!("manager" in by) && (by.side === "challenger" ? row.confirmed_challenger_at : row.confirmed_challenged_at) !== null) {
    const view = (await holdViews([challengeId])).get(challengeId);
    return view ? { ok: true, hold: view, complete: false, changed: false } : refuse("LAD3_EXPIRED");
  }
  const set = column ? `${column} = COALESCE(${column}, now())` : "confirmed_by = ?";
  const done = await db
    .prepare(`UPDATE ladder_court_holds SET ${set} WHERE id = ? AND released_at IS NULL AND confirmed_at IS NULL AND confirm_by > now() RETURNING confirmed_challenger_at, confirmed_challenged_at`)
    .get(...("manager" in by ? [by.manager, row.id] : [row.id])) as { confirmed_challenger_at: unknown; confirmed_challenged_at: unknown } | undefined;
  if (!done) return refuse("LAD3_EXPIRED");
  const complete = "manager" in by || (done.confirmed_challenger_at !== null && done.confirmed_challenged_at !== null);
  if (complete) {
    await db.prepare("UPDATE ladder_court_holds SET confirmed_at = now() WHERE id = ? AND confirmed_at IS NULL").run(row.id);
    // The claims stop carrying the lapse moment: the court is the hold's until it is let go.
    await db.prepare("UPDATE claims SET expires_at = NULL WHERE kind = 'block' AND block_id IN (SELECT id FROM blocks WHERE ladder_hold_id = ?)").run(row.id);
  }
  const view = (await holdViews([challengeId])).get(challengeId);
  return view ? { ok: true, hold: view, complete, changed: true } : refuse("LAD3_EXPIRED");
}

/**
 * A manager gives a tentative hold more time to be confirmed, once, with a reason (kept with the hold): by the install's extension, never past the
 * match's start. A hold already let go is not brought back: its court may be somebody else's by now, so it is held again (a move) instead.
 */
export async function extendHold(challengeId: number, venueId: number, by: string, reason: string): Promise<{ ok: true; hold: HoldView } | HoldRefusal> {
  const db = getDb();
  const row = (await db
    .prepare(
      `SELECT h.id, h.date, h.start_min, h.confirm_by FROM ladder_court_holds h
        WHERE h.challenge_id = ? AND h.released_at IS NULL AND h.confirmed_at IS NULL AND h.confirm_by IS NOT NULL AND h.confirm_by > now()`
    )
    .get(challengeId)) as { id: number; date: string; start_min: number; confirm_by: Date | string } | undefined;
  if (!row) return refuse("LAD3_NOT_TENTATIVE");
  if ((await db.prepare("SELECT 1 FROM ladder_court_holds WHERE id = ? AND extended_at IS NOT NULL").get(row.id)) !== undefined) return refuse("LAD3_EXTENDED");
  const hours = await venueHours(venueId, row.date);
  const start = instantOf(row.date, row.start_min, hours.zone).getTime();
  const { expiry } = await installHoldPolicy();
  const next = new Date(Math.min(new Date(row.confirm_by).getTime() + expiry.extendHours * 3_600_000, start));
  if (next.getTime() <= new Date(row.confirm_by).getTime()) return refuse("LAD3_NO_EXTENSION");
  const done = await db
    .prepare("UPDATE ladder_court_holds SET confirm_by = ?::timestamptz, extended_at = now(), extended_by = ?, extend_note = ? WHERE id = ? AND released_at IS NULL AND confirmed_at IS NULL AND confirm_by > now()")
    .run(next.toISOString(), by, reason, row.id);
  if (done.changes !== 1) return refuse("LAD3_EXPIRED");
  await db.prepare("UPDATE claims SET expires_at = ?::timestamptz WHERE kind = 'block' AND block_id IN (SELECT id FROM blocks WHERE ladder_hold_id = ?)").run(next.toISOString(), row.id);
  const view = (await holdViews([challengeId])).get(challengeId);
  return view ? { ok: true, hold: view } : refuse("LAD3_EXPIRED");
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

/**
 * The scheduler's half of expiry: holds nobody confirmed in time are let go (`sweepExpiredHolds`, which every claim and every hold made also runs), and
 * the ones whose two players have not yet been told are returned, once each (`markExpiryTold`). Running it again returns nothing new.
 */
export async function expiredHoldsToTell(): Promise<{ id: number; challengeId: number; ladderId: number; courtId: number | null; date: string; startMin: number }[]> {
  await sweepExpiredHolds();
  const rows = (await getDb()
    .prepare("SELECT id, challenge_id, ladder_id, court_id, date, start_min FROM ladder_court_holds WHERE released_reason = 'expired' AND expiry_told_at IS NULL ORDER BY id")
    .all()) as { id: number; challenge_id: number; ladder_id: number; court_id: number | null; date: string; start_min: number }[];
  return rows.map((r) => ({ id: r.id, challengeId: r.challenge_id, ladderId: r.ladder_id, courtId: r.court_id, date: r.date, startMin: r.start_min }));
}

/** Claim the telling of one expiry: true for the one caller that gets to tell, so two schedulers never tell the players twice. */
export async function markExpiryTold(holdId: number): Promise<boolean> {
  const done = await getDb().prepare("UPDATE ladder_court_holds SET expiry_told_at = now() WHERE id = ? AND expiry_told_at IS NULL").run(holdId);
  return done.changes === 1;
}
