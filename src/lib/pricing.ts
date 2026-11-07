import type { PricingPolicy } from "./booking-policy";
import { instantOf, type Span } from "./interval";
import { region } from "./region";
import { DEFAULT_PEAK, forSport, peakWindow, type PeakRules } from "./time";
import type { Court } from "./types";
import { changeOn } from "./week-hours";

/**
 * What court time costs (ADR 0010). By default, pro rata: each part of a
 * booking at the rate in force then, to the minute, so 17:30–18:30 with peak
 * from 18:00 is half an hour of each, and 75 minutes is 1¼ hours of rate.
 * Operators may instead price lengths outright (90 minutes for RM120), bill
 * in steps or with a minimum, charge a minimum, price the whole booking at
 * the rate when it starts, and add setup and cleanup fees, shown apart from
 * the time.
 *
 * Money is counted in the currency's smallest unit and multiplied out as
 * whole numbers (rate × minutes × percent), then rounded once, half up, so
 * no floating-point remainder reaches a price. Quotes, bookings, moves,
 * refunds, passes and weekly series all price through `priceBooking`.
 */

/** How a number pays: not a member (false), at the courts' member rates (true), or a tier's percent of the public price. */
export type MemberPricing = boolean | number;

export type CourtRates = Pick<Court, "sport" | "offPeakRate" | "peakRate" | "memberOffPeakRate" | "memberPeakRate" | "perPlayer" | "rateChanges"> & {
  /** Over one: a shared facility, whose rates are per place, as many as are booked (unless `flatRate`). */
  capacity?: number;
  /** A facility with places whose rates are for the whole booking, however many it takes. */
  flatRate?: boolean;
  /** Each place at a percent of the rate once a booking takes this many or more. */
  quantityPrices?: QuantityPrice[] | null;
};

/** From `from` places (or players) in one booking, each at `percent` of the rate. */
export interface QuantityPrice {
  from: number;
  percent: number;
}

/** Is a booking here priced by how many it is for: players on a court priced so, or places on a facility not priced flat? */
export function pricedByQuantity(court: Pick<CourtRates, "perPlayer" | "capacity" | "flatRate">): boolean {
  return !!court.perPlayer || ((court.capacity ?? 1) > 1 && !court.flatRate);
}

/** The percent each place costs for a booking of `count`: the best band it reaches, else 100. */
export function quantityPercent(bands: QuantityPrice[] | null | undefined, count: number): number {
  let percent = 100;
  for (const b of bands ?? []) if (count >= b.from && b.percent < percent) percent = b.percent;
  return percent;
}

/** Bands as staff may set them: 1 to 5, each from 2 to 50, 1% to 99%, a lower percent for a larger booking. */
export function readQuantityPrices(raw: unknown): { ok: true; value: QuantityPrice[] | null } | { ok: false; error: string } {
  if (raw === null || (Array.isArray(raw) && raw.length === 0)) return { ok: true, value: null };
  if (!Array.isArray(raw) || raw.length > 5) return { ok: false, error: "Give up to five quantity prices." };
  const bands: QuantityPrice[] = [];
  for (const b of raw as { from?: unknown; percent?: unknown }[]) {
    if (!Number.isInteger(b?.from) || (b.from as number) < 2 || (b.from as number) > 50)
      return { ok: false, error: "A quantity price starts from 2 to 50." };
    if (!Number.isInteger(b?.percent) || (b.percent as number) < 1 || (b.percent as number) > 99)
      return { ok: false, error: "A quantity price is 1% to 99% of the rate." };
    bands.push({ from: b.from as number, percent: b.percent as number });
  }
  bands.sort((x, y) => x.from - y.from);
  for (let i = 1; i < bands.length; i++)
    if (bands[i].from === bands[i - 1].from || bands[i].percent >= bands[i - 1].percent)
      return { ok: false, error: "Each larger booking gets a lower price than the last." };
  return { ok: true, value: bands };
}

export const NO_PRICING_RULES: PricingPolicy = {
  rateMode: "split",
  billStep: null,
  minBilled: null,
  minCharge: null,
  fixedPrices: null,
  setupFee: 0,
  cleanupFee: 0,
  gamePrice: null,
  gamePeakPrice: null,
};

export interface PriceLine {
  kind: "time" | "fixed" | "games" | "quantity" | "minimum" | "setup" | "cleanup";
  /** Games this line is for (games), at `rate` each. */
  games?: number;
  /** Minutes this line is for (time), from `start`. */
  minutes?: number;
  start?: number;
  peak?: boolean;
  /** The hourly rate applied, after member and last-minute prices. */
  rate?: number;
  amount: number;
}

export interface Quote {
  /** The court: its time (or its fixed price), times the players or places where priced so, at least the minimum charge. */
  court: number;
  /** Setup and cleanup fees. */
  fees: number;
  total: number;
  /** The minutes billed: as booked, or rounded up by the billing step and minimum. */
  billedMinutes: number;
  lines: PriceLine[];
}

const scale = () => 10 ** region().currency.minorUnits;
const toMinor = (amount: number) => Math.round(amount * scale());
const fromMinor = (minor: number) => minor / scale();

/**
 * The hourly rate before last-minute and quantity prices, and the share of it a tier takes. A member never pays more than a
 * non-member for the same slot (D19, ADR 0071): a member rate above the public rate, or a share above 100%, is held to it.
 */
function hourlyMinor(court: CourtRates, peak: boolean, member: MemberPricing): { minor: number; percent: number } {
  const publicMinor = toMinor(peak ? court.peakRate : court.offPeakRate);
  if (typeof member === "number") return { minor: publicMinor, percent: Math.min(member, 100) };
  if (member) {
    const rate = peak ? court.memberPeakRate : court.memberOffPeakRate;
    if (rate !== null && rate !== undefined) return { minor: Math.min(toMinor(rate), publicMinor), percent: 100 };
  }
  return { minor: publicMinor, percent: 100 };
}

/** The minutes of the business day `date` where last-minute prices apply to a booking made at `at`: (now, now + hours]. */
function lastMinuteWindow(date: string, rules: PeakRules, at: number | undefined): Span | null {
  const lm = rules.lastMinute;
  if (!lm || at === undefined) return null;
  const midnight = instantOf(date, 0, lm.zone).getTime();
  const now = (at - midnight) / 60_000;
  // A minute is discounted when it starts after now and no more than `hours` ahead.
  return { start: Math.floor(now) + 1, end: Math.floor(now + lm.hours * 60) + 1 };
}

/** The points within [start, end) where the price per minute can change. */
function boundaries(date: string, span: Span, rules: PeakRules, discount: Span | null): number[] {
  const w = peakWindow(date, rules);
  const cuts = new Set<number>([span.start, span.end]);
  for (const p of [w.from, w.until, discount?.start, discount?.end])
    if (p !== undefined && p > span.start && p < span.end) cuts.add(p);
  return [...cuts].sort((a, b) => a - b);
}

/**
 * The rates in force on `date` (ADR 0027): those set from that date or an
 * earlier one (already for the activity booked: lib/court-activities.ts
 * `courtFor`), else the court's current rates. The date booked decides.
 */
export function ratesOn(court: CourtRates, date: string): CourtRates {
  const c = changeOn(court.rateChanges, date);
  if (!c) return court;
  return { ...court, offPeakRate: c.offPeakRate, peakRate: c.peakRate, memberOffPeakRate: c.memberOffPeakRate, memberPeakRate: c.memberPeakRate };
}

/** Does any of this time fall at peak? */
export function touchesPeak(date: string, span: Span, rules: PeakRules = DEFAULT_PEAK): boolean {
  const w = peakWindow(date, rules);
  return w.from < w.until && span.start < w.until && w.from < span.end;
}

/**
 * The price of court time from `span.start` to `span.end` on `date`.
 * `at` is when the booking is being made, for last-minute prices; left out,
 * none apply (a booking already made, or a move).
 */
export function priceBooking(input: {
  court: CourtRates;
  date: string;
  span: Span;
  member?: MemberPricing;
  rules?: PeakRules;
  pricing?: PricingPolicy;
  at?: number;
  players?: number;
  /** A booking sold by the game: how many (lib/booking-rules.ts `soldByGame`); priced per game where the policy has a price for one. */
  games?: number | null;
}): Quote {
  const court = ratesOn(input.court, input.date);
  const member = input.member ?? false;
  const rules = forSport(input.rules ?? DEFAULT_PEAK, court.sport);
  const pricing = input.pricing ?? NO_PRICING_RULES;
  // Per player on a court priced so; per place on a shared facility (people on
  // a floor, kayaks from a fleet) unless its rates are for the whole booking.
  const players = pricedByQuantity(court) ? Math.max(1, input.players ?? 1) : 1;
  const length = input.span.end - input.span.start;
  const discount = lastMinuteWindow(input.date, rules, input.at);
  const isPeakAt = (m: number) => {
    const w = peakWindow(input.date, rules);
    return m >= w.from && m < w.until;
  };
  const offAt = (m: number) => {
    const lm = rules.lastMinute;
    if (!lm || !discount || m < discount.start || m >= discount.end) return 0;
    return lm.offPeakOnly && isPeakAt(m) ? 0 : lm.percent;
  };
  const lines: PriceLine[] = [];
  let courtMinor: number;
  let billedMinutes = length;

  const fixed = pricing.fixedPrices?.find((f) => f.minutes === length);
  const games = input.games ?? null;
  const perGame = games !== null && games > 0 && pricing.gamePrice !== null && pricing.gamePrice !== undefined;
  if (perGame) {
    // So many games at the price of one, as a fixed price is: peak by the start, a tier's share, a last-minute price.
    const peak = isPeakAt(input.span.start);
    const one = toMinor(peak && pricing.gamePeakPrice !== null && pricing.gamePeakPrice !== undefined ? pricing.gamePeakPrice : pricing.gamePrice!);
    const percent = typeof member === "number" ? Math.min(member, 100) : 100;
    const off = offAt(input.span.start);
    const each = Math.round((one * percent * (100 - off)) / 10_000);
    courtMinor = each * games;
    lines.push({ kind: "games", games, minutes: length, start: input.span.start, peak, rate: fromMinor(each), amount: fromMinor(courtMinor) });
  } else if (fixed) {
    const peak = isPeakAt(input.span.start);
    const base = toMinor(peak && fixed.peakPrice !== null ? fixed.peakPrice : fixed.price);
    const percent = typeof member === "number" ? Math.min(member, 100) : 100;
    const off = offAt(input.span.start);
    // base × percent × (100 − off), in hundredths of hundredths.
    courtMinor = Math.round((base * percent * (100 - off)) / 10_000);
    lines.push({ kind: "fixed", minutes: length, start: input.span.start, peak, amount: fromMinor(courtMinor) });
  } else {
    if (pricing.billStep) billedMinutes = Math.ceil(length / pricing.billStep) * pricing.billStep;
    if (pricing.minBilled) billedMinutes = Math.max(billedMinutes, pricing.minBilled);
    const billed: Span = { start: input.span.start, end: input.span.start + billedMinutes };
    // Whole numbers throughout: minor units × minutes × percent × (100 − discount).
    let numerator = 0;
    const segment = (from: number, to: number, peak: boolean, off: number) => {
      const r = hourlyMinor(court, peak, member);
      const part = r.minor * (to - from) * r.percent * (100 - off);
      numerator += part;
      lines.push({
        kind: "time",
        start: from,
        minutes: to - from,
        peak,
        rate: fromMinor((r.minor * r.percent * (100 - off)) / 10_000),
        amount: fromMinor(part / (60 * 10_000)),
      });
    };
    if (pricing.rateMode === "start") {
      segment(billed.start, billed.end, isPeakAt(billed.start), offAt(billed.start));
    } else {
      const cuts = boundaries(input.date, billed, rules, discount);
      for (let i = 0; i + 1 < cuts.length; i++) segment(cuts[i], cuts[i + 1], isPeakAt(cuts[i]), offAt(cuts[i]));
    }
    courtMinor = Math.round(numerator / (60 * 10_000));
  }

  courtMinor *= players;
  // A larger booking at a lower price per place, where the venue sets one.
  const percent = players > 1 ? quantityPercent(court.quantityPrices, players) : 100;
  if (percent < 100) {
    const less = courtMinor - Math.round((courtMinor * percent) / 100);
    lines.push({ kind: "quantity", amount: -fromMinor(less) });
    courtMinor -= less;
  }
  if (pricing.minCharge !== null && pricing.minCharge !== undefined && courtMinor < toMinor(pricing.minCharge)) {
    lines.push({ kind: "minimum", amount: fromMinor(toMinor(pricing.minCharge) - courtMinor) });
    courtMinor = toMinor(pricing.minCharge);
  }
  const setup = toMinor(pricing.setupFee ?? 0);
  const cleanup = toMinor(pricing.cleanupFee ?? 0);
  if (setup > 0) lines.push({ kind: "setup", amount: fromMinor(setup) });
  if (cleanup > 0) lines.push({ kind: "cleanup", amount: fromMinor(cleanup) });
  return {
    court: fromMinor(courtMinor),
    fees: fromMinor(setup + cleanup),
    total: fromMinor(courtMinor + setup + cleanup),
    billedMinutes,
    lines,
  };
}

/** Does this court charge members less, at any time? */
export function hasMemberRate(court: Pick<Court, "memberOffPeakRate" | "memberPeakRate">): boolean {
  return court.memberOffPeakRate !== null || court.memberPeakRate !== null;
}
