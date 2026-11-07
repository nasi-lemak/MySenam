import { getDb } from "./db";
import { cancelPolicy, strikesFor } from "./cancel-policy";
import { isLocale, translator, type Locale } from "./i18n";
import { linkIn } from "./link-locale";
import { suspendedOn } from "./membership-suspensions";
import { accountLocale, baseUrl, enqueue } from "./outbox";
import { declaredAdult } from "./player-profiles";
import { siteName } from "./site";
import { addDays, todayISO } from "./time";

/**
 * Customers and staff told what is ending or has been recorded against them (hardening, audit 9 D11 and G16).
 *
 * Until now nothing said that a pass or a membership was about to run out with value left on it, nor that a no-show had been recorded
 * against a number, nor that it had reached the venue's limit: a customer learned of each when the next booking was held or refused.
 * This is the smallest answer, not a campaign engine:
 *
 * - **Staff** read it in the needs-attention list (`expiringSoon`, `lowPasses`, `strikeLines`): passes with entries left, memberships
 *   that will not renew themselves, and gift vouchers that end within EXPIRY_DAYS; passes down to their last LOW_PASS_ENTRIES entries; numbers
 *   that have a strike lately or have reached the venue's limit. Counter-sold items with nobody to write to are seen here too.
 * - **Customers** with an account (an adult, with an email address) are written to once, by email, for each pass or membership that ends
 *   within EXPIRY_DAYS (`tellExpiring`, run by the scheduler), keyed by the item and its end date so an extension earns a new notice and a
 *   second run writes nothing. An item under 7 days old is not written about (a pass sold for a week is not "ending soon" on the day it
 *   is bought), nor a membership that renews itself, has a later term, or is suspended. A booking marked a no-show where the venue
 *   counts strikes is written about once (`tellStrike`): which strike it is, what happens at the limit, and whom to ask.
 *   No WhatsApp: there is no approved template for any of it. An account that said it is under 18 is not written to.
 * - What is not done: gift vouchers have no recipient address (only the buyer's), so they are for staff only; strikes by late
 *   cancellation are the customer's own act and are not written about; no second reminder close to the end.
 */

/** Passes, memberships and vouchers ending within this many days are listed and written about. */
export const EXPIRY_DAYS = 14;
/** A pass with this many entries left or fewer is low. */
export const LOW_PASS_ENTRIES = 2;
/** Strikes recorded within this many days are shown to staff. */
export const STRIKE_RECENT_DAYS = 7;
/** The youngest an item is when it is written about. */
const MIN_AGE_DAYS = 7;
/** A notice is not worth sending a month on. */
const EXPIRES_MINUTES = 30 * 24 * 60;

const scope = (venueIds: number[] | null, col: string) => (venueIds === null ? { sql: "TRUE", args: [] as number[] } : venueIds.length === 0 ? { sql: "FALSE", args: [] as number[] } : { sql: `${col} IN (${venueIds.map(() => "?").join(",")})`, args: venueIds });

export interface Expiring {
  kind: "pass" | "membership" | "voucher";
  id: number;
  code: string;
  venueId: number;
  venueName: string;
  /** What it is: a pass's name, a membership's holder, a voucher's amount. */
  what: string;
  /** First name of the holder, where there is one. */
  holder: string | null;
  expiresOn: string;
  daysLeft: number;
  /** A pass: entries left. A voucher: its amount. */
  left: number | null;
  /** Whether MySenam writes to the holder (an account with an address) or it is left to staff. */
  told: boolean;
}

const firstName = (name: string | null) => (name ? (name.trim().split(/\s+/)[0] ?? name) : null);
const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

/** Passes with entries left, memberships that will not renew, and active gift vouchers that end within `days`: soonest first. */
export async function expiringSoon(venueIds: number[] | null, days = EXPIRY_DAYS, today = todayISO()): Promise<Expiring[]> {
  const db = getDb();
  const until = addDays(today, days);
  const out: Expiring[] = [];
  const pv = scope(venueIds, "p.venue_id");
  const passes = (await db
    .prepare(
      `SELECT p.id, p.code, p.venue_id, v.name AS venue, p.name, p.holder_name, p.user_id, p.expires_on,
              p.entries + COALESCE((SELECT SUM(e.delta) FROM pass_entries e WHERE e.pass_id = p.id), 0) AS left
         FROM passes p JOIN venues v ON v.id = p.venue_id
        WHERE p.status = 'active' AND p.expires_on BETWEEN ? AND ? AND ${pv.sql}
          AND p.entries + COALESCE((SELECT SUM(e.delta) FROM pass_entries e WHERE e.pass_id = p.id), 0) > 0
        ORDER BY p.expires_on, p.id LIMIT 200`
    )
    .all(today, until, ...pv.args)) as { id: number; code: string; venue_id: number; venue: string; name: string; holder_name: string | null; user_id: number | null; expires_on: string; left: number | string }[];
  for (const p of passes)
    out.push({
      kind: "pass", id: p.id, code: p.code, venueId: p.venue_id, venueName: p.venue, what: p.name, holder: firstName(p.holder_name), expiresOn: p.expires_on,
      daysLeft: daysBetween(today, p.expires_on), left: Number(p.left), told: p.user_id !== null,
    });
  const mv = scope(venueIds, "m.venue_id");
  const memberships = (await db
    .prepare(
      `SELECT m.id, m.code, m.venue_id, v.name AS venue, m.holder_name, m.user_id, m.expires_on
         FROM memberships m JOIN venues v ON v.id = m.venue_id
        WHERE m.status = 'active' AND m.expires_on BETWEEN ? AND ? AND ${mv.sql}
          AND NOT ${suspendedOn("m")}
          -- One that renews itself, or has a later term, is not ending.
          AND NOT EXISTS (SELECT 1 FROM membership_subscriptions s WHERE s.membership_id = m.id AND s.status = 'active')
          AND NOT EXISTS (SELECT 1 FROM memberships n WHERE n.venue_id = m.venue_id AND n.id <> m.id AND n.status = 'active' AND n.holder_phone = m.holder_phone AND n.expires_on > m.expires_on)
        ORDER BY m.expires_on, m.id LIMIT 200`
    )
    .all(today, until, ...mv.args, today, today)) as { id: number; code: string; venue_id: number; venue: string; holder_name: string | null; user_id: number | null; expires_on: string }[];
  for (const m of memberships)
    out.push({
      kind: "membership", id: m.id, code: m.code, venueId: m.venue_id, venueName: m.venue, what: m.code, holder: firstName(m.holder_name), expiresOn: m.expires_on,
      daysLeft: daysBetween(today, m.expires_on), left: null, told: m.user_id !== null,
    });
  const gv = scope(venueIds, "g.venue_id");
  const vouchers = (await db
    .prepare(
      `SELECT g.id, g.code, g.venue_id, v.name AS venue, g.amount::float AS amount, g.recipient_name, g.expires_on
         FROM gift_vouchers g JOIN venues v ON v.id = g.venue_id
        WHERE g.status = 'active' AND g.expires_on BETWEEN ? AND ? AND ${gv.sql}
        ORDER BY g.expires_on, g.id LIMIT 200`
    )
    .all(today, until, ...gv.args)) as { id: number; code: string; venue_id: number; venue: string; amount: number; recipient_name: string | null; expires_on: string }[];
  for (const g of vouchers)
    out.push({
      kind: "voucher", id: g.id, code: g.code, venueId: g.venue_id, venueName: g.venue, what: g.code, holder: firstName(g.recipient_name), expiresOn: g.expires_on,
      daysLeft: daysBetween(today, g.expires_on), left: g.amount, told: false,
    });
  return out.sort((a, b) => a.daysLeft - b.daysLeft || a.venueId - b.venueId || a.id - b.id);
}

export interface LowPass {
  id: number;
  code: string;
  venueId: number;
  venueName: string;
  what: string;
  holder: string | null;
  left: number;
  expiresOn: string;
}

/** Passes still good with one or two entries left, fewest first. */
export async function lowPasses(venueIds: number[] | null, today = todayISO()): Promise<LowPass[]> {
  const pv = scope(venueIds, "p.venue_id");
  const rows = (await getDb()
    .prepare(
      `SELECT p.id, p.code, p.venue_id, v.name AS venue, p.name, p.holder_name, p.expires_on,
              p.entries + COALESCE((SELECT SUM(e.delta) FROM pass_entries e WHERE e.pass_id = p.id), 0) AS remaining
         FROM passes p JOIN venues v ON v.id = p.venue_id
        WHERE p.status = 'active' AND p.expires_on >= ? AND ${pv.sql}
          AND p.entries + COALESCE((SELECT SUM(e.delta) FROM pass_entries e WHERE e.pass_id = p.id), 0) BETWEEN 1 AND ?
        ORDER BY remaining, p.expires_on, p.id LIMIT 200`
    )
    .all(today, ...pv.args, LOW_PASS_ENTRIES)) as { id: number; code: string; venue_id: number; venue: string; name: string; holder_name: string | null; expires_on: string; remaining: number | string }[];
  return rows.map((r) => ({ id: r.id, code: r.code, venueId: r.venue_id, venueName: r.venue, what: r.name, holder: firstName(r.holder_name), left: Number(r.remaining), expiresOn: r.expires_on }));
}

export interface StrikeLine {
  venueId: number;
  venueName: string;
  /** First name on the booking. */
  name: string;
  phone: string;
  strikes: number;
  limit: number;
  /** At the venue's limit: pays online to book (or books at the counter). */
  out: boolean;
  lastOn: string;
}

/**
 * Numbers with a strike in the last STRIKE_RECENT_DAYS days, and every number at the venue's limit, at venues that count strikes
 * (`strikesFor`: a no-show, or a late cancellation nobody paid for; forgiven ones and test bookings left out): most strikes first.
 */
export async function strikeLines(venueIds: number[] | null, today = todayISO()): Promise<StrikeLine[]> {
  const cv = scope(venueIds, "c.venue_id");
  const rows = (await getDb()
    .prepare(
      `SELECT c.venue_id, v.name AS venue, b.phone_key, MAX(b.name) AS name, MAX(b.phone) AS phone, COUNT(*)::int AS strikes, v.strike_limit, MAX(b.date) AS last_on
         FROM bookings b JOIN courts c ON c.id = b.court_id JOIN venues v ON v.id = c.venue_id
        WHERE v.strike_limit IS NOT NULL AND ${cv.sql} AND NOT b.test AND b.demo = 0
          AND b.date >= to_char(?::date - v.strike_days, 'YYYY-MM-DD') AND b.date <= ?
          AND b.date > COALESCE((SELECT forgiven_on FROM strike_forgiveness f WHERE f.venue_id = c.venue_id AND f.phone_key = b.phone_key), '')
          AND (b.no_show = 1 OR (b.late_cancelled = 1 AND b.payment_status <> 'paid' AND b.deposit_paid = 0))
        GROUP BY c.venue_id, v.name, b.phone_key, v.strike_limit, v.strike_days
       HAVING COUNT(*) >= v.strike_limit OR MAX(b.date) >= ?
        ORDER BY 6 DESC, last_on DESC LIMIT 100`
    )
    .all(...cv.args, today, today, addDays(today, -STRIKE_RECENT_DAYS))) as {
    venue_id: number; venue: string; name: string; phone: string; strikes: number; strike_limit: number; last_on: string;
  }[];
  return rows.map((r) => ({
    venueId: r.venue_id, venueName: r.venue, name: firstName(r.name) ?? r.name, phone: r.phone, strikes: r.strikes, limit: r.strike_limit,
    out: r.strikes >= r.strike_limit, lastOn: r.last_on,
  }));
}

// ------------------------------------------------------------ writing to customers

/** Where a notice about this account goes: its address and language, or null (no address, or an account that said it is under 18). */
async function accountReader(userId: number): Promise<{ email: string; locale: Locale; name: string } | null> {
  const user = (await getDb().prepare("SELECT email, name FROM users WHERE id = ?").get(userId)) as { email: string | null; name: string } | undefined;
  if (!user?.email || (await declaredAdult(userId)) === false) return null;
  return { email: user.email, locale: await accountLocale(userId), name: firstName(user.name) ?? user.name };
}

/** Queue one email in the reader's language: `key.s` for the subject and `key.b` for the body, under `dedupeKey`. */
async function write(venueId: number, to: { email: string; locale: Locale; name: string }, key: string, vars: Record<string, string | number>, link: string, dedupeKey: string): Promise<void> {
  const t = translator(to.locale, siteName());
  const text = `${t("mail.hi", { name: to.name })}\n\n${t(`${key}.b` as "ppl.mail.expiry.pass.b", { ...vars, link: linkIn(link, to.locale) })}\n\n${siteName()}`;
  await enqueue({
    venueId,
    kind: "customer_notice",
    channel: "email",
    recipient: to.email,
    locale: to.locale,
    subject: "msg.programmeSubject",
    body: "msg.programmeBody",
    vars: { subject: t(`${key}.s` as "ppl.mail.expiry.pass.s", vars), text },
    dedupeKey,
    expiresMinutes: EXPIRES_MINUTES,
  });
}

let looked = 0;

/**
 * Write once about each pass and membership of an account that ends within EXPIRY_DAYS (see the top). Looks at most every 30 minutes
 * unless asked to (`force`). Answers how many were written.
 */
export async function tellExpiring(now = new Date(), force = false): Promise<number> {
  if (!force && now.getTime() - looked < 30 * 60_000) return 0;
  looked = now.getTime();
  const today = now.toISOString().slice(0, 10);
  const db = getDb();
  const link = `${baseUrl()}/account`;
  let written = 0;
  const old = `datetime('now', '-${MIN_AGE_DAYS} days')`;
  const passes = (await db
    .prepare(
      `SELECT p.id, p.venue_id, v.name AS venue, p.name, p.user_id, p.expires_on,
              p.entries + COALESCE((SELECT SUM(e.delta) FROM pass_entries e WHERE e.pass_id = p.id), 0) AS left
         FROM passes p JOIN venues v ON v.id = p.venue_id
        WHERE p.status = 'active' AND p.user_id IS NOT NULL AND p.expires_on BETWEEN ? AND ? AND p.created_at <= ${old}
          AND p.entries + COALESCE((SELECT SUM(e.delta) FROM pass_entries e WHERE e.pass_id = p.id), 0) > 0
          AND v.suspended_at IS NULL
        ORDER BY p.id LIMIT 500`
    )
    .all(today, addDays(today, EXPIRY_DAYS))) as { id: number; venue_id: number; venue: string; name: string; user_id: number; expires_on: string; left: number | string }[];
  for (const p of passes) {
    const reader = await accountReader(p.user_id);
    if (!reader) continue;
    await write(p.venue_id, reader, "ppl.mail.expiry.pass", { venue: p.venue, what: p.name, date: p.expires_on, left: Number(p.left) }, link, `expiring:pass:${p.id}:${p.expires_on}`);
    written++;
  }
  const rows = (await db
    .prepare(
      `SELECT m.id, m.venue_id, v.name AS venue, m.user_id, m.expires_on
         FROM memberships m JOIN venues v ON v.id = m.venue_id
        WHERE m.status = 'active' AND m.user_id IS NOT NULL AND m.expires_on BETWEEN ? AND ? AND m.created_at <= ${old} AND v.suspended_at IS NULL
          AND NOT ${suspendedOn("m")}
          AND NOT EXISTS (SELECT 1 FROM membership_subscriptions s WHERE s.membership_id = m.id AND s.status = 'active')
          AND NOT EXISTS (SELECT 1 FROM memberships n WHERE n.venue_id = m.venue_id AND n.id <> m.id AND n.status = 'active' AND n.holder_phone = m.holder_phone AND n.expires_on > m.expires_on)
        ORDER BY m.id LIMIT 500`
    )
    .all(today, addDays(today, EXPIRY_DAYS), today, today)) as { id: number; venue_id: number; venue: string; user_id: number; expires_on: string }[];
  for (const m of rows) {
    const reader = await accountReader(m.user_id);
    if (!reader) continue;
    await write(m.venue_id, reader, "ppl.mail.expiry.membership", { venue: m.venue, date: m.expires_on }, link, `expiring:membership:${m.id}:${m.expires_on}`);
    written++;
  }
  return written;
}

/**
 * A booking staff marked a no-show, where the venue counts strikes: its customer is written to once, by email, with which strike it is
 * and what happens at the limit, and told whom to ask if it is a mistake. An account's own address (an adult's); a guest's, on the
 * booking. Nothing for a venue that does not count strikes, a test booking, or a customer with no address.
 */
export async function tellStrike(bookingCode: string): Promise<boolean> {
  const db = getDb();
  const b = (await db
    .prepare(
      `SELECT b.id, b.code, b.date, b.name, b.phone, b.email, b.user_id, b.locale, b.no_show, b.test, b.demo, c.venue_id, v.name AS venue, v.phone AS venue_phone
         FROM bookings b JOIN courts c ON c.id = b.court_id JOIN venues v ON v.id = c.venue_id WHERE UPPER(b.code) = UPPER(?)`
    )
    .get(bookingCode)) as
    | { id: number; code: string; date: string; name: string; phone: string; email: string | null; user_id: number | null; locale: string | null; no_show: number; test: boolean; demo: number; venue_id: number; venue: string; venue_phone: string }
    | undefined;
  if (!b || b.no_show !== 1 || b.test || b.demo) return false;
  const policy = await cancelPolicy(b.venue_id);
  if (policy.strikeLimit === null) return false;
  const reader = b.user_id !== null ? await accountReader(b.user_id) : null;
  if (b.user_id !== null && !reader) return false;
  const email = (reader?.email ?? b.email ?? "").trim();
  if (!email) return false;
  const locale: Locale = reader?.locale ?? (isLocale(b.locale) ? b.locale : "en");
  const strikes = await strikesFor(b.venue_id, b.phone, policy.strikeDays);
  const out = strikes >= policy.strikeLimit;
  await write(
    b.venue_id,
    { email, locale, name: reader?.name ?? firstName(b.name) ?? "" },
    out ? "ppl.mail.strikeOut" : "ppl.mail.strike",
    { venue: b.venue, code: b.code, date: b.date, n: strikes, limit: policy.strikeLimit, days: policy.strikeDays, phone: b.venue_phone },
    b.user_id !== null ? `${baseUrl()}/account` : `${baseUrl()}/my-booking`,
    `strike:${b.id}`
  );
  return true;
}
