import { activityPolicy } from "./activity-registry";
import { formatLength, formatMinute, type Span } from "./interval";
import type { Sport } from "./types";
import { hoursFor, hoursOn, type DatedHours, type WeekHours } from "./week-hours";
import { crossesClockChange } from "./time";

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

/**
 * What a shared facility's separation and operational time apply to: each
 * place a booking takes, added together ("place", the default) or the longer
 * of the two ("unit"), or the whole facility ("facility").
 */
export type Turnover = "place" | "unit" | "facility";
export const TURNOVERS: readonly Turnover[] = ["place", "unit", "facility"];

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
  /**
   * Where the time is sold by the game (`BookingPolicy.gameMinutes`): the
   * price of one game, for the resource, or for each player on one priced per
   * player; `gamePeakPrice` where it starts at peak and differs. Null: a game
   * booking costs the time it holds, at the resource's rates.
   */
  gamePrice: number | null;
  gamePeakPrice: number | null;
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
  /**
   * Minimum separation before and after each booking: time kept free that
   * does not add up. Two neighbours need the larger of the two separations
   * that face each other (10 after one and 10 before the next: 10 apart).
   * Customers cannot book into it and are not charged for it.
   */
  bufferBefore: number;
  bufferAfter: number;
  /**
   * Operational time before and after each booking (setting up, preparing;
   * cleaning, turnover): work on the court that adds up, so 10 minutes of
   * cleaning after one and 10 of preparation before the next need 20. Not
   * bookable, not charged (a setup or cleanup fee is a price rule apart).
   */
  operationalBefore: number;
  operationalAfter: number;
  /**
   * On a resource with places, what the separation and operational time apply
   * to (docs/architecture/booking-time-model.md#shared-facilities-how-they-are-turned-over):
   * "place", each place a booking takes, the two added together (the
   * default, as before); "unit", each place, the longer of the two on each
   * side; "facility", the whole facility, kept clear between sessions. A court
   * of one place is the whole of itself whatever this says.
   */
  turnover: Turnover;
  /** The court's own hours, weekday by weekday (minutes); null: the venue's. */
  weekHours: WeekHours | null;
  /** How long before it starts a customer may book, at the latest. */
  noticeMinutes: number;
  /** Customers need a staff sign-off for the activity first (lib/sign-offs.ts). */
  signOff: boolean;
  /** Customers need a recorded certification for it (a qualification the law or a governing body asks for), not only a sign-off. */
  certification: boolean;
  /**
   * One person may be taken off a booking of several, leaving the others
   * booked (lib/place-withdrawals.ts). Yes unless the venue sells the places
   * here as one package.
   */
  separatePlaces: boolean;
  /**
   * Sold by the game rather than by time (a bowling lane): the customer
   * chooses a number of games and players, and the booking holds the lane for
   * the venue's estimate of how long they take (`gameHold`): `gameMinutes` for
   * one game of one player, `gameMinutesEach` more for each further player,
   * times the games, rounded up to `lengthStep`. Null: sold by time.
   */
  gameMinutes: number | null;
  gameMinutesEach: number;
  /** The most games one booking may be for. */
  maxGames: number;
  /**
   * The lane is given when the customer arrives: the booking holds one lane
   * (so the database still refuses overlaps), but it is provisional, never
   * told to the customer before check-in, and the desk may put them on any
   * lane free then (lib/lanes.ts).
   */
  laneOnArrival: boolean;
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
  operationalBefore?: number | null;
  operationalAfter?: number | null;
  turnover?: Turnover | null;
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
  separatePlaces?: boolean | null;
  /** Minutes one game of one player is estimated to take; 0 sets "by time" over a level beneath that sells by the game. */
  gameMinutes?: number | null;
  gameMinutesEach?: number | null;
  maxGames?: number | null;
  laneOnArrival?: boolean | null;
  gamePrice?: number | null;
  gamePeakPrice?: number | null;
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
  "operationalBefore",
  "operationalAfter",
  "turnover",
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
  "separatePlaces",
  "gameMinutes",
  "gameMinutesEach",
  "maxGames",
  "laneOnArrival",
  "gamePrice",
  "gamePeakPrice",
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
  operationalBefore: 0,
  operationalAfter: 0,
  turnover: "place",
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
  separatePlaces: true,
  gameMinutes: null,
  gameMinutesEach: 0,
  maxGames: 10,
  laneOnArrival: false,
  gamePrice: null,
  gamePeakPrice: null,
};

/** The most games a venue may let one booking be for. */
export const MAX_GAMES = 20;

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
    operationalBefore: pick("operationalBefore")!,
    operationalAfter: pick("operationalAfter")!,
    turnover: pick("turnover")!,
    weekHours: pick("weekHours"),
    noticeMinutes: pick("noticeMinutes")!,
    signOff: pick("signOff") === true,
    certification: pick("certification") === true,
    separatePlaces: pick("separatePlaces") !== false,
    // 0 at a level is "by time", over an activity's usual selling by the game.
    gameMinutes: pick("gameMinutes") || null,
    gameMinutesEach: pick("gameMinutesEach") ?? 0,
    maxGames: pick("maxGames") ?? 10,
    laneOnArrival: pick("laneOnArrival") === true,
    pricing: {
      rateMode: pick("rateMode")!,
      billStep: pick("billStep"),
      minBilled: pick("minBilled"),
      minCharge: pick("minCharge"),
      fixedPrices: pick("fixedPrices"),
      setupFee: pick("setupFee")!,
      cleanupFee: pick("cleanupFee")!,
      gamePrice: pick("gamePrice"),
      gamePeakPrice: pick("gamePeakPrice"),
    },
  };
}

// ------------------------------------------------------------ by the game

/** Is the time on a resource with this policy sold by the game? */
export function soldByGame(policy: Pick<BookingPolicy, "gameMinutes">): boolean {
  return policy.gameMinutes !== null && policy.gameMinutes > 0;
}

/**
 * How long a booking of `games` games for `players` players holds the
 * resource: the venue's estimate (one game of one player, and more for each
 * further player), times the games, rounded up to the policy's length step.
 */
export function gameHold(
  policy: Pick<BookingPolicy, "gameMinutes" | "gameMinutesEach" | "lengthStep">,
  games: number,
  players = 1
): number {
  const one = (policy.gameMinutes ?? 0) + policy.gameMinutesEach * Math.max(0, players - 1);
  const step = Math.max(1, policy.lengthStep);
  return Math.max(step, Math.ceil((one * games) / step) * step);
}

/** The games a booking may be for here, 1 to the most, whose hold for `players` fits `fit` minutes. */
export function gamesUpTo(
  policy: Pick<BookingPolicy, "gameMinutes" | "gameMinutesEach" | "lengthStep" | "maxGames">,
  players: number,
  fit = Infinity
): number[] {
  const out: number[] = [];
  for (let g = 1; g <= policy.maxGames; g++) if (gameHold(policy, g, players) <= fit) out.push(g);
  return out;
}

// ------------------------------------------------------------ the rules

/**
 * What a booking under this policy keeps around its time, as availability
 * checks it (`fits` in lib/claims.ts): operational time, which adds up with a
 * neighbour's, and minimum separation, which does not.
 */
export function policyBuffers(p: Pick<BookingPolicy, "bufferBefore" | "bufferAfter" | "operationalBefore" | "operationalAfter"> & { turnover?: Turnover }): {
  before: number;
  after: number;
  sepBefore: number;
  sepAfter: number;
  turnover: Turnover;
} {
  return { before: p.operationalBefore, after: p.operationalAfter, sepBefore: p.bufferBefore, sepAfter: p.bufferAfter, turnover: p.turnover ?? "place" };
}

/** The same, as `claim` in lib/claims.ts takes it. */
export function claimBuffers(p: Pick<BookingPolicy, "bufferBefore" | "bufferAfter" | "operationalBefore" | "operationalAfter"> & { turnover?: Turnover }): {
  bufferBefore: number;
  bufferAfter: number;
  separationBefore: number;
  separationAfter: number;
  turnover: Turnover;
} {
  return {
    bufferBefore: p.operationalBefore,
    bufferAfter: p.operationalAfter,
    separationBefore: p.bufferBefore,
    separationAfter: p.bufferAfter,
    turnover: p.turnover ?? "place",
  };
}

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

/**
 * The lengths a booking may be from one of the board's starts (`StartOption`
 * in lib/types.ts): those it lists, where not every length up to its longest
 * fits (joining a session on a facility turned over whole), else every length
 * the policy allows up to its longest.
 */
export function startLengths(
  policy: Pick<BookingPolicy, "lengths" | "minLength" | "maxLength" | "lengthStep">,
  option: { maxLength: number; lengths?: number[] }
): number[] {
  return option.lengths ? [...option.lengths] : lengthsUpTo(policy, option.maxLength);
}

/** Does this start take a booking of `length` (one the policy allows)? */
export function startTakes(option: { maxLength: number; lengths?: number[] }, length: number): boolean {
  return option.lengths ? option.lengths.includes(length) : length <= option.maxLength;
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

/**
 * The hours on a date: the court's own where its policy has them (a day left
 * on the usual hours taking the venue's usual hours for that date), else the
 * venue's, each as set for that date (ADR 0027).
 */
export function policyHoursOn(policy: BookingPolicy, venue: DatedHours, date: string): { openMin: number; closeMin: number; closed: boolean } {
  const own = policy.weekHours;
  if (own) {
    const usual = hoursFor(venue, date);
    return hoursOn({ openMin: usual.openMin, closeMin: usual.closeMin, weekHours: own }, date);
  }
  return hoursOn(venue, date);
}

/** One rule a request does not keep to. */
export type PolicyBreach = "START" | "LENGTH" | "HOURS" | "NOTICE" | "SIGN_OFF" | "CLOCK" | "MEMBERSHIP";

/**
 * The rules a booking from `start` to `end` breaks. Customers are refused on
 * any; staff allowed to may go ahead, and the breaches are recorded.
 */
export function policyBreaches(
  policy: BookingPolicy,
  span: Span,
  /** The day's hours, and where they are kept: a booking touching a change of the clocks there is refused ("CLOCK"). */
  hours: { openMin: number; closeMin: number; closed: boolean; date?: string; zone?: string },
  /** Minutes from now until it starts. */
  minutesAhead: number
): PolicyBreach[] {
  const out: PolicyBreach[] = [];
  if (!startAllowed(policy, span.start)) out.push("START");
  // Sold by the game, the length is the games' estimated time; how many games is checked instead (lib/store.ts).
  if (!soldByGame(policy) && !lengthAllowed(policy, span.end - span.start)) out.push("LENGTH");
  if (hours.closed || span.start < hours.openMin || span.end > hours.closeMin) out.push("HOURS");
  if (minutesAhead < policy.noticeMinutes) out.push("NOTICE");
  if (hours.date && hours.zone && crossesClockChange(hours.date, span.start, span.end, hours.zone)) out.push("CLOCK");
  return out;
}

/** A breach said to a customer. */
export function breachMessage(policy: BookingPolicy, breach: PolicyBreach): string {
  switch (breach) {
    case "START":
      return policy.startTimes
        ? `Bookings here start at ${policy.startTimes.map((m) => formatMinute(m)).join(", ")}.`
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
    case "CLOCK":
      return "The clocks change during that time: pick a time before or after.";
    case "MEMBERSHIP":
      return "A place on this session is for members, each their own.";
  }
}

/** A policy said in a line, for staff: "Starts on the hour; 1–4 hours, by the hour; 10 minutes after". */
export function describePolicy(p: BookingPolicy): string {
  const starts = p.startTimes
    ? `starts at ${p.startTimes.map((m) => formatMinute(m)).join(", ")}`
    : p.startEvery === 60 && p.startOffset === 0
      ? "starts on the hour"
      : `starts every ${formatLength(p.startEvery)}`;
  const lengths = p.lengths
    ? p.lengths.map(formatLength).join(", ")
    : `${formatLength(p.minLength)} to ${formatLength(p.maxLength)}, in ${formatLength(p.lengthStep)} steps`;
  const around = (before: number, after: number) =>
    [before ? `${formatLength(before)} before` : "", after ? `${formatLength(after)} after` : ""].filter(Boolean).join(" and ");
  const buffers = around(p.bufferBefore, p.bufferAfter);
  const operational = around(p.operationalBefore, p.operationalAfter);
  return [starts, lengths, buffers ? `kept free ${buffers} (shared with neighbours)` : "", operational ? `setup and cleaning ${operational} (adds up)` : ""].filter(Boolean).join("; ");
}
