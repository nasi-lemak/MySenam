import type { Pass } from "./types";

/**
 * What a booking spends from a pass (lib/store.ts `payBookingWithPass`),
 * browser-safe so the booking form can say it before the booking is made.
 *
 * A time pass spends the minutes booked, to the minute. A session pass
 * spends entries: one per `entryMinutes` or part of them, or one a booking
 * whatever its length when it has none. Either may cap the length of a
 * booking it pays for.
 */
export function passCost(
  pass: Pick<Pass, "kind" | "entryMinutes" | "maxMinutes">,
  minutes: number
): { ok: true; units: number } | { ok: false; error: string; maxMinutes: number } {
  if (pass.maxMinutes !== null && minutes > pass.maxMinutes)
    return { ok: false, error: `That pass pays for bookings up to ${pass.maxMinutes} minutes.`, maxMinutes: pass.maxMinutes };
  if (pass.kind === "time") return { ok: true, units: minutes };
  return { ok: true, units: pass.entryMinutes === null ? 1 : Math.ceil(minutes / pass.entryMinutes) };
}

/** A place a pass may pay for: the customer's own, or a participant's (lib/entitlements.ts `placesOf`). */
export interface PlanPlace {
  /** Its `booking_participants` row; null before the booking is made, or for the customer taking it alone. */
  placeId: number | null;
  customer: boolean;
  participantId: number | null;
  name: string | null;
}

/** What the plan needs of a pass. */
export type PlanPass = Pick<Pass, "id" | "code" | "kind" | "entryMinutes" | "maxMinutes" | "holderName" | "remaining"> &
  Partial<Pick<Pass, "scope" | "holderParticipantId" | "holderParticipantName">>;

/** One spend: this pass, for this place, so many units. */
export interface PlannedSpend<P extends PlanPass = PlanPass> {
  pass: P;
  /** The place's row; null for the booking as a whole, a place nobody is named on, or a booking not yet made. */
  placeId: number | null;
  /** Which of the places given it pays for (their index); null for the booking as a whole or a place nobody is named on. */
  place: number | null;
  units: number;
}

export type PassPlanCode = "ENT_PASS_MIX" | "ENT_PASS_RESOURCE" | "ENT_PASS_UNNAMED" | "ENT_PASS_NOT_ON_BOOKING" | "ENT_PASS_TWICE" | "ENT_PASS_UNCOVERED";

export type PassPlan<P extends PlanPass = PlanPass> =
  | { ok: true; spends: PlannedSpend<P>[] }
  | { ok: false; code: PassPlanCode; vars?: Record<string, string> }
  | { ok: false; code: "PASS_TOO_LONG"; maxMinutes: number; error: string };

/**
 * Which pass pays for which place, and how much each spends (ADR 0025): the
 * one plan the booking engine pays by (lib/store.ts `payBookingWithPasses`,
 * which then re-reads every balance inside its transaction) and the booking
 * form and the counter show before anything is spent. Browser-safe.
 *
 * One pass for the booking as a whole (`booking`; `resource`, only on a
 * resource hired whole), or spent once for each place (`places`); or several
 * passes for one person's place each (`participant`), the holder's own place,
 * each place covered once and every place covered, never part-paid.
 */
export function planPassSpends<P extends PlanPass>(input: {
  passes: P[];
  places: PlanPlace[];
  /** Places the booking takes: players on a court priced per player, places on a shared facility; 1 otherwise. */
  players: number;
  minutes: number;
  /** Is the booking sold by the place (lib/entitlements.ts `soldByPlace`)? */
  soldByPlace: boolean;
  /** The customer's name, for a place of theirs left unpaid. */
  bookerName: string;
  /** Courts of a group, each with its own people: a person's pass pays where they are and is passed over elsewhere. */
  skipAbsent?: boolean;
}): PassPlan<P> {
  const { passes, places } = input;
  const spends: PlannedSpend<P>[] = [];
  const costOf = (pass: P): number | { ok: false; code: "PASS_TOO_LONG"; maxMinutes: number; error: string } => {
    const cost = passCost(pass, input.minutes);
    return cost.ok ? cost.units : { ok: false, code: "PASS_TOO_LONG", maxMinutes: cost.maxMinutes, error: cost.error };
  };
  const oneEach = passes.length > 0 && passes.every((p) => p.scope === "participant");
  if (passes.length > 1 && !oneEach) return { ok: false, code: "ENT_PASS_MIX" };
  if (!oneEach) {
    const pass = passes[0];
    // A package of a resource's hours pays for the resource hired whole, not for places sold one by one.
    if (pass.scope === "resource" && input.soldByPlace) return { ok: false, code: "ENT_PASS_RESOURCE" };
    const units = costOf(pass);
    if (typeof units !== "number") return units;
    if (pass.scope === "places") {
      const named = places.map((p, i) => ({ p, i })).filter(({ p }) => p.placeId !== null);
      for (const { p, i } of named) spends.push({ pass, placeId: p.placeId, place: i, units });
      for (let i = named.length; i < Math.max(1, input.players); i++) spends.push({ pass, placeId: null, place: null, units });
    } else spends.push({ pass, placeId: null, place: null, units });
    return { ok: true, spends };
  }
  // Each a person's own: every place on the booking covered by its own person's pass, once.
  if (input.players > places.length) return { ok: false, code: "ENT_PASS_UNNAMED" };
  const covered = new Set<number>();
  for (const pass of passes) {
    const i = places.findIndex((p) => (pass.holderParticipantId ? p.participantId === pass.holderParticipantId : p.customer));
    if (i < 0 && input.skipAbsent) continue;
    if (i < 0) return { ok: false, code: "ENT_PASS_NOT_ON_BOOKING", vars: { name: pass.holderParticipantName ?? pass.holderName } };
    const place = places[i];
    if (covered.has(i)) return { ok: false, code: "ENT_PASS_TWICE", vars: { name: place.name ?? pass.holderName } };
    covered.add(i);
    const units = costOf(pass);
    if (typeof units !== "number") return units;
    spends.push({ pass, placeId: place.placeId, place: i, units });
  }
  const uncovered = places.filter((_, i) => !covered.has(i));
  if (uncovered.length > 0)
    return { ok: false, code: "ENT_PASS_UNCOVERED", vars: { names: uncovered.map((p) => (p.customer ? input.bookerName : (p.name ?? "?"))).join(", ") } };
  return { ok: true, spends };
}

/** What each pass of a plan spends in all, and whether it has that left now (re-read when it is spent). */
export function planTotals<P extends PlanPass>(spends: PlannedSpend<P>[]): { pass: P; units: number; enough: boolean }[] {
  const out = new Map<number, { pass: P; units: number }>();
  for (const s of spends) out.set(s.pass.id, { pass: s.pass, units: (out.get(s.pass.id)?.units ?? 0) + s.units });
  return [...out.values()].map((t) => ({ ...t, enough: t.pass.remaining >= t.units }));
}
