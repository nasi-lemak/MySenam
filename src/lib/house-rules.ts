import { getDb } from "./db";
import { errorText, translator, type ErrorCode } from "./i18n";
import { addDays, todayISO } from "./time";
import { MAX_ADVANCE_DAYS, MAX_RECUR_WEEKS, MAX_SERIES_WEEKS, MAX_VENUE_AHEAD_DAYS, type Refusal } from "./types";
import { phoneKey } from "./phone";

/**
 * A venue's fair-use rules for booking online: how many bookings one person —
 * or one household — may have coming up at once, in a week, or on a day, and
 * how far ahead they may book. A condominium's single tennis court, or a
 * club's peak hours, should not belong to whoever books fastest.
 *
 * "One household" is the people a venue's list gives the same unit
 * (lib/access.ts): a family sharing unit A-12-3 shares its allowance. Anybody
 * else is counted by their own number and account. Only court bookings are
 * counted; a class place asked for is checked against them as one more. Every
 * path asks them: online, the counter and the venue's API key (lib/limits.ts
 * `policyCheck`); a manager may go past the limits for one booking where the
 * venue allows it (lib/policy-overrides.ts).
 *
 * How far ahead: the site's 14 days unless the venue says otherwise, from
 * today only up to 90 days. Its members (a live membership, lib/store.ts
 * `activeMembership`) may be given a longer window than everybody else, so
 * they have first pick of the courts before the rest can book them.
 */

export interface HouseRules {
  /** Bookings coming up at once. */
  upcoming: number | null;
  /** Bookings in one week, Monday to Sunday. */
  perWeek: number | null;
  perDay: number | null;
  /** How many days ahead may be booked; 0 is today only. Null: the site's window. */
  aheadDays: number | null;
  /** How many days ahead members may book, further than everybody else. Null: the same. */
  memberAheadDays: number | null;
  /**
   * The most weeks one weekly booking may run, staff's too; null: eight. Not a
   * fair-use limit (it is no reason to show the rules), but kept with them.
   */
  seriesWeeks: number | null;
}

export const NO_RULES: HouseRules = { upcoming: null, perWeek: null, perDay: null, aheadDays: null, memberAheadDays: null, seriesWeeks: null };

const ENGLISH = translator("en");
function refuse(code: ErrorCode, n: number, vars: Record<string, number> = {}): Refusal {
  return { ok: false, error: errorText(ENGLISH, code, { n, ...vars }), code, vars: { n, ...vars } };
}

/** How many days ahead everybody may book here. */
export function publicAhead(rules: HouseRules): number {
  return Math.min(rules.aheadDays ?? MAX_ADVANCE_DAYS, MAX_VENUE_AHEAD_DAYS);
}

/** How many days ahead the venue's members may book. */
export function memberAhead(rules: HouseRules): number {
  return Math.max(publicAhead(rules), Math.min(rules.memberAheadDays ?? 0, MAX_VENUE_AHEAD_DAYS));
}

/** The furthest ahead any member books here: the venue's members' window, or a tier's own, whichever is further. */
async function anyMemberAhead(venueId: number, rules: HouseRules): Promise<number> {
  // Imported here, not at the top: lib/membership-plans.ts reads lib/store.ts, which reads this module.
  const { longestPlanWindow } = await import("./membership-plans");
  return Math.max(memberAhead(rules), Math.min((await longestPlanWindow(venueId)) ?? 0, MAX_VENUE_AHEAD_DAYS));
}

/** The furthest ahead anybody may book this venue: the outer edge every booking is checked against. */
export async function venueAheadDays(venueId: number): Promise<number> {
  return anyMemberAhead(venueId, await houseRules(venueId));
}

/** How many days ahead these numbers may book here: a member's window (their tier's, where it has one), or everybody's. */
export async function windowFor(venueId: number, phones: (string | null | undefined)[], rules?: HouseRules): Promise<number> {
  const r = rules ?? (await houseRules(venueId));
  const membership = await membershipHere(venueId, phones);
  if (!membership) return publicAhead(r);
  return Math.max(publicAhead(r), Math.min(membership.aheadDays ?? memberAhead(r), MAX_VENUE_AHEAD_DAYS));
}

/** How many days ahead this account (or nobody signed in) may book here. */
export async function aheadFor(venueId: number, userId: number | null): Promise<number> {
  const rules = await houseRules(venueId);
  if (userId === null || (await anyMemberAhead(venueId, rules)) === publicAhead(rules)) return publicAhead(rules);
  const user = (await getDb().prepare("SELECT phone FROM users WHERE id = ?").get(userId)) as { phone: string } | undefined;
  const { memberNumberTrusted } = await import("./store");
  if (!user || !(await memberNumberTrusted(user.phone, { userId, by: "customer" }))) return publicAhead(rules);
  return windowFor(venueId, [user.phone], rules);
}

/** The live membership here this number, or the account's, holds. */
async function membershipHere(venueId: number, phones: (string | null | undefined)[]) {
  // Imported here, not at the top: lib/store.ts reads from this module.
  const { activeMembership } = await import("./store");
  for (const phone of phones) {
    const m = phone ? await activeMembership(venueId, phone) : null;
    if (m) return m;
  }
  return null;
}

/** Does this number, or the account's, hold a live membership here? */
export async function isMemberHere(venueId: number, phones: (string | null | undefined)[]): Promise<boolean> {
  return (await membershipHere(venueId, phones)) !== null;
}

export async function houseRules(venueId: number): Promise<HouseRules> {
  const row = (await getDb()
    .prepare("SELECT limit_upcoming, limit_per_week, limit_per_day, book_ahead_days, member_ahead_days, series_weeks FROM venues WHERE id = ?")
    .get(venueId)) as
    | {
        limit_upcoming: number | null;
        limit_per_week: number | null;
        limit_per_day: number | null;
        book_ahead_days: number | null;
        member_ahead_days: number | null;
        series_weeks: number | null;
      }
    | undefined;
  if (!row) return NO_RULES;
  return {
    upcoming: row.limit_upcoming,
    perWeek: row.limit_per_week,
    perDay: row.limit_per_day,
    aheadDays: row.book_ahead_days,
    memberAheadDays: row.member_ahead_days,
    seriesWeeks: row.series_weeks ?? null,
  };
}

/** The most weeks one weekly booking may run here. */
export async function seriesWeeks(venueId: number): Promise<number> {
  return (await houseRules(venueId)).seriesWeeks ?? MAX_RECUR_WEEKS;
}

export function hasRules(r: HouseRules): boolean {
  return r.upcoming !== null || r.perWeek !== null || r.perDay !== null || r.aheadDays !== null || r.memberAheadDays !== null;
}

export async function setHouseRules(venueId: number, input: Partial<Record<keyof HouseRules, unknown>>): Promise<
  { ok: true; rules: HouseRules } | { ok: false; error: string }
> {
  const read = (v: unknown, min: number, max: number, what: string): number | null | string => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isInteger(n) && n >= min && n <= max ? n : `${what} must be a whole number, ${min}–${max}, or blank for no limit.`;
  };
  const rules = {
    upcoming: read(input.upcoming, 1, 50, "Bookings at once"),
    perWeek: read(input.perWeek, 1, 50, "Bookings a week"),
    perDay: read(input.perDay, 1, 20, "Bookings a day"),
    aheadDays: read(input.aheadDays, 0, MAX_VENUE_AHEAD_DAYS, "Days ahead"),
    memberAheadDays: read(input.memberAheadDays, 1, MAX_VENUE_AHEAD_DAYS, "Days ahead for members"),
    seriesWeeks: read(input.seriesWeeks, 2, MAX_SERIES_WEEKS, "Weeks in a weekly booking"),
  };
  for (const v of Object.values(rules)) if (typeof v === "string") return { ok: false, error: v };
  const r = rules as HouseRules;
  if (r.memberAheadDays !== null && r.memberAheadDays <= publicAhead(r))
    return { ok: false, error: `Members' days ahead must be more than everybody else's (${publicAhead(r)}), or blank.` };
  await getDb()
    .prepare(
      "UPDATE venues SET limit_upcoming = ?, limit_per_week = ?, limit_per_day = ?, book_ahead_days = ?, member_ahead_days = ?, series_weeks = ? WHERE id = ?"
    )
    .run(r.upcoming, r.perWeek, r.perDay, r.aheadDays, r.memberAheadDays, r.seriesWeeks, venueId);
  return { ok: true, rules: await houseRules(venueId) };
}

/** The last day this venue may be booked for, today, by everybody or by a member. */
export function lastBookableDay(rules: HouseRules, today = todayISO(), member = false): string {
  return addDays(today, member ? memberAhead(rules) : publicAhead(rules));
}

/** Monday of the week a date falls in. */
function weekOf(date: string): string {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addDays(date, -((day + 6) % 7));
}

/**
 * Why this customer may not book these dates here, or null. `phone` is the
 * number on the booking, `userId` the account making it; both count, with
 * everybody sharing a unit with either. `excluding` is a booking being moved,
 * which should not count against itself.
 */
export async function houseRuleRefusal(input: {
  venueId: number;
  phone: string;
  userId?: number | null;
  dates: string[];
  excluding?: number;
  /** Booked online: a member's longer window only for a number the account has proved or is linked to (lib/store.ts). */
  online?: boolean;
  /**
   * A member's or resident's guest booked at the counter or through the API
   * (lib/guest-invites.ts): the host's number, so the booking counts with the
   * host's household even before the guest is on the list. Not the host's
   * window: the guest books as far ahead as anybody.
   */
  host?: string;
}): Promise<Refusal | null> {
  const rules = await houseRules(input.venueId);
  if (input.dates.length === 0) return null;
  // A tier's longer window is a rule too, even at a venue with none of its own.
  const membersAhead = await anyMemberAhead(input.venueId, rules);
  if (!hasRules(rules) && membersAhead === publicAhead(rules)) return null;
  const today = todayISO();
  const db = getDb();
  const account = input.userId
    ? ((await db.prepare("SELECT phone FROM users WHERE id = ?").get(input.userId)) as { phone: string } | undefined)?.phone
    : undefined;
  if (input.dates.some((d) => d > lastBookableDay(rules, today))) {
    // Past everybody's window: only a member, and only inside theirs (their tier's, where it has one).
    if (membersAhead === publicAhead(rules) || input.dates.some((d) => d > addDays(today, membersAhead)))
      return refuse("LIMIT_AHEAD", membersAhead);
    const { memberNumberTrusted } = await import("./store");
    const phones: (string | undefined)[] = [];
    for (const p of [input.phone, account])
      if (p && (!input.online || (await memberNumberTrusted(p, { userId: input.userId, by: "customer" })))) phones.push(p);
    if (!(await isMemberHere(input.venueId, phones)))
      return refuse("LIMIT_AHEAD_MEMBERS", publicAhead(rules), { m: membersAhead });
    const theirs = await windowFor(input.venueId, phones, rules);
    if (input.dates.some((d) => d > addDays(today, theirs))) return refuse("LIMIT_AHEAD", theirs);
  }
  if (rules.upcoming === null && rules.perWeek === null && rules.perDay === null) return null;

  const phones = [input.phone, ...(account ? [account] : []), ...(input.host ? [input.host] : [])];
  // Everybody on the venue's list in the same unit as either number, or as
  // the entry linked to the account, and a resident's own guests, who share
  // the resident's allowance.
  const household = (await db
    .prepare(
      `SELECT DISTINCT b.phone_key AS key FROM venue_access_list a
         JOIN venue_access_list b ON b.venue_id = a.venue_id
          AND (b.label = a.label OR COALESCE(b.invited_by, b.id) = COALESCE(a.invited_by, a.id))
        WHERE a.venue_id = ? AND (a.phone_key IN (${phones.map(() => "phone_key(?)").join(",")})${input.userId ? " OR a.user_id = ?" : ""})`
    )
    .all(input.venueId, ...phones, ...(input.userId ? [input.userId] : []))) as { key: string }[];
  const keys = [...new Set([...phones.map(phoneKey), ...household.map((h) => h.key)])];
  const first = input.dates.reduce((a, b) => (a < b ? a : b));
  const from = [today, weekOf(first)].sort()[0];
  const rows = (await db
    .prepare(
      `SELECT b.date FROM bookings b JOIN courts c ON c.id = b.court_id
        WHERE c.venue_id = ? AND b.status = 'confirmed' AND b.class_id IS NULL AND b.date >= ?
          AND b.id <> ?
          AND (b.phone_key IN (${keys.map(() => "?").join(",")})${input.userId ? " OR b.user_id = ?" : ""})`
    )
    .all(input.venueId, from, input.excluding ?? 0, ...keys, ...(input.userId ? [input.userId] : []))) as { date: string }[];
  const held = rows.map((r) => r.date);

  if (rules.upcoming !== null) {
    const ahead = held.filter((d) => d >= today).length;
    if (ahead + input.dates.length > rules.upcoming) return refuse("LIMIT_UPCOMING", rules.upcoming);
  }
  for (const date of input.dates) {
    if (rules.perWeek !== null) {
      const week = weekOf(date);
      const inWeek = held.filter((d) => weekOf(d) === week).length + input.dates.filter((d) => weekOf(d) === week).length;
      if (inWeek > rules.perWeek) return refuse("LIMIT_WEEK", rules.perWeek);
    }
    if (rules.perDay !== null) {
      const onDay = held.filter((d) => d === date).length + input.dates.filter((d) => d === date).length;
      if (onDay > rules.perDay) return refuse("LIMIT_DAY", rules.perDay);
    }
  }
  return null;
}
