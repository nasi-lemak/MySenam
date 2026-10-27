import { getDb } from "./db";
import { phoneKey } from "./phone";
import { guardianshipOf, participantAtVenue, participantEvent, refused, type Actor, type ParticipantRefusal } from "./participants";

/**
 * Who a booking is for, on every booking path (ADR 0023;
 * docs/features/booking.md#booking-for-somebody-else): the one place that
 * turns what a request names into the participants the booking engine
 * (lib/store.ts `createBookingSeries`, classes, the waiting list) books for.
 * It adds no model of its own: participants and who may act for them are
 * lib/participants.ts; who takes a place is `booking_participants`.
 *
 * A request names nobody (the customer alone, as every booking always was),
 * or a list of participants, with `customerTakesPart` where the customer takes
 * a place alongside them. Each participant is then checked on their own, by
 * whoever is booking:
 *
 * - online, by an account that acts for them now (a live relationship, not
 *   archived): never somebody another adult manages;
 * - at the counter or through the venue's own API key, a participant the
 *   venue knows (lib/participants.ts `participantAtVenue`) with a live
 *   guardian on the booking's number: the person the booking is made with,
 *   and told about it. A number finds the relationship staff or the guardian
 *   declared; it never makes one. Somebody new is recorded first, with the
 *   guardian's declaration to the member of staff (`createAtVenue`).
 *
 * Eligibility (sign-offs, certifications, inductions, waivers) is then each
 * participant's own, checked by the engine and the door; the customer's only
 * when they take part.
 */

/** Somebody booked for: their id and the name they are booked under. */
export interface Named {
  id: number;
  name: string;
}

export interface Selection {
  participants: Named[];
  /** The customer takes a place alongside them. */
  customerTakesPart: boolean;
}

/** The most people one booking, enrolment or waiting-list entry names. */
export const MAX_NAMED = 12;

/** How many places a selection takes: each participant, and the customer where they take part. */
export const placesOf = (s: Selection): number => s.participants.length + (s.customerTakesPart || s.participants.length === 0 ? 1 : 0);

/**
 * What a request names: `participantIds` (a list) or `participantId` (one,
 * the older form), and `customerTakesPart`. Null where it names nobody.
 */
export function readSelection(body: Record<string, unknown>): { ids: number[]; customerTakesPart: boolean } | ParticipantRefusal | null {
  const { participantIds, participantId, customerTakesPart } = body;
  let ids: unknown[];
  if (participantIds !== undefined && participantIds !== null) {
    if (!Array.isArray(participantIds)) return refused("PBK_PARTICIPANTS", "participantIds must be a list of participant ids.");
    ids = participantIds;
  } else if (participantId !== undefined && participantId !== null) ids = [participantId];
  else return null;
  if (ids.length === 0) return null;
  if (ids.length > MAX_NAMED) return refused("PBK_TOO_MANY", `Up to ${MAX_NAMED} people on one booking.`, 400, { n: MAX_NAMED });
  if (!ids.every((id) => Number.isInteger(id) && (id as number) > 0)) return refused("PBK_PARTICIPANTS", "participantIds must be a list of participant ids.");
  if (new Set(ids).size !== ids.length) return refused("PBK_TWICE", "Name each person once.");
  if (customerTakesPart !== undefined && customerTakesPart !== null && typeof customerTakesPart !== "boolean")
    return refused("PBK_PARTICIPANTS", "customerTakesPart must be true or false.");
  return { ids: ids as number[], customerTakesPart: customerTakesPart === true };
}

/** Online: every one named is somebody this account acts for now. */
export async function selectionForAccount(userId: number, ids: number[], customerTakesPart: boolean): Promise<Selection | ParticipantRefusal> {
  const participants: Named[] = [];
  for (const id of ids) {
    const mine = await guardianshipOf(userId, id, { live: true });
    if (!mine) return refused("GUARD_NOT_FOUND", "Not one of the people you manage.", 404);
    participants.push({ id: mine.participant.id, name: mine.participant.displayName });
  }
  return { participants, customerTakesPart };
}

/**
 * Does somebody act for this participant, now, on this number: a guardian
 * whose account or recorded contact is on it, not revoked, archived or
 * paused for a review? An adult whose guardian request is still waiting is
 * nobody's guardian (lib/guardian-requests.ts).
 */
async function guardianOnNumber(participantId: number, phone: string): Promise<boolean> {
  const key = phoneKey(phone);
  if (key.length < 7) return false;
  return !!(await getDb()
    .prepare(
      `SELECT 1 FROM participant_guardians g LEFT JOIN users u ON u.id = g.user_id
        WHERE g.participant_id = ? AND g.revoked_at IS NULL AND g.archived_at IS NULL AND g.suspended_at IS NULL
          AND (phone_key(u.phone) = ? OR phone_key(g.contact_phone) = ?)
        LIMIT 1`
    )
    .get(participantId, key, key));
}

/**
 * At the counter or through the venue's API key: each one named is a
 * participant this venue knows, and the booking's number is a live
 * guardian's of each (so the booking is made with, and told to, somebody who
 * acts for them). Refused otherwise: no booking a child under a number that
 * is not their guardian's, nor one another venue knows.
 */
export async function selectionAtVenue(venueId: number, phone: string, ids: number[], customerTakesPart: boolean): Promise<Selection | ParticipantRefusal> {
  const participants: Named[] = [];
  for (const id of ids) {
    const p = await participantAtVenue(venueId, id);
    if (!p) return refused("PTC_NOT_FOUND", "No such participant here.", 404);
    if (!(await guardianOnNumber(p.id, phone)))
      return refused(
        "PBK_NOT_GUARDIAN",
        "Nobody acting for them is on this number. Book with their guardian's number, or record the guardian's declaration first.",
        409,
        { name: p.displayName }
      );
    participants.push({ id: p.id, name: p.displayName });
  }
  return { participants, customerTakesPart };
}

/**
 * Write in each participant's history that a booking was made for them: who
 * did it (the account, the member of staff, the venue's system), at which
 * venue, how, and which booking. The activity log has staff actions too.
 */
export async function recordBookedFor(
  participants: Named[],
  actor: Actor,
  detail: { venueId: number; codes: string[]; how: "online" | "counter" | "api" | "class" | "waitlist" }
): Promise<void> {
  for (const p of participants)
    await participantEvent(p.id, "booking.made", actor, {
      venueId: detail.venueId,
      detail: `${detail.how}: ${detail.codes.join(", ")}`,
    });
}

/** The names on a selection, for messages and screens: "Alya, Bilal". */
export const namesOf = (s: Pick<Selection, "participants">): string => s.participants.map((p) => p.name).join(", ");
