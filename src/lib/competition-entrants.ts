import { accessRefusal, accessSettings, accountPhone } from "./access";
import { membershipOf, refuse } from "./entitlements";
import { longEnough } from "./phone";
import { guardianshipOf, linkedParticipantOf, participantEvent } from "./participants";
import { selectionAtVenue } from "./participant-bookings";
import { categoryRefusal, categoryRefusalFor, isPartnerGender, type Category, type Who } from "./who";

/**
 * Who enters a tournament or joins a box league, and on whose word
 * (docs/features/tournaments.md#who-enters-and-how; migration 0178).
 *
 * Three ways in, and one set of checks for all of them (lib/tournaments.ts
 * `enterAs`, lib/leagues.ts `joinAs`):
 *
 * - **self**: the account holder, for themself, as always;
 * - **participant**: somebody a guardian manages (ADR 0023), entered from the
 *   guardian's account. The participant is the entrant: their age, category
 *   and membership are asked, never the guardian's. The guardian's account
 *   acts for the entry (pays, withdraws, reports, is told);
 * - **counter**: staff at the venue's counter, on the number and name they
 *   are given (as a counter booking), or a participant the venue knows with a
 *   live guardian on that number (lib/participant-bookings.ts). No account.
 *
 * A number is a contact detail, never proof that two entries are one person.
 */

export type Entrant =
  | { kind: "self"; userId: number; name: string }
  | { kind: "participant"; userId: number; guardianName: string; participantId: number; name: string }
  | { kind: "counter"; adminId: number; adminName: string; phone: string; name: string; participantId: number | null };

export type EntrantRefusal = { ok: false; error: string; code?: string; vars?: Record<string, string | number>; status?: number };

export const isEntrantRefusal = (x: unknown): x is EntrantRefusal => typeof x === "object" && x !== null && (x as EntrantRefusal).ok === false;

/** The account holder entering for themself. */
export const selfEntrant = (user: { id: number; name: string }): Entrant => ({ kind: "self", userId: user.id, name: user.name.trim() });

/** Online: a participant this account acts for now (a live relationship), never one another adult manages. */
export async function guardianEntrant(user: { id: number; name: string }, participantId: unknown): Promise<Entrant | EntrantRefusal> {
  const mine = await guardianshipOf(user.id, participantId, { live: true });
  if (!mine) return { ok: false, error: "Not one of the people you manage.", code: "GUARD_NOT_FOUND", status: 404 };
  return { kind: "participant", userId: user.id, guardianName: user.name.trim(), participantId: mine.participant.id, name: mine.participant.displayName };
}

/**
 * At the counter: the number and name staff are given, on their word; or a
 * participant the venue knows, named by id, whose live guardian is on that
 * number (the person the entry is made with). A typed number never makes
 * anybody a guardian.
 */
export async function counterEntrant(
  venueId: number,
  admin: { id: number; name?: string | null; email?: string | null },
  input: { phone?: unknown; name?: unknown; participantId?: unknown }
): Promise<Entrant | EntrantRefusal> {
  const phone = typeof input.phone === "string" ? input.phone.trim() : "";
  if (!longEnough(phone) || phone.length > 30) return { ok: false, error: "Give the player's phone number (or their guardian's).", status: 400 };
  const adminName = (admin.name || admin.email || "Staff").slice(0, 80);
  if (input.participantId !== undefined && input.participantId !== null && input.participantId !== "") {
    const id = Number(input.participantId);
    if (!Number.isInteger(id) || id <= 0) return { ok: false, error: "participantId must be a participant's id.", status: 400 };
    const chosen = await selectionAtVenue(venueId, phone, [id], false);
    if ("ok" in chosen) return { ok: false, error: chosen.error, code: chosen.code, vars: chosen.vars, status: chosen.status };
    const p = chosen.participants[0];
    return { kind: "counter", adminId: admin.id, adminName, phone, name: p.name, participantId: p.id };
  }
  const name = typeof input.name === "string" ? input.name.trim() : "";
  if (name.length < 2 || name.length > 60) return { ok: false, error: "Give the player's name.", status: 400 };
  return { kind: "counter", adminId: admin.id, adminName, phone, name, participantId: null };
}

/** The account that acts for the entry, if any: the entrant's own, or the guardian's. */
export const entrantUserId = (e: Entrant): number | null => (e.kind === "counter" ? null : e.userId);
/** The participant who is the entrant, if it is one. */
export const entrantParticipantId = (e: Entrant): number | null => (e.kind === "self" ? null : e.participantId);

/**
 * SQL for the person an entry (`alias`) is, to tell two apart where it
 * matters (one player in two divisions at once, a division cap): the
 * participant (as a negative number, so it never meets an account's id), else
 * the account the entry is the holder's own. Null for somebody entered at the
 * counter by name: nothing says who they are.
 */
export const PERSON_OF = (alias: string) => `COALESCE(-${alias}.participant_id, ${alias}.user_id)`;

/** A league's rule as a tournament category (lib/who.ts): its pairs are held to it as a tournament's are. */
export const categoryOfWho = (who: Who): Category => (who === "anyone" ? "open" : who);

/**
 * Why this entrant does not fit a women's, men's or mixed event, or null.
 * The account holder's own gender is their account's (lib/who.ts); anybody
 * else's is declared at entry (`declared`), by their guardian or to staff,
 * as a partner's is: recorded as said, never verified.
 */
export async function entrantCategoryRefusal(
  e: Entrant,
  category: Category,
  pair: { partnerGender?: unknown } | null,
  declared: unknown
): Promise<EntrantRefusal | null> {
  if (category === "open") return null;
  const partner = pair ? { partnerGender: isPartnerGender(pair.partnerGender) ? pair.partnerGender : null } : null;
  if (e.kind === "self") return categoryRefusal(e.userId, category, partner);
  if (!isPartnerGender(declared)) return refuse("LG5_ENTRANT_GENDER", { name: e.name });
  return categoryRefusalFor(declared, category, partner);
}

/** What `entrant_gender` records: the declared gender of an entrant with no account of their own, where the event asked. */
export const declaredGender = (e: Entrant, category: Category, declared: unknown): "woman" | "man" | null =>
  e.kind !== "self" && category !== "open" && isPartnerGender(declared) ? declared : null;

/**
 * The live membership that makes this entrant a member here (ADR 0025): the
 * account holder's own (their proved or linked number), or, where their login
 * is a participant's, that participant's own or a family membership naming
 * them; a participant's own or a family membership naming them; at the
 * counter, the number's on staff's word. Never somebody else's: a guardian's
 * membership does not cover a child it does not name.
 */
export async function entrantMembership(venueId: number, e: Entrant, date: string): Promise<boolean> {
  if (e.kind === "self") {
    const phone = await accountPhone(e.userId);
    if (phone && (await membershipOf(venueId, null, { phone, userId: e.userId, by: "customer" }, date))) return true;
    const own = await linkedParticipantOf(e.userId);
    return !!own && !!(await membershipOf(venueId, own.id, { phone: "" }, date));
  }
  if (e.kind === "participant" || e.participantId !== null) return !!(await membershipOf(venueId, e.participantId, { phone: "" }, date));
  return !!(await membershipOf(venueId, null, { phone: e.phone, by: "staff" }, date));
}

/** A members-only tournament: the entrant's own membership (`entrantMembership`), never a guardian's. */
export async function membersOnlyEntrantRefusal(venueId: number, e: Entrant, date: string): Promise<EntrantRefusal | null> {
  if (await entrantMembership(venueId, e, date)) return null;
  return e.kind === "self" ? { ok: false, error: "This is for the venue's members: join, then enter.", code: "ENTRY_MEMBERS_ONLY" } : refuse("LG5_MEMBERS_ENTRANT", { name: e.name });
}

/**
 * Who the venue is for (lib/access.ts), for a tournament entry or a league place:
 *
 * - the account holder: the venue's own rule for their account, as before;
 * - a participant entered online: at a members-only venue the participant
 *   needs their own membership or a family one naming them (their place is
 *   their own, as on a members' session); at a private venue the guardian's
 *   account must be on its list, as for a booking;
 * - at the counter: staff enter anybody, as they book anybody, except a
 *   participant at a members-only venue, who needs their own membership.
 */
export async function entrantVenueRefusal(venueId: number, e: Entrant, date: string): Promise<EntrantRefusal | null> {
  if (e.kind === "self") return accessRefusal(venueId, e.userId);
  const { access } = await accessSettings(venueId);
  if (e.kind === "participant" && access === "private") {
    const r = await accessRefusal(venueId, e.userId);
    if (r) return r;
  }
  if (access === "members" && e.participantId !== null && !(await membershipOf(venueId, e.participantId, { phone: "" }, date)))
    return refuse("LG5_MEMBERS_VENUE", { name: e.name });
  return null;
}

/** In the participant's own history: entered, by whom, where (lib/participants.ts). */
export async function recordEntered(e: Entrant, venueId: number, action: "tournament.entered" | "league.joined", what: string): Promise<void> {
  if (e.kind === "self" || e.participantId === null) return;
  await participantEvent(
    e.participantId,
    action,
    e.kind === "participant" ? { userId: e.userId, name: e.guardianName } : { adminId: e.adminId, name: e.adminName },
    { venueId, detail: what }
  );
}
