import crypto from "crypto";
import { getDb } from "./db";
import { isLocale, translator, type Locale } from "./i18n";
import { enqueue } from "./outbox";
import { siteName } from "./site";
import { venueBaseUrl } from "./storefront";
import { getVenue } from "./store";

/**
 * News and offers from a venue, by email, to people who asked for them.
 *
 * - **Asked, never assumed.** A box under the booking form, unticked, shown
 *   once an email address is given, in the customer's language, naming the
 *   venue. Ticking it is recorded with the words it said and when; nothing
 *   else signs anybody up, and staff cannot sign anybody up for them.
 * - **Stopping is one click** from any of these emails (no account needed),
 *   or from the account page, and is kept as a record that it was asked.
 *   Booking confirmations, reminders and receipts are not marketing and keep
 *   coming.
 * - **A venue sends** to those who agreed to hear from it, and only it: a
 *   subject and some words, with the footer added that says why they get it
 *   and how to stop. At most a few a month, and never by WhatsApp (each one
 *   costs, and Singapore's Do Not Call rules apply to messages to phones).
 */

export const MAX_CAMPAIGNS_PER_30_DAYS = 4;
export const MAX_SUBJECT = 100;
export const MAX_BODY = 3000;

const emailKey = (email: string) => email.trim().toLowerCase();

export interface Consent {
  id: number;
  venueId: number;
  venueName: string;
  email: string;
  consentedAt: string;
  withdrawnAt: string | null;
}

/** The box's words, in the customer's language, as they will be kept. */
export function optInWording(locale: Locale, venueName: string): string {
  return translator(locale)("mkt.optIn", { venue: venueName });
}

/**
 * Somebody ticked the box: agreed (again, if they had stopped). `confirmed`
 * when the address is the signed-in account's own; otherwise, and always for
 * an address that had unsubscribed, nothing is sent to it until it says yes
 * itself, from the one email asking.
 */
export async function recordConsent(input: {
  venueId: number;
  email: string;
  name?: string | null;
  userId?: number | null;
  locale: Locale;
  source: "booking" | "account";
  confirmed: boolean;
}): Promise<void> {
  const email = input.email.trim();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return;
  const venue = await getVenue(input.venueId);
  if (!venue) return;
  const row = (await getDb()
    .prepare(
      `INSERT INTO marketing_consents (venue_id, email, email_key, name, user_id, locale, source, wording, token, confirmed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? THEN datetime('now') END)
       ON CONFLICT (venue_id, email_key) DO UPDATE SET email = excluded.email, name = COALESCE(excluded.name, marketing_consents.name),
         user_id = COALESCE(excluded.user_id, marketing_consents.user_id), locale = excluded.locale, source = excluded.source,
         wording = excluded.wording, consented_at = datetime('now'), withdrawn_at = NULL,
         confirmed_at = CASE WHEN excluded.confirmed_at IS NOT NULL THEN excluded.confirmed_at
                             WHEN marketing_consents.withdrawn_at IS NOT NULL THEN NULL
                             ELSE marketing_consents.confirmed_at END
       RETURNING token, confirmed_at`
    )
    .get(
      input.venueId,
      email,
      emailKey(email),
      input.name?.trim() || null,
      input.userId ?? null,
      input.locale,
      input.source,
      optInWording(input.locale, venue.name),
      crypto.randomBytes(18).toString("base64url"),
      input.confirmed
    )) as { token: string; confirmed_at: string | null };
  if (row.confirmed_at !== null) return;
  // Asked once a day at most, however many times the box is ticked for it.
  await enqueue({
    venueId: venue.id,
    kind: "marketing_confirm",
    channel: "email",
    recipient: email,
    locale: input.locale,
    subject: "msg.mktConfirmSubject",
    body: "msg.mktConfirm",
    dedupeKey: `mkt-confirm:${row.token}:${new Date().toISOString().slice(0, 10)}`,
    vars: { venue: venue.name, link: `${await venueBaseUrl(venue.id)}/unsubscribe/${row.token}`, site: siteName() },
  });
}

/** The address saying yes itself, from the email that asked. */
export async function confirmConsent(token: string): Promise<boolean> {
  const row = await getDb()
    .prepare("UPDATE marketing_consents SET confirmed_at = COALESCE(confirmed_at, datetime('now')) WHERE token = ? AND withdrawn_at IS NULL RETURNING id")
    .get(token);
  return !!row;
}

/** Who an unsubscribe link is for, to ask before stopping. */
export async function consentByToken(
  token: string
): Promise<{ venueName: string; email: string; withdrawn: boolean; confirmed: boolean } | null> {
  const row = (await getDb()
    .prepare("SELECT c.email, c.withdrawn_at, c.confirmed_at, v.name AS venue FROM marketing_consents c JOIN venues v ON v.id = c.venue_id WHERE c.token = ?")
    .get(token)) as { email: string; withdrawn_at: string | null; confirmed_at: string | null; venue: string } | undefined;
  return row
    ? { venueName: row.venue, email: row.email, withdrawn: row.withdrawn_at !== null, confirmed: row.confirmed_at !== null }
    : null;
}

export async function unsubscribe(token: string): Promise<boolean> {
  const row = await getDb()
    .prepare("UPDATE marketing_consents SET withdrawn_at = COALESCE(withdrawn_at, datetime('now')) WHERE token = ? RETURNING id")
    .get(token);
  return !!row;
}

/** An account's agreements: made from it, or to its email address. */
export async function consentsFor(userId: number, email: string): Promise<Consent[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT c.id, c.venue_id, v.name AS venue, c.email, c.consented_at, c.withdrawn_at
         FROM marketing_consents c JOIN venues v ON v.id = c.venue_id
        WHERE c.user_id = ? OR c.email_key = ? ORDER BY v.name`
    )
    .all(userId, emailKey(email))) as { id: number; venue_id: number; venue: string; email: string; consented_at: string; withdrawn_at: string | null }[];
  return rows.map((r) => ({ id: r.id, venueId: r.venue_id, venueName: r.venue, email: r.email, consentedAt: r.consented_at, withdrawnAt: r.withdrawn_at }));
}

export async function withdrawFor(userId: number, email: string, consentId: number): Promise<boolean> {
  const row = await getDb()
    .prepare(
      `UPDATE marketing_consents SET withdrawn_at = COALESCE(withdrawn_at, datetime('now'))
        WHERE id = ? AND (user_id = ? OR email_key = ?) RETURNING id`
    )
    .get(consentId, userId, emailKey(email));
  return !!row;
}

// ------------------------------------------------------------ the venue's side

export interface Campaign {
  id: number;
  subject: string;
  body: string;
  recipients: number;
  sentAt: string;
  sentBy: string | null;
}

export interface Audience {
  /** Who would get one now. */
  subscribed: number;
  /** Ticked for an address that has not confirmed it yet: sent nothing. */
  waiting: number;
  /** Who stopped. */
  withdrawn: number;
  campaigns: Campaign[];
  /** How many more may go in the 30 days to now. */
  left: number;
}

export async function audience(venueId: number): Promise<Audience> {
  const db = getDb();
  const counts = (await db
    .prepare(
      `SELECT COUNT(*) FILTER (WHERE withdrawn_at IS NULL AND confirmed_at IS NOT NULL) AS on_,
              COUNT(*) FILTER (WHERE withdrawn_at IS NULL AND confirmed_at IS NULL) AS waiting,
              COUNT(*) FILTER (WHERE withdrawn_at IS NOT NULL) AS off
         FROM marketing_consents WHERE venue_id = ?`
    )
    .get(venueId)) as { on_: number | string; waiting: number | string; off: number | string };
  const campaigns = (await db
    .prepare(
      `SELECT m.*, a.name AS sent_by FROM marketing_campaigns m LEFT JOIN admins a ON a.id = m.admin_id
        WHERE m.venue_id = ? ORDER BY m.id DESC LIMIT 20`
    )
    .all(venueId)) as { id: number; subject: string; body: string; recipients: number; sent_at: string; sent_by: string | null }[];
  return {
    subscribed: Number(counts.on_),
    waiting: Number(counts.waiting),
    withdrawn: Number(counts.off),
    campaigns: campaigns.map((c) => ({ id: c.id, subject: c.subject, body: c.body, recipients: Number(c.recipients), sentAt: c.sent_at, sentBy: c.sent_by })),
    left: Math.max(0, MAX_CAMPAIGNS_PER_30_DAYS - (await recentCampaigns(venueId))),
  };
}

async function recentCampaigns(venueId: number): Promise<number> {
  const since = new Date(Date.now() - 30 * 86_400_000).toISOString().replace("T", " ").slice(0, 19);
  const r = (await getDb()
    .prepare("SELECT COUNT(*) AS n FROM marketing_campaigns WHERE venue_id = ? AND sent_at >= ?")
    .get(venueId, since)) as { n: number | string };
  return Number(r.n);
}

function readCampaign(input: { subject: unknown; body: unknown }): { subject: string; body: string } | string {
  const subject = typeof input.subject === "string" ? input.subject.trim() : "";
  const body = typeof input.body === "string" ? input.body.trim() : "";
  if (subject.length < 3 || subject.length > MAX_SUBJECT) return `Give it a subject, up to ${MAX_SUBJECT} characters.`;
  if (body.length < 10 || body.length > MAX_BODY) return `Write something to say, up to ${MAX_BODY} characters.`;
  return { subject, body };
}

async function sendOne(
  venueId: number,
  venueName: string,
  to: { email: string; locale: Locale; token: string | null },
  c: { subject: string; body: string },
  dedupeKey: string | undefined
): Promise<void> {
  const base = await venueBaseUrl(venueId);
  await enqueue({
    venueId,
    kind: "campaign",
    channel: "email",
    recipient: to.email,
    locale: to.locale,
    subject: "msg.campaignSubject",
    body: to.token ? "msg.campaign" : "msg.campaignTest",
    dedupeKey,
    vars: {
      venue: venueName,
      subject: c.subject,
      body: c.body,
      link: to.token ? `${base}/unsubscribe/${to.token}` : `${base}/unsubscribe`,
      site: siteName(),
    },
  });
}

type Sent = { ok: true; recipients: number; campaign: Campaign | null } | { ok: false; error: string };

/** One copy to the person writing it, marked as a test, to see it as customers will. */
export async function testCampaign(venueId: number, toEmail: string, input: { subject: unknown; body: unknown }): Promise<Sent> {
  const c = readCampaign(input);
  if (typeof c === "string") return { ok: false, error: c };
  const venue = await getVenue(venueId);
  if (!venue) return { ok: false, error: "Venue not found." };
  await sendOne(venueId, venue.name, { email: toEmail, locale: "en", token: null }, { ...c, subject: `[Test] ${c.subject}` }, undefined);
  return { ok: true, recipients: 1, campaign: null };
}

/** To everybody who agreed to hear from this venue and has not stopped, each in their own language's footer. */
export async function sendCampaign(venueId: number, adminId: number | null, input: { subject: unknown; body: unknown }): Promise<Sent> {
  const c = readCampaign(input);
  if (typeof c === "string") return { ok: false, error: c };
  const venue = await getVenue(venueId);
  if (!venue) return { ok: false, error: "Venue not found." };
  if ((await recentCampaigns(venueId)) >= MAX_CAMPAIGNS_PER_30_DAYS)
    return { ok: false, error: `At most ${MAX_CAMPAIGNS_PER_30_DAYS} in 30 days, so people keep wanting them.` };
  const db = getDb();
  const people = (await db
    .prepare("SELECT email, locale, token FROM marketing_consents WHERE venue_id = ? AND withdrawn_at IS NULL AND confirmed_at IS NOT NULL ORDER BY id")
    .all(venueId)) as { email: string; locale: string | null; token: string }[];
  if (people.length === 0) return { ok: false, error: "Nobody has agreed to hear from this venue yet." };
  const row = (await db
    .prepare("INSERT INTO marketing_campaigns (venue_id, subject, body, admin_id, recipients) VALUES (?, ?, ?, ?, ?) RETURNING id")
    .get(venueId, c.subject, c.body, adminId, people.length)) as { id: number };
  for (const p of people)
    await sendOne(venueId, venue.name, { email: p.email, locale: p.locale && isLocale(p.locale) ? p.locale : "en", token: p.token }, c, `campaign:${row.id}:${p.token}`);
  return { ok: true, recipients: people.length, campaign: (await audience(venueId)).campaigns.find((x) => x.id === row.id) ?? null };
}
