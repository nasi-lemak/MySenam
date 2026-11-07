import { getDb } from "./db";
import { isLocale, offeredLocales, type Locale } from "./i18n";
import { enqueue } from "./outbox";
import { bookingAlerts } from "./notify";
import { addDays, isValidDateString, todayISO } from "./time";

/**
 * Private hire: a tournament, a company sports day, a birthday party, a
 * school's sports day. Not a slot on the grid but a conversation: the date
 * may move, it may want every court, and the price is the venue's to quote.
 *
 * So the venue's page asks what they have in mind and passes it on: to the
 * dashboard, where staff mark it replied, booked or declined, and by email to
 * the address the venue gave for new bookings. Staff answer by phone, WhatsApp
 * or email, then book the courts themselves. Kept a year, then deleted
 * (lib/privacy.ts).
 */

import { ENQUIRY_KINDS, ENQUIRY_STATUSES, type EnquiryKind, type EnquiryStatus } from "./enquiries-shared";
export { ENQUIRY_KINDS, ENQUIRY_STATUSES, type EnquiryKind, type EnquiryStatus };

export const MAX_ENQUIRY = 1000;
/** New enquiries one number may leave at one venue in a day. */
const PER_DAY = 3;

export interface Enquiry {
  id: number;
  venueId: number;
  name: string;
  phone: string;
  email: string | null;
  kind: EnquiryKind;
  wantedOn: string | null;
  people: number | null;
  message: string;
  status: EnquiryStatus;
  handledBy: string | null;
  createdAt: string;
  venueName: string;
  /**
   * The language to answer in, where the platform knows it: the language of
   * the customer's account (one with the enquiry's email), else the language
   * the enquiry was made in; either only if this install still offers it.
   * null: not known, so staff write in their own.
   */
  replyLocale: Locale | null;
}

interface Row {
  id: number;
  venue_id: number;
  name: string;
  phone: string;
  email: string | null;
  kind: EnquiryKind;
  wanted_on: string | null;
  people: number | null;
  message: string;
  status: EnquiryStatus;
  handler: string | null;
  created_at: string;
  venue_name: string;
  locale: string | null;
  account_locale: string | null;
}

/** The first of these languages this install offers, if any. */
function offered(...locales: (string | null)[]): Locale | null {
  const here = offeredLocales();
  return locales.find((l): l is Locale => isLocale(l) && here.includes(l)) ?? null;
}

const toEnquiry = (r: Row): Enquiry => ({
  id: r.id,
  venueId: r.venue_id,
  name: r.name,
  phone: r.phone,
  email: r.email,
  kind: r.kind,
  wantedOn: r.wanted_on,
  people: r.people === null ? null : Number(r.people),
  message: r.message,
  status: r.status,
  handledBy: r.handler,
  createdAt: r.created_at,
  venueName: r.venue_name,
  replyLocale: offered(r.account_locale, r.locale),
});

export type EnquiryResult = { ok: true; enquiry: Enquiry } | { ok: false; error: string; code?: string };

/**
 * From the venue's page. The caller has checked the venue may be shown, and
 * says which language the page was in, so a reply can be written in it.
 */
export async function submitEnquiry(venueId: number, input: Record<string, unknown>, locale?: Locale): Promise<EnquiryResult> {
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const name = str(input.name, 80);
  const phone = str(input.phone, 30);
  const email = str(input.email, 200);
  const message = str(input.message, MAX_ENQUIRY);
  if (name.length < 2) return { ok: false, error: "Please provide your name." };
  if (!/^\+?[0-9 -]{7,20}$/.test(phone)) return { ok: false, error: "Please provide a valid phone number." };
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "Please provide a valid email address." };
  if (!ENQUIRY_KINDS.includes(input.kind as EnquiryKind)) return { ok: false, error: "Say what it is for.", code: "ENQUIRY_KIND" };
  if (message.length < 10) return { ok: false, error: "Tell the venue a little about what you have in mind.", code: "ENQUIRY_MESSAGE" };
  const wantedOn = typeof input.wantedOn === "string" && input.wantedOn !== "" ? input.wantedOn : null;
  if (wantedOn !== null && (!isValidDateString(wantedOn) || wantedOn < todayISO() || wantedOn > addDays(todayISO(), 730)))
    return { ok: false, error: "Pick a date to come, or leave it blank.", code: "ENQUIRY_DATE" };
  const people = input.people === undefined || input.people === null || input.people === "" ? null : Number(input.people);
  if (people !== null && (!Number.isInteger(people) || people < 1 || people > 10000))
    return { ok: false, error: "Roughly how many people, or leave it blank.", code: "ENQUIRY_PEOPLE" };

  const db = getDb();
  const today = (await db
    .prepare("SELECT COUNT(*)::int AS n FROM hire_enquiries WHERE venue_id = ? AND phone_key = phone_key(?) AND created_at > datetime('now', '-1 day')")
    .get(venueId, phone)) as { n: number };
  if (today.n >= PER_DAY) return { ok: false, error: "The venue has your enquiries already and will be in touch.", code: "ENQUIRY_LIMIT" };

  const row = (await db
    .prepare(
      `INSERT INTO hire_enquiries (venue_id, name, phone, email, kind, wanted_on, people, message, locale)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
    )
    .get(venueId, name, phone, email || null, input.kind, wantedOn, people, message, locale && isLocale(locale) ? locale : null)) as { id: number };
  const enquiry = (await enquiryById(row.id))!;
  await tellVenue(enquiry);
  return { ok: true, enquiry };
}

/** By email to the address the venue gave for new bookings, if it gave one. */
async function tellVenue(e: Enquiry): Promise<void> {
  const alerts = await bookingAlerts(e.venueId);
  if (!alerts.email) return;
  const venue = (await getDb().prepare("SELECT name FROM venues WHERE id = ?").get(e.venueId)) as { name: string };
  await enqueue({
    venueId: e.venueId,
    kind: "hire_enquiry",
    channel: "email",
    recipient: alerts.email,
    locale: offeredLocales()[0] ?? "en",
    subject: "msg.hireEnquirySubject",
    body: "msg.hireEnquiry",
    dedupeKey: `enquiry:${e.id}`,
    vars: {
      venue: venue.name,
      name: e.name,
      phone: e.phone,
      email: e.email ?? "—",
      kind: e.kind,
      date: e.wantedOn ?? "—",
      people: e.people ?? "—",
      message: e.message,
    },
  });
}

// The account's language: an account with the address the reply goes to.
const SELECT = `SELECT e.*, a.name AS handler, v.name AS venue_name,
    (SELECT u.locale FROM users u WHERE e.email IS NOT NULL AND lower(u.email) = lower(e.email) AND u.locale IS NOT NULL LIMIT 1) AS account_locale
  FROM hire_enquiries e JOIN venues v ON v.id = e.venue_id LEFT JOIN admins a ON a.id = e.handled_by`;

export async function enquiryById(id: number): Promise<Enquiry | null> {
  const row = (await getDb().prepare(`${SELECT} WHERE e.id = ?`).get(id)) as Row | undefined;
  return row ? toEnquiry(row) : null;
}

/**
 * The enquiries at these venues (null: every venue, for the platform's
 * owners): those still open, and those settled in the last 30 days.
 */
export async function listEnquiries(venueIds: number[] | null): Promise<Enquiry[]> {
  if (venueIds && venueIds.length === 0) return [];
  const only = venueIds ? ` AND e.venue_id IN (${venueIds.map(() => "?").join(",")})` : "";
  const rows = (await getDb()
    .prepare(
      `${SELECT} WHERE (e.status IN ('new', 'replied') OR e.handled_at > datetime('now', '-30 days'))${only}
        ORDER BY CASE e.status WHEN 'new' THEN 0 WHEN 'replied' THEN 1 ELSE 2 END, e.id DESC LIMIT 100`
    )
    .all(...(venueIds ?? []))) as Row[];
  return rows.map(toEnquiry);
}

/** Replied, booked or declined; or back to new. */
export async function setEnquiryStatus(venueId: number, id: number, status: unknown, adminId: number | null): Promise<Enquiry | null> {
  if (!ENQUIRY_STATUSES.includes(status as EnquiryStatus)) return null;
  const done = await getDb()
    .prepare("UPDATE hire_enquiries SET status = ?, handled_by = ?, handled_at = datetime('now') WHERE id = ? AND venue_id = ?")
    .run(status, adminId, id, venueId);
  return done.changes > 0 ? enquiryById(id) : null;
}

/** An enquiry unanswered this many days is nudged on the needs-attention list (not an email: the list is where staff look). */
export const ENQUIRY_NUDGE_DAYS = 2;
/** The most enquiries the needs-attention list carries at once; `total` says how many there are. */
const ATTENTION_LIMIT = 20;

export interface EnquiryAttention {
  id: number;
  venueId: number;
  venueName: string;
  kind: EnquiryKind;
  name: string;
  wantedOn: string | null;
  createdAt: string;
  /** Whole days since it was asked. */
  ageDays: number;
  /** Unanswered for `ENQUIRY_NUDGE_DAYS` or more: the customer is waiting to hear. */
  nudge: boolean;
}

/**
 * The needs-attention entry for private hire enquiries nobody has answered (status `new`), oldest first, at these venues (null: every
 * venue, the platform owners'). It stands whether or not the venue set an alert email or a WhatsApp number: the email is a courtesy,
 * this list is the record that somebody must answer. An enquiry leaves it when staff mark it replied, booked or declined
 * (`setEnquiryStatus`), the same as leaves the Bookings tab's *new* count. Names and kinds only, never the message or the
 * number: those are on the enquiry itself.
 */
export async function enquiriesAttention(venueIds: number[] | null, now = new Date()): Promise<{ total: number; items: EnquiryAttention[] }> {
  if (venueIds && venueIds.length === 0) return { total: 0, items: [] };
  const only = venueIds ? ` AND e.venue_id IN (${venueIds.map(() => "?").join(",")})` : "";
  const params = venueIds ?? [];
  const db = getDb();
  const total = (await db.prepare(`SELECT COUNT(*)::int AS n FROM hire_enquiries e WHERE e.status = 'new'${only}`).get(...params)) as { n: number };
  const rows = (await db
    .prepare(
      `SELECT e.id, e.venue_id, v.name AS venue_name, e.kind, e.name, e.wanted_on, e.created_at
         FROM hire_enquiries e JOIN venues v ON v.id = e.venue_id WHERE e.status = 'new'${only} ORDER BY e.id LIMIT ${ATTENTION_LIMIT}`
    )
    .all(...params)) as { id: number; venue_id: number; venue_name: string; kind: EnquiryKind; name: string; wanted_on: string | null; created_at: string }[];
  return {
    total: total.n,
    items: rows.map((r) => {
      const ageDays = Math.max(0, Math.floor((now.getTime() - Date.parse(`${r.created_at.replace(" ", "T")}Z`)) / 86_400_000));
      return {
        id: r.id,
        venueId: r.venue_id,
        venueName: r.venue_name,
        kind: r.kind,
        name: r.name,
        wantedOn: r.wanted_on,
        createdAt: r.created_at,
        ageDays,
        nudge: ageDays >= ENQUIRY_NUDGE_DAYS,
      };
    }),
  };
}
