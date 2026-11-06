import type { Admin } from "./admin-auth";
import { getDb } from "./db";
import { notifyBookingNeedsAttention } from "./notify";
import { bookingPlaces, CUSTOMER_TAKES_PART, PARTICIPANT_TAKES_PART, placesInducted } from "./participants";
import { signOffHolds, type SignOff } from "./sign-offs";
import { courtAccess, getBookingById, getCourt, signOffNeeded } from "./store";
import { todayISO } from "./time";
import type { Induction, Sport } from "./types";

/**
 * Confirmed bookings that a venue's own decision left in doubt after they were made, for staff to decide, never cancelled
 * silently (ADR 0058; docs/features/venue-operations.md#bookings-that-need-a-decision). The pattern of a revoked approval's
 * (lib/approvals.ts) and a membership's (lib/membership-flags.ts), in one list:
 *
 * - `blocked`: the venue refused the number after it booked. The door code, QR check-in and unstaffed access stop at once
 *   (lib/store.ts `accessCodeFor`, `checkInByToken`); the bookings that remain are listed for the manager to cancel with a
 *   refund or leave.
 * - `eligibility`: a sign-off, certification or induction was taken back. The person's upcoming bookings it affects are flagged
 *   with who, when and why, and the customer is told once. A staffed venue's flagged booking is not blocked (the desk is
 *   there); the door code waits for the decision at an unstaffed hour.
 *
 * No personal data of its own: the person is the booking's.
 */

export type SafetyFlagKind = "blocked" | "eligibility";
export type EligibilityWhat = "sign-off" | "certification" | "induction";

export interface SafetyFlag {
  id: number;
  kind: SafetyFlagKind;
  /** What was taken back, or `blocked`. */
  what: string;
  /** Why, as the member of staff said it; for a blocked number, the reason on the block. */
  reason: string | null;
  /** Who took it back. */
  by: string | null;
  createdAt: string;
  /** The customer was told (once); false when they could not be reached by email: staff tell them. */
  told: boolean;
  venueId: number;
  venueName: string;
  bookingCode: string;
  name: string;
  phone: string;
  date: string;
  start: number;
  end: number;
  courtName: string;
  paid: boolean;
  classId: number | null;
}

const isoOf = (v: unknown): string => (v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : String(v));

/** Confirmed bookings of a number at a venue that have not ended yet. */
async function upcomingOfNumber(venueId: number, phone: string): Promise<{ id: number }[]> {
  return (await getDb()
    .prepare(
      `SELECT b.id FROM bookings b JOIN courts c ON c.id = b.court_id
        WHERE c.venue_id = ? AND b.phone_key = phone_key(?) AND b.status = 'confirmed'
          AND (b.ends_at > now() OR (b.ends_at IS NULL AND b.date >= ?))
        ORDER BY b.date, b.start_min`
    )
    .all(venueId, phone, todayISO())) as { id: number }[];
}

async function insertFlag(bookingId: number, venueId: number, kind: SafetyFlagKind, what: string, reason: string | null, by: string | null): Promise<boolean> {
  const done = await getDb()
    .prepare(
      `INSERT INTO booking_safety_flags (booking_id, venue_id, kind, what, reason, by_name) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (booking_id, kind, what) WHERE resolved_at IS NULL DO NOTHING`
    )
    .run(bookingId, venueId, kind, what, reason, by);
  return done.changes > 0;
}

/** How many confirmed bookings a number has coming up at a venue: what the manager is shown when refusing it. */
export async function upcomingBookingsOfNumber(venueId: number, phone: string): Promise<number> {
  return (await upcomingOfNumber(venueId, phone)).length;
}

/**
 * A number the venue has just refused: its upcoming confirmed bookings there are listed for the manager to decide, none
 * cancelled. Returns how many (each once, however often asked).
 */
export async function flagBlockedNumber(venueId: number, phone: string, by: string): Promise<number> {
  const rows = await upcomingOfNumber(venueId, phone);
  for (const b of rows) await insertFlag(b.id, venueId, "blocked", "blocked", null, by);
  return rows.length;
}

/** A number taken off the refused list: what was listed for it is no longer in question. */
export async function clearBlockedFlags(venueId: number, phone: string, by: string): Promise<void> {
  await getDb()
    .prepare(
      `UPDATE booking_safety_flags SET resolved_at = now(), resolved_by = ?, resolution = 'The number was taken off the refused list'
        WHERE kind = 'blocked' AND venue_id = ? AND resolved_at IS NULL
          AND booking_id IN (SELECT id FROM bookings WHERE phone_key = phone_key(?))`
    )
    .run(by, venueId, phone);
}

/** The person whose eligibility was taken back: the number holder's own, or a participant's (lib/participants.ts). */
export interface Person {
  phone: string;
  userId: number | null;
  participantId: number | null;
}

async function bookedBy(bookingId: number): Promise<number | null> {
  return ((await getDb().prepare("SELECT user_id FROM bookings WHERE id = ?").get(bookingId)) as { user_id: number | null } | undefined)?.user_id ?? null;
}

/**
 * Something that let this person take part (a sign-off, a certification, an induction) was taken back. Their upcoming
 * confirmed bookings at `venueIds` that it affects, and that nothing else still covers, are flagged for staff with what, who
 * and why, and the customer is told once by email; none is cancelled. For a sign-off or certification: the bookings of the
 * activity it was for (`sport` null: any) on a resource whose activity asks for one; for an induction: bookings on a
 * resource with a door code. Returns how many bookings were flagged.
 */
export async function flagLostEligibility(input: {
  venueIds: number[];
  what: EligibilityWhat;
  sport: Sport | null;
  person: Person;
  reason: string | null;
  by: Pick<Admin, "name">;
}): Promise<number> {
  if (input.venueIds.length === 0) return 0;
  const { person } = input;
  const who =
    person.participantId !== null
      ? { sql: PARTICIPANT_TAKES_PART("b"), args: [person.participantId] as unknown[] }
      : { sql: `(b.user_id = ? OR b.phone_key = phone_key(?)) AND ${CUSTOMER_TAKES_PART("b")}`, args: [person.userId ?? -1, person.phone] as unknown[] };
  const anySport = input.what === "induction" || input.sport === null;
  const candidates = (await getDb()
    .prepare(
      `SELECT b.id FROM bookings b JOIN courts c ON c.id = b.court_id
        WHERE c.venue_id IN (${input.venueIds.map(() => "?").join(",")}) AND b.status = 'confirmed'
          AND (b.ends_at > now() OR (b.ends_at IS NULL AND b.date >= ?))
          AND (?::boolean OR b.sport = ?) AND (?::boolean OR c.unmanned = 1) AND ${who.sql}
        ORDER BY b.date, b.start_min`
    )
    .all(...input.venueIds, todayISO(), anySport, input.sport ?? "", input.what !== "induction", ...who.args)) as { id: number }[];
  const flagged: number[] = [];
  for (const row of candidates) {
    const booking = await getBookingById(row.id);
    const court = booking ? await getCourt(booking.courtId) : null;
    if (!booking || !court) continue;
    const by = await bookedBy(booking.id);
    if (input.what === "induction") {
      if (!court.unmanned || (await courtAccess(court.id)).code === null) continue;
      if (await placesInducted(court.venueId, { id: booking.id, phone: booking.phone, userId: by })) continue;
    } else {
      const need = await signOffNeeded(court, court.venueId, booking.sport);
      if (!need || (need === "certification" && input.what !== "certification")) continue;
      // Still covered by another sign-off (the venue's own, the business's, a later one): nothing was taken away.
      const covered = await signOffHolds({
        venueId: court.venueId,
        sport: booking.sport,
        until: booking.date,
        phone: booking.phone,
        userId: by,
        channel: "staff",
        need,
        participant: person.participantId,
      });
      if (covered) continue;
    }
    if (await insertFlag(booking.id, court.venueId, "eligibility", input.what, input.reason, input.by.name)) flagged.push(row.id);
  }
  for (const id of flagged) await tellCustomerOnce(id);
  return flagged.length;
}

/**
 * A sign-off or certification was taken back in the Sign-offs tab (lib/sign-offs.ts `revokeSignOff`): the person's upcoming
 * bookings it affected are flagged and the customer told once. One an approval wrote is left to the approval's own
 * revocation (lib/approvals.ts `signOffRevoked`), which flags its bookings the same way. Returns how many were flagged.
 */
export async function signOffTakenBack(so: SignOff, admin: Pick<Admin, "name">, reason: string | null): Promise<number> {
  const db = getDb();
  if (await db.prepare("SELECT 1 AS x FROM approval_requests WHERE sign_off_id = ?").get(so.id)) return 0;
  const venueIds =
    so.businessId !== null
      ? ((await db.prepare("SELECT id FROM venues WHERE business_id = ?").all(so.businessId)) as { id: number }[]).map((v) => v.id)
      : so.venueId !== null
        ? [so.venueId]
        : [];
  return flagLostEligibility({
    venueIds,
    what: so.kind === "certification" ? "certification" : "sign-off",
    sport: so.sport,
    person: { phone: so.phone, userId: so.userId, participantId: so.managedPersonId },
    reason,
    by: admin,
  });
}

/** An induction was withdrawn (lib/store.ts `revokeInduction`): the person's upcoming bookings at a time the door is the way in are flagged. */
export async function inductionTakenBack(induction: Induction, admin: Pick<Admin, "name">): Promise<number> {
  return flagLostEligibility({
    venueIds: [induction.venueId],
    what: "induction",
    sport: null,
    person: { phone: induction.phone, userId: null, participantId: induction.forParticipant ? (induction.participantId ?? null) : null },
    reason: null,
    by: admin,
  });
}

/** The customer of a flagged booking, told once by email what was taken back and that the venue will be in touch. */
async function tellCustomerOnce(bookingId: number): Promise<void> {
  const db = getDb();
  const flag = (await db
    .prepare("SELECT id, what, reason FROM booking_safety_flags WHERE booking_id = ? AND kind = 'eligibility' AND resolved_at IS NULL AND told_at IS NULL ORDER BY id DESC LIMIT 1")
    .get(bookingId)) as { id: number; what: EligibilityWhat; reason: string | null } | undefined;
  const booking = flag ? await getBookingById(bookingId) : null;
  if (!flag || !booking) return;
  try {
    const sent = await notifyBookingNeedsAttention(booking, flag.what, flag.reason, flag.id);
    if (sent) await db.prepare("UPDATE booking_safety_flags SET told_at = now() WHERE id = ? AND told_at IS NULL").run(flag.id);
  } catch (err) {
    console.error(`[mysenam] could not tell the customer of booking ${booking.code} what was taken back:`, err);
  }
}

/**
 * Re-checked after a sign-off, certification or induction is recorded: a flag whose booking is covered again is settled
 * ("granted again"), so a door code does not wait on a decision nobody needs to make.
 */
export async function settleCoveredFlags(venueId: number): Promise<number> {
  const db = getDb();
  const open = (await db
    .prepare("SELECT f.id, f.what, f.booking_id FROM booking_safety_flags f WHERE f.venue_id = ? AND f.kind = 'eligibility' AND f.resolved_at IS NULL")
    .all(venueId)) as { id: number; what: EligibilityWhat; booking_id: number }[];
  let settled = 0;
  for (const f of open) {
    const booking = await getBookingById(f.booking_id);
    const court = booking ? await getCourt(booking.courtId) : null;
    if (!booking || !court) continue;
    const by = await bookedBy(booking.id);
    let covered: boolean;
    if (f.what === "induction") covered = await placesInducted(court.venueId, { id: booking.id, phone: booking.phone, userId: by });
    else {
      const need = await signOffNeeded(court, court.venueId, booking.sport);
      covered = true;
      if (need)
        for (const place of await bookingPlaces(booking.id))
          covered =
            covered &&
            (await signOffHolds({
              venueId: court.venueId,
              sport: booking.sport,
              until: booking.date,
              phone: booking.phone,
              userId: by,
              channel: "staff",
              need,
              participant: place.customer ? null : place.participantId,
            }));
    }
    if (!covered) continue;
    const done = await db
      .prepare("UPDATE booking_safety_flags SET resolved_at = now(), resolved_by = 'MySenam', resolution = 'Granted again' WHERE id = ? AND resolved_at IS NULL")
      .run(f.id);
    if (done.changes > 0) settled++;
  }
  return settled;
}

/** The flags still to be decided at these venues (null: all), on bookings that are still confirmed and not over. */
export async function safetyFlags(venueIds: number[] | null): Promise<SafetyFlag[]> {
  if (venueIds && venueIds.length === 0) return [];
  const only = venueIds ? ` AND f.venue_id IN (${venueIds.map(() => "?").join(",")})` : "";
  const rows = (await getDb()
    .prepare(
      `SELECT f.id, f.kind, f.what, f.reason, f.by_name, f.created_at, f.told_at, f.venue_id, v.name AS venue_name, b.code, b.name, b.phone,
              b.date, b.start_min, b.end_min, c.name AS court_name, b.payment_status, b.class_id, vb.reason AS block_reason
         FROM booking_safety_flags f
         JOIN bookings b ON b.id = f.booking_id
         JOIN courts c ON c.id = b.court_id
         JOIN venues v ON v.id = f.venue_id
         LEFT JOIN venue_blocked_phones vb ON vb.venue_id = f.venue_id AND vb.phone_key = b.phone_key AND f.kind = 'blocked'
        WHERE f.resolved_at IS NULL AND b.status = 'confirmed' AND (b.ends_at > now() OR (b.ends_at IS NULL AND b.date >= ?))${only}
        ORDER BY b.date, b.start_min, f.id LIMIT 200`
    )
    .all(todayISO(), ...(venueIds ?? []))) as {
    id: number;
    kind: SafetyFlagKind;
    what: string;
    reason: string | null;
    by_name: string | null;
    created_at: unknown;
    told_at: unknown;
    venue_id: number;
    venue_name: string;
    code: string;
    name: string;
    phone: string;
    date: string;
    start_min: number;
    end_min: number;
    court_name: string;
    payment_status: string;
    class_id: number | null;
    block_reason: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    what: r.what,
    reason: r.kind === "blocked" ? r.block_reason : r.reason,
    by: r.by_name,
    createdAt: isoOf(r.created_at),
    told: r.told_at !== null && r.told_at !== undefined,
    venueId: r.venue_id,
    venueName: r.venue_name,
    bookingCode: r.code,
    name: r.name,
    phone: r.phone,
    date: r.date,
    start: r.start_min,
    end: r.end_min,
    courtName: r.court_name,
    paid: r.payment_status === "paid",
    classId: r.class_id,
  }));
}

/** The venue a flag belongs to, for the access check. */
export async function safetyFlagVenue(flagId: number): Promise<number | null> {
  const row = (await getDb().prepare("SELECT venue_id FROM booking_safety_flags WHERE id = ?").get(flagId)) as { venue_id: number } | undefined;
  return row?.venue_id ?? null;
}

/** Staff decided to leave the booking as it is (or dealt with it another way): on record, with a note. */
export async function resolveSafetyFlag(admin: Pick<Admin, "name">, flagId: number, note: unknown): Promise<boolean> {
  const text = typeof note === "string" && note.trim() !== "" ? note.trim().slice(0, 300) : null;
  if (!text) return false;
  const done = await getDb()
    .prepare("UPDATE booking_safety_flags SET resolved_at = now(), resolved_by = ?, resolution = ? WHERE id = ? AND resolved_at IS NULL")
    .run(admin.name, text, flagId);
  return done.changes === 1;
}
