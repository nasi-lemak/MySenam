import { getDb, withTransaction } from "./db";
import { LATEST_MINUTE, freeWithin, instantOf, merge, minuteOfDay, overlaps, rangeLiteral, type Span } from "./interval";

/**
 * Claims: everything that occupies a court's time, as exact intervals
 * (db/migrations/0089; ADR 0010). This module writes and reads them; what is
 * allowed to be booked is lib/booking-policy.ts, and the business rules
 * around a booking are lib/store.ts.
 *
 * The database is what refuses a double booking: the exclusion constraint
 * on spaces, and the capacity trigger on shared facilities, raise `23P01`
 * however the claim was written. Everything here that reads is for showing
 * and choosing; nothing that reads is trusted to have kept a conflict out.
 */

export type ClaimKind = "booking" | "offer" | "class" | "block" | "outage" | "move";

/** What a claim belongs to. */
export type ClaimSource =
  | { kind: "booking"; bookingId: number }
  | { kind: "offer"; waitlistId: number }
  | { kind: "class"; classId: number }
  | { kind: "block"; blockId: number }
  | { kind: "outage"; outageId: number }
  /** A proposed new time for an open game's booking, held while its players answer (lib/game-moves.ts). */
  | { kind: "move"; moveId: number };

/** A court as claims need it. */
export interface ClaimCourt {
  id: number;
  venueId: number;
  capacity: number;
}

/** Did the database refuse this for overlapping something, or for want of room? */
export function isConflict(err: unknown): boolean {
  return (err as { code?: string } | null)?.code === "23P01";
}

/**
 * The spaces a court covers: its own, and those of courts it lies over.
 * Shared facilities have none. The database gives a court its own space
 * when it is made or its capacity changes (trigger `courts_own_space`);
 * links add other courts' spaces (lib/court-links.ts).
 */
export async function spacesOf(courtId: number): Promise<number[]> {
  const rows = (await getDb().prepare("SELECT space_id FROM court_spaces WHERE court_id = ? ORDER BY space_id").all(courtId)) as {
    space_id: number;
  }[];
  return rows.map((r) => r.space_id);
}

/**
 * Claims on the same thing queue rather than deadlock (B14). Two transactions
 * inserting overlapping claims at once each see the other's uncommitted row
 * under the exclusion constraint and wait for each other; Postgres breaks that
 * after a second by killing one, and the retries meet again. So before writing,
 * a transaction takes a lock on each space (or shared court, or coach) it is
 * about to claim, always in ascending order within each kind, spaces before
 * courts before coaches: the second one waits for the first to finish, then
 * finds the time taken and is refused at once. Transaction-scoped advisory
 * locks: released at commit or rollback, nothing stored.
 */
const LOCK = { space: 1, court: 2, coach: 3 } as const;

async function lockAll(kind: keyof typeof LOCK, ids: number[]): Promise<void> {
  const db = getDb();
  for (const id of [...new Set(ids)].sort((a, b) => a - b)) await db.prepare("SELECT pg_advisory_xact_lock(?, ?)").get(LOCK[kind], id);
}

/** Lock what claims on these courts would take: their spaces, or the courts themselves where they sell places. */
export async function lockCourts(courts: ClaimCourt[]): Promise<void> {
  const exclusive = courts.filter((c) => c.capacity === 1).map((c) => c.id);
  if (exclusive.length > 0) {
    const rows = (await getDb()
      .prepare(`SELECT space_id FROM court_spaces WHERE court_id IN (${exclusive.map(() => "?").join(",")})`)
      .all(...exclusive)) as { space_id: number }[];
    await lockAll("space", rows.map((r) => r.space_id));
  }
  await lockAll("court", courts.filter((c) => c.capacity > 1).map((c) => c.id));
}

/** Lock a coach's time before claiming it (after any court, so the order holds). */
export async function lockCoach(coachId: number): Promise<void> {
  await lockAll("coach", [coachId]);
}

const SOURCE_COLUMN: Record<ClaimKind, string> = {
  booking: "booking_id",
  offer: "waitlist_id",
  class: "class_id",
  block: "block_id",
  outage: "outage_id",
  move: "move_id",
};
const sourceId = (s: ClaimSource): number =>
  s.kind === "booking"
    ? s.bookingId
    : s.kind === "offer"
      ? s.waitlistId
      : s.kind === "class"
        ? s.classId
        : s.kind === "block"
          ? s.blockId
          : s.kind === "move"
            ? s.moveId
            : s.outageId;

/**
 * Claim `span` of business day `date` on a court for `source`: each of its
 * spaces, or `places` of a shared facility. Throws the database's `23P01`
 * when anything is in the way (see `isConflict`); run it inside the
 * transaction that writes what it belongs to.
 */
export async function claim(input: {
  court: ClaimCourt;
  source: ClaimSource;
  date: string;
  span: Span;
  zone: string;
  bufferBefore?: number;
  bufferAfter?: number;
  /** For a shared facility: how many places (a booking takes one; a class or a whole block, all). */
  places?: number;
  expiresAt?: Date | null;
  /** An open-ended claim (an outage with no last day). */
  openEnded?: boolean;
}): Promise<void> {
  const db = getDb();
  const before = input.bufferBefore ?? 0;
  const after = input.bufferAfter ?? 0;
  const during = input.openEnded
    ? `[${instantOf(input.date, input.span.start, input.zone).toISOString()},)`
    : rangeLiteral(input.date, input.span.start, input.span.end, input.zone);
  const occupied = input.openEnded
    ? `[${instantOf(input.date, input.span.start - before, input.zone).toISOString()},)`
    : rangeLiteral(input.date, input.span.start - before, input.span.end + after, input.zone);
  const column = SOURCE_COLUMN[input.source.kind];
  const expires = input.expiresAt ? input.expiresAt.toISOString() : null;
  const spaces = input.court.capacity === 1 ? await spacesOf(input.court.id) : [];
  if (input.court.capacity === 1) await lockAll("space", spaces);
  else await lockAll("court", [input.court.id]);
  if (input.court.capacity === 1) {
    if (spaces.length === 0) throw new Error(`Court ${input.court.id} has no space`);
    const insert = async () => {
      for (const space of spaces)
        await db
          .prepare(
            `INSERT INTO claims (venue_id, court_id, space_id, kind, ${column}, during, occupied, buffer_before, buffer_after, expires_at)
             VALUES (?, ?, ?, ?, ?, ?::tstzrange, ?::tstzrange, ?, ?, ?)`
          )
          .run(input.court.venueId, input.court.id, space, input.source.kind, sourceId(input.source), during, occupied, before, after, expires);
    };
    // The constraint cannot see the clock, so an offer (or a proposed move)
    // past its time can still be in the way: only then are such holds let go,
    // and the claim tried once more. Reading for them on every claim made
    // bookings conflict (B13).
    try {
      await withTransaction(insert);
    } catch (err) {
      if (!isConflict(err) || (await releaseExpiredOffers(input.court.id)) === 0) throw err;
      await insert();
    }
  } else {
    // The capacity check already ignores offers past their time.
    await db
      .prepare(
        `INSERT INTO claims (venue_id, court_id, places, kind, ${column}, during, occupied, buffer_before, buffer_after, expires_at)
         VALUES (?, ?, ?, ?, ?, ?::tstzrange, ?::tstzrange, ?, ?, ?)`
      )
      .run(
        input.court.venueId,
        input.court.id,
        Math.min(input.places ?? 1, input.court.capacity),
        input.source.kind,
        sourceId(input.source),
        during,
        occupied,
        before,
        after,
        expires
      );
  }
}

/** Let a source's time go: a cancelled booking, a lapsed offer, a removed block. */
export async function release(source: ClaimSource): Promise<number> {
  const done = await getDb()
    .prepare(`UPDATE claims SET active = false WHERE ${SOURCE_COLUMN[source.kind]} = ? AND active`)
    .run(sourceId(source));
  return done.changes;
}

/** A booking's hold on its court, and on its coach, let go: cancelled, released unpaid, or erased. */
export async function releaseBooking(bookingId: number): Promise<void> {
  await release({ kind: "booking", bookingId });
  await getDb().prepare("UPDATE coach_claims SET active = false WHERE booking_id = ? AND active").run(bookingId);
}

/** Remove a source's claims altogether, to claim again (a moved booking, a narrowed block). */
export async function unclaim(source: ClaimSource): Promise<void> {
  await getDb().prepare(`DELETE FROM claims WHERE ${SOURCE_COLUMN[source.kind]} = ?`).run(sourceId(source));
}

/** Waiting-list offers and proposed moves past their time stop holding anything. */
export async function releaseExpiredOffers(courtId?: number): Promise<number> {
  const done = await getDb()
    .prepare(
      `UPDATE claims SET active = false
        WHERE active AND kind IN ('offer', 'move') AND expires_at <= now()
          ${courtId === undefined ? "" : "AND (court_id = ? OR space_id IN (SELECT space_id FROM court_spaces WHERE court_id = ?))"}`
    )
    .run(...(courtId === undefined ? [] : [courtId, courtId]));
  return done.changes;
}

/** Something holding a court's time on a day, in that day's minutes. */
export interface Occupant {
  kind: ClaimKind;
  bookingId: number | null;
  classId: number | null;
  blockId: number | null;
  outageId: number | null;
  waitlistId: number | null;
  moveId: number | null;
  /** The court the claim was made on: this court, or one it shares space with. */
  viaCourt: number;
  /** Places it holds of a shared facility; 1 for space. */
  places: number;
  /** The time sold or held. */
  span: Span;
  /** That time with its buffers: what keeps the court from anybody else. */
  occupied: Span;
  bufferBefore: number;
  bufferAfter: number;
}

/**
 * What holds each court's time on business day `date` (and anything running
 * into it from the day before), as minutes of that day. A court over others
 * sees what holds their spaces; a court under another sees the big court's
 * bookings. One occupant per thing, however many spaces it took.
 */
export async function occupantsOn(
  courts: ClaimCourt[],
  date: string,
  zone: string | ((venueId: number) => string)
): Promise<Map<number, Occupant[]>> {
  const out = new Map<number, Occupant[]>(courts.map((c) => [c.id, []]));
  if (courts.length === 0) return out;
  const zoneOf = (venueId: number) => (typeof zone === "string" ? zone : zone(venueId));
  const exclusive = courts.filter((c) => c.capacity === 1).map((c) => c.id);
  const shared = courts.filter((c) => c.capacity > 1).map((c) => c.id);
  // The business day and the small hours after it; claims are compared by the moment, not the date.
  const venues = [...new Set(courts.map((c) => c.venueId))];
  const windows = new Map(
    venues.map((v) => [
      v,
      `[${instantOf(date, -24 * 60, zoneOf(v)).toISOString()},${instantOf(date, LATEST_MINUTE + 24 * 60, zoneOf(v)).toISOString()})`,
    ])
  );
  const db = getDb();
  type Row = {
    for_court: number;
    kind: ClaimKind;
    court_id: number;
    booking_id: number | null;
    class_id: number | null;
    block_id: number | null;
    outage_id: number | null;
    waitlist_id: number | null;
    move_id: number | null;
    places: number | null;
    lo: number;
    hi: number | null;
    olo: number;
    ohi: number | null;
    buffer_before: number;
    buffer_after: number;
  };
  // Moments as epoch milliseconds: numbers are much quicker to read than timestamps.
  const ms = (e: string) => `(extract(epoch FROM ${e}) * 1000)::float8`;
  const cols = `c.kind, c.court_id, c.booking_id, c.class_id, c.block_id, c.outage_id, c.waitlist_id, c.move_id, c.places,
    ${ms("lower(c.during)")} AS lo, ${ms("upper(c.during)")} AS hi, ${ms("lower(c.occupied)")} AS olo, ${ms("upper(c.occupied)")} AS ohi,
    c.buffer_before, c.buffer_after`;
  const live = "c.active AND (c.expires_at IS NULL OR c.expires_at > now())";
  const rows: Row[] = [];
  // Two queries whatever the number of courts or venues: each court asked
  // about with its venue's window, and its claims read by space or court
  // first, then time (idx_claims_space_ends, idx_claims_court_ends). Reading
  // by time alone read every claim in the marketplace for that day (B12).
  const byId = new Map(courts.map((c) => [c.id, c]));
  const windowOf = (courtId: number) => windows.get(byId.get(courtId)!.venueId)!;
  if (exclusive.length)
    rows.push(
      ...((await db
        .prepare(
          `SELECT DISTINCT x.court AS for_court, ${cols}
             FROM unnest(?::int[], ?::tstzrange[]) AS x(court, win)
             JOIN court_spaces cs ON cs.court_id = x.court
             CROSS JOIN LATERAL (
               SELECT * FROM claims c
                WHERE c.space_id = cs.space_id AND COALESCE(upper(c.occupied), 'infinity'::timestamptz) > lower(x.win)
                  AND c.active AND c.space_id IS NOT NULL AND c.occupied && x.win
             ) c
            WHERE ${live}`
        )
        .all(exclusive, exclusive.map(windowOf))) as Row[])
    );
  if (shared.length)
    rows.push(
      ...((await db
        .prepare(
          `SELECT x.court AS for_court, ${cols}
             FROM unnest(?::int[], ?::tstzrange[]) AS x(court, win)
             CROSS JOIN LATERAL (
               SELECT * FROM claims c
                WHERE c.court_id = x.court AND COALESCE(upper(c.occupied), 'infinity'::timestamptz) > lower(x.win)
                  AND c.active AND c.space_id IS NULL AND c.occupied && x.win
             ) c
            WHERE ${live}`
        )
        .all(shared, shared.map(windowOf))) as Row[])
    );
  const seen = new Set<string>();
  for (const r of rows) {
    const court = byId.get(r.for_court)!;
    const key = `${r.for_court}|${r.kind}|${r.booking_id ?? r.class_id ?? r.block_id ?? r.outage_id ?? r.waitlist_id ?? r.move_id}|${r.lo}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const z = zoneOf(court.venueId);
    const m = (at: number | null, open: number) => (at === null ? open : minuteOfDay(new Date(at), date, z));
    out.get(r.for_court)!.push({
      kind: r.kind,
      bookingId: r.booking_id,
      classId: r.class_id,
      blockId: r.block_id,
      outageId: r.outage_id,
      waitlistId: r.waitlist_id,
      moveId: r.move_id,
      viaCourt: r.court_id,
      places: court.capacity === 1 ? 1 : (r.places ?? 1),
      span: { start: m(r.lo, -Infinity), end: m(r.hi, Infinity) },
      occupied: { start: m(r.olo, -Infinity), end: m(r.ohi, Infinity) },
      bufferBefore: Number(r.buffer_before),
      bufferAfter: Number(r.buffer_after),
    });
  }
  for (const list of out.values()) list.sort((a, b) => a.occupied.start - b.occupied.start);
  return out;
}

/** The most places held at any moment within `span` (for a court of one place: 1 if anything is there). */
export function peakPlaces(occupants: Occupant[], span: Span, ignore?: (o: Occupant) => boolean): number {
  const edges: [number, number][] = [];
  for (const o of occupants) {
    if (ignore?.(o) || !overlaps(o.occupied, span)) continue;
    edges.push([Math.max(o.occupied.start, span.start), o.places], [Math.min(o.occupied.end, span.end), -o.places]);
  }
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let load = 0;
  let peak = 0;
  for (const [, d] of edges) {
    load += d;
    peak = Math.max(peak, load);
  }
  return peak;
}

/**
 * Would a booking from `span.start` to `span.end`, with its buffers, fit
 * among these occupants on a court of `capacity`? The same question the
 * database answers when it is written; asked here to show and to choose.
 */
export function fits(
  occupants: Occupant[],
  capacity: number,
  span: Span,
  buffers: { before: number; after: number },
  ignore?: (o: Occupant) => boolean,
  /** Places the new claim takes on a shared facility: several kayaks, several people on a floor. A court held whole takes itself, however many play. */
  places = 1
): boolean {
  const occupied = { start: span.start - buffers.before, end: span.end + buffers.after };
  return peakPlaces(occupants, occupied, ignore) + (capacity > 1 ? places : 1) <= capacity;
}

/** The stretches of `within` nothing occupies at all (for a court of one place). */
export function freeStretches(occupants: Occupant[], within: Span): Span[] {
  return freeWithin(within, merge(occupants.map((o) => o.occupied)));
}
