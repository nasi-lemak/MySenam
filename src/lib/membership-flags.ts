import { getDb } from "./db";
import { inSameBusiness } from "./branches";
import { memberCover, takesPlaces } from "./entitlements";
import { CUSTOMER_TAKES_PART } from "./participants";
import { todayISO } from "./time";

const isoOf = (v: unknown): string => (v === null || v === undefined ? "" : v instanceof Date ? v.toISOString() : String(v));

/**
 * When a membership stops covering somebody (the owner's decision of
 * 27 October 2026; docs/features/pricing.md#when-a-membership-stops): it is
 * cancelled by staff, voided by a chargeback, or a family membership's
 * dependant is taken off it. A paid booking is never cancelled or taken
 * silently. Their confirmed bookings from today on at a members-only venue
 * of its business that it no longer covers are flagged for staff, in the
 * pattern of a revoked approval's (lib/approvals.ts, ADR 0020): staff
 * cancel one on the venue's normal terms (the cancellation and refund policy
 * apply only then), admit them at the desk, or keep it, and say which.
 *
 * Which bookings: a place on a members' session (a members-only venue's
 * shared-capacity session or class) that the holder, or a participant it
 * covered, takes, on a date no other membership covers them (`place`); and a
 * resource the holder reserved whole there (`reservation`): reserving is
 * the account's privilege, checked when it was made, so such a booking
 * stands, and is flagged only so staff know. Self check-in and the door
 * refuse a `place` whatever the flag (lib/entitlements.ts
 * `participationLapses`); a `reservation` is not barred.
 */

export type MembershipFlagReason = "cancelled" | "revoked" | "uncovered";

interface MembershipRow {
  id: number;
  venue_id: number;
  holder_kind: "customer" | "participant";
  holder_phone: string;
  holder_name: string;
  holder_participant_id: number | null;
  user_id: number | null;
}

/**
 * Flag the bookings a membership no longer covers, after it was cancelled
 * (`cancelled`), voided by a chargeback (`revoked`), or (`uncovered`) the
 * participants `only` were taken off it. Asked after the change, so another
 * membership still covering somebody on the day leaves their booking alone.
 * Returns how many bookings were flagged (each once per membership and
 * person, however often asked).
 */
export async function flagAfterMembershipLoss(membershipId: number, reason: MembershipFlagReason, only?: number[]): Promise<number> {
  const db = getDb();
  const m = (await db
    .prepare("SELECT id, venue_id, holder_kind, holder_phone, holder_name, holder_participant_id, user_id FROM memberships WHERE id = ?")
    .get(membershipId)) as MembershipRow | undefined;
  if (!m) return 0;
  const covered = only
    ? only
    : [
        ...(m.holder_kind === "participant" && m.holder_participant_id !== null ? [m.holder_participant_id] : []),
        ...((await db.prepare("SELECT participant_id FROM membership_participants WHERE membership_id = ?").all(m.id)) as { participant_id: number }[]).map(
          (r) => r.participant_id
        ),
      ];
  const today = todayISO();
  const where = `c.venue_id IN (SELECT v.id FROM venues v WHERE v.access = 'members' AND ${inSameBusiness("v.id")})
                 AND b.status = 'confirmed' AND b.date >= ?`;
  type Candidate = { id: number; venue_id: number; date: string; capacity: number; class_id: number | null; phone: string; user_id: number | null; pid: number | null; pname: string | null };
  const found: Candidate[] = [];
  // A participant it covered: every place they take on a members' session, whoever booked it.
  for (const pid of covered)
    found.push(
      ...((await db
        .prepare(
          `SELECT b.id, c.venue_id, b.date, c.capacity, b.class_id, b.phone, b.user_id, bp.participant_id AS pid, bp.name AS pname
             FROM bookings b JOIN courts c ON c.id = b.court_id JOIN booking_participants bp ON bp.booking_id = b.id AND bp.participant_id = ?
            WHERE ${where}`
        )
        .all(pid, m.venue_id, today)) as Candidate[])
    );
  // The number's holder: their own bookings (by the number, or the account it is linked to).
  if (!only && m.holder_kind === "customer" && m.holder_phone)
    found.push(
      ...((await db
        .prepare(
          `SELECT b.id, c.venue_id, b.date, c.capacity, b.class_id, b.phone, b.user_id, NULL::integer AS pid, b.name AS pname
             FROM bookings b JOIN courts c ON c.id = b.court_id
            WHERE ${where} AND (b.phone_key = phone_key(?) OR (b.user_id IS NOT NULL AND b.user_id = ?))`
        )
        .all(m.venue_id, today, m.holder_phone, m.user_id ?? 0)) as Candidate[])
    );

  const flagged = new Set<number>();
  for (const b of found) {
    const places = takesPlaces({ capacity: Number(b.capacity) }, b.class_id);
    let kind: "place" | "reservation";
    if (b.pid !== null) {
      if (!places) continue; // A court reserved whole is its booker's privilege, not the participant's.
      kind = "place";
    } else if (places) {
      // The holder's own place, where they take one on it.
      const takesPart = await db.prepare(`SELECT 1 AS n FROM bookings b WHERE b.id = ? AND ${CUSTOMER_TAKES_PART("b")}`).get(b.id);
      if (!takesPart) continue;
      kind = "place";
    } else kind = "reservation";
    // Still covered that day by another membership (or the venue's list): nothing to flag.
    const cover = await memberCover(b.venue_id, { participantId: b.pid, name: b.pname ?? "" }, b.pid === null ? { phone: b.phone, userId: b.user_id } : null, b.date);
    if (cover.covered) continue;
    const added = await db
      .prepare(
        `INSERT INTO membership_booking_flags (membership_id, booking_id, venue_id, participant_id, person_name, reason, kind)
         VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`
      )
      .run(m.id, b.id, b.venue_id, b.pid, b.pname ?? m.holder_name, reason, kind);
    if (added.changes > 0) flagged.add(b.id);
  }
  return flagged.size;
}

export interface MembershipFlag {
  id: number;
  membershipId: number;
  membershipCode: string;
  reason: MembershipFlagReason;
  kind: "place" | "reservation";
  name: string;
  bookingCode: string;
  date: string;
  start: number;
  end: number;
  courtName: string;
  bookingStatus: string;
  paymentStatus: string;
  createdAt: string;
}

/** Bookings still to be decided at a venue after a membership stopped covering somebody on them. */
export async function membershipFlags(venueId: number): Promise<MembershipFlag[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT f.id, f.membership_id, m.code AS membership_code, f.reason, f.kind, f.person_name, b.code, b.date, b.start_min, b.end_min,
              c.name AS court_name, b.status, b.payment_status, f.created_at
         FROM membership_booking_flags f
         JOIN memberships m ON m.id = f.membership_id
         JOIN bookings b ON b.id = f.booking_id
         JOIN courts c ON c.id = b.court_id
        WHERE f.venue_id = ? AND f.resolved_at IS NULL
        ORDER BY b.date, b.start_min, f.id LIMIT 200`
    )
    .all(venueId)) as {
    id: number;
    membership_id: number;
    membership_code: string;
    reason: MembershipFlagReason;
    kind: "place" | "reservation";
    person_name: string;
    code: string;
    date: string;
    start_min: number;
    end_min: number;
    court_name: string;
    status: string;
    payment_status: string;
    created_at: unknown;
  }[];
  return rows.map((r) => ({
    id: r.id,
    membershipId: r.membership_id,
    membershipCode: r.membership_code,
    reason: r.reason,
    kind: r.kind,
    name: r.person_name,
    bookingCode: r.code,
    date: r.date,
    start: r.start_min,
    end: r.end_min,
    courtName: r.court_name,
    bookingStatus: r.status,
    paymentStatus: r.payment_status,
    createdAt: isoOf(r.created_at),
  }));
}

/**
 * Staff have dealt with a flagged booking (cancelled it on the venue's
 * terms, admitted them, or kept it): on record, with who and a note. A note
 * is needed; another venue's flag is not found.
 */
export async function resolveMembershipFlag(admin: { id: number; name: string }, venueId: number, flagId: number, note: unknown): Promise<boolean> {
  const text = typeof note === "string" && note.trim() !== "" ? note.trim().slice(0, 300) : null;
  if (!text || !Number.isInteger(flagId) || flagId <= 0) return false;
  const done = await getDb()
    .prepare(
      `UPDATE membership_booking_flags SET resolved_at = now(), resolved_by = ?, resolved_by_admin_id = ?, resolution = ?
        WHERE id = ? AND venue_id = ? AND resolved_at IS NULL`
    )
    .run(admin.name, admin.id, text, flagId, venueId);
  return done.changes === 1;
}
