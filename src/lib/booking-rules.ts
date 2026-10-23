import { activityPolicy } from "./activity-registry";
import { formatLength, formatMinute, type Span } from "./interval";
import type { Sport } from "./types";
import { hoursOn, type WeekHours } from "./week-hours";

/**
 * What may be booked, kept apart from what can be stored (ADR 0010). The
 * engine stores any minute-level interval; a booking policy says which of
 * them a customer may pick on a court: when bookings start, how long they
 * are, the buffers kept around them, the hours, the notice, and how the time
 * is priced.
 *
 * Every setting is inherited where it is not set: the booking product's own
 * (one activity on one court), else the court's, else the activity's at the
 * venue, else the venue's, else its business's, else the activity's usual
 * rules in the catalogue (lib/activity-registry.ts), else the platform's. So a venue says "on the
 * hour" once, and padel there says "every 15 minutes, 60, 75 or 90 minutes"
 * without repeating the rest.
 *
 * Staff with the right to may book outside a policy (lib/store.ts); nobody
 * books over what is already claimed, or into a buffer.
 *
 * This module is the rules alone, safe for the browser; storing and looking
 * up policies is lib/booking-policy.ts.
 */

/** A price for one length outright, instead of by the minute: RM120 for 90 minutes. */
export interface FixedPrice {
  minutes: number;
  price: number;
  /** At peak, where it differs. */
  peakPrice: number | null;
}

export interface PricingPolicy {
  /**
   * "split": each part of a booking at the rate in force then (peak from
   * 18:00 makes 17:30–18:30 half off-peak, half peak). "start": the whole of
   * it at the rate when it starts.
   */
  rateMode: "split" | "start";
  /** Bill the length rounded up to this many minutes; null: exactly as booked. */
  billStep: number | null;
  /** Bill at least this many minutes. */
  minBilled: number | null;
  /** Charge at least this much for the court. */
  minCharge: number | null;
  /** Lengths with a price of their own. */
  fixedPrices: FixedPrice[] | null;
  /** Charged on each booking, apart from the time: setting up, and clearing away. */
  setupFee: number;
  cleanupFee: number;
}

export interface BookingPolicy {
  /** Bookings start every this many minutes from `startOffset` past midnight: 60 is on the hour. */
  startEvery: number;
  startOffset: number;
  /** Or only at these minutes of the day (18:00, 19:30, 21:00), in place of `startEvery`. */
  startTimes: number[] | null;
  /** Lengths go up in steps of this many minutes, from `minLength` to `maxLength`. */
  lengthStep: number;
  minLength: number;
  maxLength: number;
  /** Or only these lengths, in place of the steps. */
  lengths: number[] | null;
  /** What the booking board offers first. */
  defaultLength: number;
  /** Kept free before and after each booking (changeover, cleaning); customers cannot book into them. */
  bufferBefore: number;
  bufferAfter: number;
  /** The court's own hours, weekday by weekday (minutes); null: the venue's. */
  weekHours: WeekHours | null;
  /** How long before it starts a customer may book, at the latest. */
  noticeMinutes: number;
  /** Customers need a staff sign-off for the activity first (lib/sign-offs.ts). */
  signOff: boolean;
  /** Customers need a recorded certification for it (a qualification the law or a governing body asks for), not only a sign-off. */
  certification: boolean;
  pricing: PricingPolicy;
}

/** A level of the inheritance, as stored: every setting may be unset. */
export type PolicySettings = {
  startEvery?: number | null;
  startOffset?: number | null;
  startTimes?: number[] | null;
  lengthStep?: number | null;
  minLength?: number | null;
  maxLength?: number | null;
  lengths?: number[] | null;
  defaultLength?: number | null;
  bufferBefore?: number | null;
  bufferAfter?: number | null;
  weekHours?: WeekHours | null;
  noticeMinutes?: number | null;
  rateMode?: "split" | "start" | null;
  billStep?: number | null;
  minBilled?: number | null;
  minCharge?: number | null;
  fixedPrices?: FixedPrice[] | null;
  setupFee?: number | null;
  cleanupFee?: number | null;
  signOff?: boolean | null;
  certification?: boolean | null;
};

export const SETTING_KEYS = [
  "startEvery",
  "startOffset",
  "startTimes",
  "lengthStep",
  "minLength",
  "maxLength",
  "lengths",
  "defaultLength",
  "bufferBefore",
  "bufferAfter",
  "weekHours",
  "noticeMinutes",
  "rateMode",
  "billStep",
  "minBilled",
  "minCharge",
  "fixedPrices",
  "setupFee",
  "cleanupFee",
  "signOff",
  "certification",
] as const satisfies readonly (keyof PolicySettings)[];

/** The platform's: on the hour, an hour at a time, up to four hours. */
export const PLATFORM_POLICY: Required<{ [K in keyof PolicySettings]: NonNullable<PolicySettings[K]> | null }> = {
  startEvery: 60,
  startOffset: 0,
  startTimes: null,
  lengthStep: 60,
  minLength: 60,
  maxLength: 240,
  lengths: null,
  defaultLength: null,
  bufferBefore: 0,
  bufferAfter: 0,
  weekHours: null,
  noticeMinutes: 0,
  rateMode: "split",
  billStep: null,
  minBilled: null,
  minCharge: null,
  fixedPrices: null,
  setupFee: 0,
  cleanupFee: 0,
  signOff: false,
  certification: false,
};

/** How long a game or session usually is, in minutes (the activity catalogue's, lib/activity-registry.ts). */
export { usualMinutes } from "./activity-registry";

/** The levels a setting is looked for in, most specific first. */
export type PolicyScope =
  | { court: number; sport: Sport }
  | { court: number }
  | { venue: number; sport: Sport }
  | { venue: number }
  | { business: number };

/** Settings from the most specific level down, merged: the first set value wins. */
export function resolvePolicy(levels: PolicySettings[], sport: Sport | null): BookingPolicy {
  // Beneath the venue's levels, the activity's own usual rules (the catalogue), then the platform's.
  const chain = [...levels, ...(sport ? [activityPolicy(sport)] : []), PLATFORM_POLICY as PolicySettings];
  const pick = <K extends keyof PolicySettings>(key: K): NonNullable<PolicySettings[K]> | null => {
    for (const level of chain) {
      const v = level[key];
      if (v !== null && v !== undefined) return v as NonNullable<PolicySettings[K]>;
    }
    return null;
  };
  const minLength = pick("minLength")!;
  const maxLength = Math.max(pick("maxLength")!, minLength);
  const lengths = pick("lengths");
  const usable = lengths?.filter((l) => l >= 1) ?? null;
  const defaultLength = pick("defaultLength") ?? (usable?.length ? usable[0] : Math.min(Math.max(60, minLength), maxLength));
  return {
    startEvery: pick("startEvery")!,
    startOffset: pick("startOffset")!,
    startTimes: pick("startTimes"),
    lengthStep: pick("lengthStep")!,
    minLength,
    maxLength,
    lengths: usable && usable.length > 0 ? [...usable].sort((a, b) => a - b) : null,
    defaultLength,
    bufferBefore: pick("bufferBefore")!,
    bufferAfter: pick("bufferAfter")!,
    weekHours: pick("weekHours"),
    noticeMinutes: pick("noticeMinutes")!,
    signOff: pick("signOff") === true,
    certification: pick("certification") === true,
    pricing: {
      rateMode: pick("rateMode")!,
      billStep: pick("billStep"),
      minBilled: pick("minBilled"),
      minCharge: pick("minCharge"),
      fixedPrices: pick("fixedPrices"),
      setupFee: pick("setupFee")!,
      cleanupFee: pick("cleanupFee")!,
    },
  };
}

// ------------------------------------------------------------ the rules

/** Is `start` a minute bookings may start at? */
export function startAllowed(policy: BookingPolicy, start: number): boolean {
  if (policy.startTimes) return policy.startTimes.includes(start);
  return (((start - policy.startOffset) % policy.startEvery) + policy.startEvery) % policy.startEvery === 0;
}

/** May a booking be this many minutes long? */
export function lengthAllowed(policy: BookingPolicy, minutes: number): boolean {
  if (policy.lengths) return policy.lengths.includes(minutes);
  return minutes >= policy.minLength && minutes <= policy.maxLength && minutes % policy.lengthStep === 0;
}

/** The lengths a booking may be, shortest first, up to `fit` minutes. */
export function lengthsUpTo(
  policy: Pick<BookingPolicy, "lengths" | "minLength" | "maxLength" | "lengthStep">,
  fit: number = policy.maxLength
): number[] {
  if (policy.lengths) return policy.lengths.filter((l) => l <= fit);
  const out: number[] = [];
  const first = Math.ceil(policy.minLength / policy.lengthStep) * policy.lengthStep;
  for (let l = first; l <= Math.min(policy.maxLength, fit); l += policy.lengthStep) out.push(l);
  return out;
}

/** The starts a policy allows within [from, to). */
export function startsWithin(policy: BookingPolicy, from: number, to: number): number[] {
  if (policy.startTimes) return policy.startTimes.filter((s) => s >= from && s < to);
  const out: number[] = [];
  const first = from + ((((policy.startOffset - from) % policy.startEvery) + policy.startEvery) % policy.startEvery);
  for (let s = first; s < to; s += policy.startEvery) out.push(s);
  return out;
}

/**
 * The column width of the booking board for a policy: its start step where
 * that is a sensible grid (15 minutes to an hour), else the largest such that
 * divides it (90-minute starts show as half hours), else 15 with a finer
 * start to pick inside each.
 */
export function gridMinutes(policy: BookingPolicy): number {
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  if (policy.startTimes) {
    const g = policy.startTimes.reduce((acc, s) => gcd(acc, s), 60);
    return g >= 15 ? g : 15;
  }
  const every = policy.startEvery;
  if (every >= 15 && every <= 60 && 60 % every === 0) return every;
  if (every > 60) {
    const g = gcd(every, 60);
    return g >= 15 ? g : 15;
  }
  return 15;
}

/** The hours on a date: the court's own where its policy has them, else the venue's. */
export function policyHoursOn(
  policy: BookingPolicy,
  venue: { openMin: number; closeMin: number; weekHours?: WeekHours | null },
  date: string
): { openMin: number; closeMin: number; closed: boolean } {
  const own = policy.weekHours;
  if (own) return hoursOn({ openMin: venue.openMin, closeMin: venue.closeMin, weekHours: own }, date);
  return hoursOn(venue, date);
}

/** One rule a request does not keep to. */
export type PolicyBreach = "START" | "LENGTH" | "HOURS" | "NOTICE" | "SIGN_OFF";

/**
 * The rules a booking from `start` to `end` breaks. Customers are refused on
 * any; staff allowed to may go ahead, and the breaches are recorded.
 */
export function policyBreaches(
  policy: BookingPolicy,
  span: Span,
  hours: { openMin: number; closeMin: number; closed: boolean },
  /** Minutes from now until it starts. */
  minutesAhead: number
): PolicyBreach[] {
  const out: PolicyBreach[] = [];
  if (!startAllowed(policy, span.start)) out.push("START");
  if (!lengthAllowed(policy, span.end - span.start)) out.push("LENGTH");
  if (hours.closed || span.start < hours.openMin || span.end > hours.closeMin) out.push("HOURS");
  if (minutesAhead < policy.noticeMinutes) out.push("NOTICE");
  return out;
}

/** A breach said to a customer. */
export function breachMessage(policy: BookingPolicy, breach: PolicyBreach): string {
  switch (breach) {
    case "START":
      return policy.startTimes
        ? `Bookings here start at ${policy.startTimes.map(formatMinute).join(", ")}.`
        : policy.startEvery === 60 && policy.startOffset === 0
          ? "Bookings here start on the hour."
          : `Bookings here start every ${formatLength(policy.startEvery)}${policy.startOffset ? `, from ${policy.startOffset} past` : ""}.`;
    case "LENGTH":
      return policy.lengths
        ? `Bookings here are ${policy.lengths.map(formatLength).join(", ")}.`
        : `Bookings here are ${formatLength(policy.minLength)} to ${formatLength(policy.maxLength)}, in steps of ${formatLength(policy.lengthStep)}.`;
    case "HOURS":
      return "That is outside this court's hours.";
    case "NOTICE":
      return `Bookings here are made at least ${formatLength(policy.noticeMinutes)} ahead.`;
    case "SIGN_OFF":
      return policy.certification ? "This needs a recorded certification." : "This needs a staff sign-off.";
  }
}

/** A policy said in a line, for staff: "Starts on the hour; 1–4 hours, by the hour; 10 minutes after". */
export function describePolicy(p: BookingPolicy): string {
  const starts = p.startTimes
    ? `starts at ${p.startTimes.map(formatMinute).join(", ")}`
    : p.startEvery === 60 && p.startOffset === 0
      ? "starts on the hour"
      : `starts every ${formatLength(p.startEvery)}`;
  const lengths = p.lengths
    ? p.lengths.map(formatLength).join(", ")
    : `${formatLength(p.minLength)} to ${formatLength(p.maxLength)}, in ${formatLength(p.lengthStep)} steps`;
  const buffers = [p.bufferBefore ? `${formatLength(p.bufferBefore)} before` : "", p.bufferAfter ? `${formatLength(p.bufferAfter)} after` : ""]
    .filter(Boolean)
    .join(" and ");
  return [starts, lengths, buffers ? `kept free ${buffers}` : ""].filter(Boolean).join("; ");
}
