import { getDb } from "./db";
import { errorText, translator, type ErrorCode } from "./i18n";
import { addDays, todayISO } from "./time";
import { MAX_ADVANCE_DAYS, MAX_VENUE_AHEAD_DAYS, type Refusal } from "./types";
import { phoneKey } from "./phone";

/**
 * A venue's fair-use rules for booking online: how many bookings one person —
 * or one household — may have coming up at once, in a week, or on a day, and
 * how far ahead they may book. A condominium's single tennis court, or a
 * club's peak hours, should not belong to whoever books fastest.
 *
 * "One household" is the people a venue's list gives the same unit
 * (lib/access.ts): a family sharing unit A-12-3 shares its allowance. Anybody
 * else is counted by their own number and account. Only court bookings count
 * (a class place is limited by the class). Staff booking at the counter are
 * not held to these.
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
}

export const NO_RULES: HouseRules = { upcoming: null, perWeek: null, perDay: null, aheadDays: null, memberAheadDays: null };

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

/** The furthest ahead anybody may book this venue: the outer edge every booking is checked against. */
export async function venueAheadDays(venueId: number): Promise<number> {
  return memberAhead(await houseRules(venueId));
}

/** How many days ahead this account (or nobody signed in) may book here. */
export async function aheadFor(venueId: number, userId: number | null): Promise<number> {
  const rules = await houseRules(venueId);
  if (memberAhead(rules) === publicAhead(rules) || userId === null) return publicAhead(rules);
  const user = (await getDb().prepare("SELECT phone FROM users WHERE id = ?").get(userId)) as { phone: string } | undefined;
  return (await isMemberHere(venueId, [user?.phone])) ? memberAhead(rules) : publicAhead(rules);
}

/** Does this number, or the account's, hold a live membership here? */
export async function isMemberHere(venueId: number, phones: (string | null | undefined)[]): Promise<boolean> {
  // Imported here, not at the top: lib/store.ts reads from this module.
  const { activeMembership } = await import("./store");
  for (const phone of phones) if (phone && (await activeMembership(venueId, phone))) return true;
  return false;
}

export async function houseRules(venueId: number): Promise<HouseRules> {
  const row = (await getDb()
    .prepare("SELECT limit_upcoming, limit_per_week, limit_per_day, book_ahead_days, member_ahead_days FROM venues WHERE id = ?")
    .get(venueId)) as
    | {
        limit_upcoming: number | null;
        limit_per_week: number | null;
        limit_per_day: number | null;
        book_ahead_days: number | null;
        member_ahead_days: number | null;
      }
    | undefined;
  if (!row) return NO_RULES;
  return {
    upcoming: row.limit_upcoming,
    perWeek: row.limit_per_week,
    perDay: row.limit_per_day,
    aheadDays: row.book_ahead_days,
    memberAheadDays: row.member_ahead_days,
  };
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
  };
  for (const v of Object.values(rules)) if (typeof v === "string") return { ok: false, error: v };
  const r = rules as HouseRules;
  if (r.memberAheadDays !== null && r.memberAheadDays <= publicAhead(r))
    return { ok: false, error: `Members' days ahead must be more than everybody else's (${publicAhead(r)}), or blank.` };
  await getDb()
    .prepare(
      "UPDATE venues SET limit_upcoming = ?, limit_per_week = ?, limit_per_day = ?, book_ahead_days = ?, member_ahead_days = ? WHERE id = ?"
    )
    .run(r.upcoming, r.perWeek, r.perDay, r.aheadDays, r.memberAheadDays, venueId);
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
}): Promise<Refusal | null> {
  const rules = await houseRules(input.venueId);
  if (!hasRules(rules) || input.dates.length === 0) return null;
  const today = todayISO();
  const db = getDb();
  const account = input.userId
    ? ((await db.prepare("SELECT phone FROM users WHERE id = ?").get(input.userId)) as { phone: string } | undefined)?.phone
    : undefined;
  if (input.dates.some((d) => d > lastBookableDay(rules, today))) {
    // Past everybody's window: only a member, and only inside theirs.
    const members = memberAhead(rules);
    if (members === publicAhead(rules) || input.dates.some((d) => d > lastBookableDay(rules, today, true)))
      return refuse("LIMIT_AHEAD", members);
    if (!(await isMemberHere(input.venueId, [input.phone, account])))
      return refuse("LIMIT_AHEAD_MEMBERS", publicAhead(rules), { m: members });
  }
  if (rules.upcoming === null && rules.perWeek === null && rules.perDay === null) return null;

  const phones = [input.phone, ...(account ? [account] : [])];
  // Everybody on the venue's list in the same unit as either number, and a
  // resident's own guests, who share the resident's allowance.
  const household = (await db
    .prepare(
      `SELECT DISTINCT b.phone_key AS key FROM venue_access_list a
         JOIN venue_access_list b ON b.venue_id = a.venue_id
          AND (b.label = a.label OR COALESCE(b.invited_by, b.id) = COALESCE(a.invited_by, a.id))
        WHERE a.venue_id = ? AND a.phone_key IN (${phones.map(() => "phone_key(?)").join(",")})`
    )
    .all(input.venueId, ...phones)) as { key: string }[];
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
