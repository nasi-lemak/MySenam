import { getDb } from "./db";
import { errorText, translator, type ErrorCode, type Phrase } from "./i18n";
import { pricedByQuantity, type MemberPricing } from "./pricing";
import { roundMoney } from "./region";
import type { BenefitScope, Court, Membership, Refusal } from "./types";

export type { BenefitScope };

/**
 * What a benefit applies to (ADR 0025; docs/features/pricing.md#what-a-benefit-applies-to).
 *
 * A pass, a concession, or a membership plan's benefits each say what one use
 * of them covers, in the models that already hold them (`passes.scope`,
 * `concessions.scope`, `membership_plans.scope`; migrations 0155–0156):
 *
 * - `booking`: the reservation as a whole, whoever is on it: a court pass, a
 *   promotion off the total, a venue's voucher, a member's price for the
 *   court. What every pass, concession and plan did before, and still does.
 * - `resource`: a resource hired whole, for its time (a package of court
 *   hours). Not for places on a facility sold one by one.
 * - `participant`: one person's place: theirs alone, on a booking priced by
 *   the place (a child's admission concession, an individual swim pass, a
 *   coaching pack for one person, a participant's own membership).
 * - `places`: every place the booking takes, each one using it (a pass that
 *   spends per person).
 *
 * The product or activity a benefit is good for is said apart, as it always
 * was: its sport, and a lesson pack's coach.
 *
 * Nothing here is a pricing engine of its own: prices are lib/pricing.ts,
 * bookings lib/store.ts. This module says which places a benefit may cover and
 * what one place's share of a booking is, and keeps the per-place redemptions
 * (`place_benefits`), whose database guard is what stops one being redeemed
 * twice.
 */

export const PASS_SCOPES: readonly BenefitScope[] = ["booking", "resource", "participant", "places"];
export const CONCESSION_SCOPES: readonly BenefitScope[] = ["booking", "participant"];
export const PLAN_SCOPES: readonly BenefitScope[] = ["booking", "participant"];

export function isScope(v: unknown, allowed: readonly BenefitScope[]): v is BenefitScope {
  return typeof v === "string" && (allowed as readonly string[]).includes(v);
}

const ENGLISH = translator("en");
export function refuse(code: ErrorCode, vars: Record<string, string | number> = {}): Refusal {
  return { ok: false, error: errorText(ENGLISH, code, vars), code, ...(Object.keys(vars).length > 0 ? { vars } : {}) };
}

/**
 * Is a booking of this sold by the place: each person a place, priced so
 * (players on a court priced per player, places on a shared facility not
 * priced flat)? A benefit for one person's place applies only there; on a
 * resource hired whole nothing is priced per person.
 */
export function soldByPlace(court: Pick<Court, "perPlayer" | "capacity" | "flatRate">): boolean {
  return pricedByQuantity(court);
}

/**
 * Does a booking here take places of a shared-capacity session (a gym floor,
 * a pool, a class), rather than reserve a resource? Membership eligibility is
 * then each person's own; reserving a court is the booker's privilege.
 */
export function takesPlaces(court: Pick<Court, "capacity">, classId?: number | null): boolean {
  return (classId ?? null) !== null || court.capacity > 1;
}

/** One place on a booking: its row, and who takes it. */
export interface BookingPlace {
  /** Its `booking_participants` row; null for the customer taking the booking alone. */
  placeId: number | null;
  customer: boolean;
  participantId: number | null;
  name: string | null;
}

/** The places a booking's people take: its rows, or the customer alone where it names nobody. */
export async function placesOf(bookingId: number): Promise<BookingPlace[]> {
  const rows = (await getDb()
    .prepare("SELECT id, takes_part_as, participant_id, name FROM booking_participants WHERE booking_id = ? ORDER BY id")
    .all(bookingId)) as { id: number; takes_part_as: "customer" | "participant"; participant_id: number | null; name: string | null }[];
  if (!rows.some((r) => r.takes_part_as === "participant")) {
    const own = rows.find((r) => r.takes_part_as === "customer");
    return [{ placeId: own?.id ?? null, customer: true, participantId: null, name: own?.name ?? null }];
  }
  return rows.map((r) => ({ placeId: r.id, customer: r.takes_part_as === "customer", participantId: r.participant_id, name: r.name }));
}

/** The place a person takes on a booking: the customer's (`null`), or a participant's. */
export async function placeFor(bookingId: number, participantId: number | null): Promise<BookingPlace | null> {
  return (await placesOf(bookingId)).find((p) => (participantId === null ? p.customer : p.participantId === participantId)) ?? null;
}

/** Money each live per-place benefit took off a booking, by place (0 for the customer alone). */
async function placeAmounts(bookingId: number): Promise<Map<number, number>> {
  const rows = (await getDb()
    .prepare("SELECT COALESCE(place_id, 0) AS place, SUM(amount)::float AS amount FROM place_benefits WHERE booking_id = ? AND reversed_at IS NULL GROUP BY 1")
    .all(bookingId)) as { place: number; amount: number }[];
  return new Map(rows.map((r) => [Number(r.place), Number(r.amount)]));
}

/**
 * One place's share of a booking priced by the place, as it was charged: the
 * court time split evenly between the places it takes now (fees, a coach's
 * fee and extras stay with the booking; a booking-wide discount is shared
 * between the places; places already taken off it while paid are left out),
 * before (`gross`) and after (`net`) what that place's own benefits took off.
 * What a place's concession comes off, and what taking the place off the
 * booking takes off its price. `placeId` -1: a place nobody is named on.
 */
export async function placeShare(bookingId: number, placeId: number | null): Promise<{ gross: number; net: number; players: number }> {
  const db = getDb();
  const b = (await db
    .prepare(
      `SELECT b.total_price::float AS total, b.fee_amount::float AS fees, b.coach_fee::float AS coach, b.players,
              (SELECT COALESCE(SUM(w.price), 0)::float FROM place_withdrawals w WHERE w.booking_id = b.id AND w.paid) AS withdrawn,
              (SELECT COALESCE(SUM(a.quantity * a.unit_price), 0)::float FROM booking_addons a WHERE a.booking_id = b.id) AS extras
         FROM bookings b WHERE b.id = ?`
    )
    .get(bookingId)) as { total: number; fees: number | null; coach: number | null; players: number; withdrawn: number; extras: number } | undefined;
  if (!b) return { gross: 0, net: 0, players: 0 };
  const amounts = await placeAmounts(bookingId);
  const all = [...amounts.values()].reduce((s, a) => s + a, 0);
  const players = Math.max(1, Number(b.players) || 1);
  const court = Number(b.total) - Number(b.fees ?? 0) - Number(b.coach ?? 0) - Number(b.extras) - Number(b.withdrawn);
  const gross = roundMoney((court + all) / players);
  const own = amounts.get(placeId ?? 0) ?? 0;
  return { gross, net: roundMoney(Math.max(0, gross - own)), players };
}

/** A per-place benefit standing on a booking, for its screens and receipt. */
export interface PlaceBenefit {
  id: number;
  bookingId: number;
  placeId: number | null;
  participantId: number | null;
  kind: "concession" | "membership";
  concessionId: number | null;
  concessionName: string | null;
  concessionPreset: string | null;
  membershipId: number | null;
  amount: number;
  proofCheck: "due" | "seen" | "refused" | null;
  /** Who takes the place, as named on the booking. */
  name: string | null;
}

export async function placeBenefitsFor(bookingId: number, opts: { all?: boolean } = {}): Promise<PlaceBenefit[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT pb.id, pb.booking_id, pb.place_id, pb.participant_id, pb.kind, pb.concession_id, pb.concession_name, pb.concession_preset,
              pb.membership_id, pb.amount::float AS amount, pb.proof_check, bp.name
         FROM place_benefits pb LEFT JOIN booking_participants bp ON bp.id = pb.place_id
        WHERE pb.booking_id = ? ${opts.all ? "" : "AND pb.reversed_at IS NULL"} ORDER BY pb.id`
    )
    .all(bookingId)) as {
    id: number;
    booking_id: number;
    place_id: number | null;
    participant_id: number | null;
    kind: "concession" | "membership";
    concession_id: number | null;
    concession_name: string | null;
    concession_preset: string | null;
    membership_id: number | null;
    amount: number;
    proof_check: "due" | "seen" | "refused" | null;
    name: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    bookingId: r.booking_id,
    placeId: r.place_id,
    participantId: r.participant_id,
    kind: r.kind,
    concessionId: r.concession_id,
    concessionName: r.concession_name,
    concessionPreset: r.concession_preset,
    membershipId: r.membership_id,
    amount: Number(r.amount),
    proofCheck: r.proof_check,
    name: r.name,
  }));
}

/** Is it the database refusing a second live benefit of a kind for one place? */
export function isDuplicateRedemption(err: unknown): boolean {
  const e = err as { code?: string; message?: string; constraint?: string } | null;
  return !!e && e.code === "23505" && `${e.constraint ?? ""} ${e.message ?? ""}`.includes("uq_place_benefits_live");
}

/** Is it the database refusing a second spend for one place, or a second refund of one spend? */
export function isDuplicateSpend(err: unknown): boolean {
  const e = err as { code?: string; message?: string; constraint?: string } | null;
  return !!e && e.code === "23505" && /uq_pass_entries_(place_spend|settles)/.test(`${e.constraint ?? ""} ${e.message ?? ""}`);
}

// ------------------------------------------------------------ memberships by scope

/** Who is booking, where a number typed online must be the account's own to count (lib/store.ts `memberNumberTrusted`). */
export interface Booker {
  phone: string;
  userId?: number | null;
  by?: "customer" | "staff" | "api";
}

/**
 * The live membership that makes this person a member here on this date: the
 * customer's own (`participantId` null: held by their number, which online
 * must be the account's proved or linked one), or a participant's own or a
 * family membership naming them. Never somebody else's: a guardian's
 * membership does not cover a child it does not name, nor a child's the
 * guardian.
 */
export async function membershipOf(venueId: number, participantId: number | null, booker: Booker, date: string): Promise<Membership | null> {
  // Imported here, not at the top: lib/store.ts reads this module.
  const store = await import("./store");
  if (participantId !== null) return store.participantMembership(venueId, participantId, date);
  const m = await store.activeMembership(venueId, booker.phone, date);
  if (!m) return null;
  const trusted = await store.memberNumberTrusted(booker.phone, booker.by ? { userId: booker.userId ?? null, by: booker.by } : undefined);
  return trusted ? m : null;
}

/** A member's price, and for whom. */
export interface MemberPrices {
  /** A member's price for the booking as a whole: a member, or somebody a family membership covers, takes part (`booking` benefit). */
  booking: { level: MemberPricing; membershipId: number } | null;
  /** A member's price for members' own places only (`participant` benefit), on a booking priced by the place. */
  places: { participantId: number | null; level: MemberPricing; membershipId: number }[];
}

/**
 * Who on a booking pays a member's price, by the scope of each membership's
 * benefit (ADR 0025). Everybody taking part is asked: the customer where they
 * take a place, and each participant (their own membership, or a family one
 * naming them). A `booking` benefit prices the whole booking, as a member's
 * always did, so a member reserving a whole court pays the member's price
 * whoever else plays. A `participant` benefit prices only its members' own
 * places on a booking priced by the place; on a resource hired whole it
 * applies only where its member is the only one taking part. A booking made
 * only for people who are not members is at the public price, whoever's
 * number it is on.
 */
export async function memberPrices(input: {
  venueId: number;
  court: Pick<Court, "perPlayer" | "capacity" | "flatRate">;
  booker: Booker;
  participants: { id: number }[];
  customerTakesPart: boolean;
  date: string;
}): Promise<MemberPrices> {
  const persons: (number | null)[] = [...(input.customerTakesPart ? [null] : []), ...input.participants.map((p) => p.id)];
  const found: { participantId: number | null; m: Membership }[] = [];
  for (const person of persons) {
    const m = await membershipOf(input.venueId, person, input.booker, input.date);
    if (m) found.push({ participantId: person, m });
  }
  const level = (m: Membership): MemberPricing => m.ratePercent ?? true;
  const wide = found.find((f) => (f.m.scope ?? "booking") === "booking");
  if (wide) return { booking: { level: level(wide.m), membershipId: wide.m.id }, places: [] };
  if (found.length === 0) return { booking: null, places: [] };
  if (!soldByPlace(input.court))
    return persons.length === 1 ? { booking: { level: level(found[0].m), membershipId: found[0].m.id }, places: [] } : { booking: null, places: [] };
  return { booking: null, places: found.map((f) => ({ participantId: f.participantId, level: level(f.m), membershipId: f.m.id })) };
}

/**
 * Who may take a place on a session at a members-only venue (ADR 0025): each
 * person taking a place of a shared-capacity session (a facility's places, a
 * class) must be a member themself, on every date booked. Here each
 * participant named: their own membership, or a family membership naming
 * them; a guardian's own membership never covers a child it does not name.
 * The customer's own place is the account's, checked where it always was
 * (lib/access.ts). Reserving a resource whole stays the booker's privilege
 * (a member may book a court for their children), so it asks nothing here.
 * The one check every path makes: online, the counter, the venue's API key,
 * a group of courts, a waiting-list offer, a class and a move.
 */
export async function membersOnlyRefusal(input: {
  venueId: number;
  court: Pick<Court, "capacity">;
  classId?: number | null;
  participants: { id: number; name: string }[];
  dates: string[];
}): Promise<Refusal | null> {
  if (input.participants.length === 0 || !takesPlaces(input.court, input.classId)) return null;
  const { accessSettings } = await import("./access");
  if ((await accessSettings(input.venueId)).access !== "members") return null;
  const store = await import("./store");
  for (const p of input.participants)
    for (const date of input.dates) if (!(await store.participantMembership(input.venueId, p.id, date))) return refuse("ENT_MEMBERS_PLACE", { name: p.name });
  return null;
}

/**
 * `placeConcessions` from a booking request: `[{ participantId, concessionId }]`,
 * `participantId` null for the customer's own place. An empty list where none
 * is asked for; null where it is not that shape. One per person.
 */
export function readPlaceConcessions(raw: unknown): { participantId: number | null; concessionId: number }[] | null {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 13) return null;
  const out: { participantId: number | null; concessionId: number }[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) return null;
    const { participantId, concessionId } = item as Record<string, unknown>;
    if (!Number.isInteger(concessionId) || (concessionId as number) <= 0) return null;
    if (participantId !== null && participantId !== undefined && (!Number.isInteger(participantId) || (participantId as number) <= 0)) return null;
    const who = (participantId as number | null | undefined) ?? null;
    if (out.some((o) => o.participantId === who)) return null;
    out.push({ participantId: who, concessionId: concessionId as number });
  }
  return out;
}

/** The English for a phrase of this module's, for logs and the server's English fields. */
export const englishPhrase = (key: Phrase, vars?: Record<string, string | number>) => ENGLISH(key, vars);
