import { getDb } from "./db";
import { formatHour } from "./time";
import { Locale, isLocale, translator } from "./i18n";
import type { Phrase, Vars } from "./i18n";
import { emailConfig, emailTransport, whatsappConfig, whatsappTransport } from "./transports";
import { chatOfferedFor, paidByVenue, refundCredit, spendCredit } from "./whatsapp-credit";

/**
 * Messages to customers, written down before they are sent.
 *
 * A booking that succeeds but whose confirmation fails to send is still a
 * booking — the customer turns up and plays. So nothing here is sent inline
 * with the request that caused it: the message is written to a table, and a
 * separate pass delivers it. A mail server being down slows the confirmation;
 * it does not lose the court.
 *
 * Each row holds its finished text rather than a template and some ids,
 * because the text was written in the language the customer was reading at the
 * time, and editing the wording later must not change what somebody was
 * already sent.
 *
 * **Nothing is sent until a transport is configured.** There is no default
 * WhatsApp or email account to fall back on, and inventing one would be worse
 * than queuing: see `transport()` below for what switches each one on.
 */

export type Channel = "whatsapp" | "email";
export type MessageStatus = "queued" | "sent" | "failed" | "abandoned";

export type MessageKind =
  | "booking_confirmed"
  | "booking_series_confirmed"
  | "booking_cancelled"
  | "waitlist_offer"
  | "class_enrolled"
  | "booking_cancelled_by_venue"
  | "booking_moved"
  /** A booking's date or time changed: by staff (urgent), or by the customer (email only). */
  | "booking_rescheduled"
  | "booking_reminder"
  /** By email only: a receipt is a document to keep, not worth a WhatsApp message. */
  | "payment_received"
  /** To the venue itself, at the address and number it chose: a booking made online. */
  | "venue_new_booking"
  /** By email only: a gift voucher bought online, to its buyer. */
  | "gift_voucher"
  /** By email only, once per customer per venue: how was it? (lib/reviews.ts) */
  | "review_request"
  /** By email only, to people who agreed to hear from the venue (lib/marketing.ts). */
  | "campaign"
  /** By email only, to a coach: a lesson booked with them, or cancelled (lib/coach-schedule.ts). */
  | "coach_lesson";

/**
 * Messages to the venue's own staff, which they asked for: not held to the
 * daily limit per recipient, which is there to keep the site from being used
 * to flood somebody else's phone. A busy venue takes more bookings than that.
 */
const UNCAPPED_KINDS: MessageKind[] = ["venue_new_booking"];

export interface OutboxMessage {
  id: number;
  bookingId: number | null;
  venueId: number;
  kind: MessageKind;
  channel: Channel;
  recipient: string;
  locale: Locale;
  subject: string | null;
  body: string;
  /**
   * What filled the text, kept beside it. WhatsApp sends these as a template's
   * parameters rather than the text itself. Null on messages written before
   * they were kept.
   */
  params: Vars | null;
  status: MessageStatus;
  dedupeKey: string | null;
  attempts: number;
  lastError: string | null;
  createdAt: string;
  nextAttemptAt: string;
  sentAt: string | null;
  /**
   * Sent as a plain reply in a chat the customer opened, which Meta does not
   * charge for, rather than as a template, which it does.
   */
  free: boolean;
  /** A calendar file (iCalendar) sent with an email, so the booking is in the customer's diary. */
  calendar: string | null;
  /** WhatsApp only: when Meta reported it on the phone, and opened; and why not, if it failed after leaving. */
  deliveredAt: string | null;
  readAt: string | null;
  deliveryError: string | null;
}

interface MessageRow {
  id: number;
  booking_id: number | null;
  venue_id: number;
  kind: string;
  channel: string;
  recipient: string;
  locale: string;
  subject: string | null;
  body: string;
  params: string | null;
  status: string;
  attempts: number;
  last_error: string | null;
  created_at: string;
  next_attempt_at: string;
  sent_at: string | null;
  dedupe_key: string | null;
  free: number;
  calendar: string | null;
  delivered_at: string | null;
  read_at: string | null;
  delivery_error: string | null;
}

function toMessage(r: MessageRow): OutboxMessage {
  return {
    id: r.id,
    bookingId: r.booking_id,
    venueId: r.venue_id,
    kind: r.kind as MessageKind,
    channel: r.channel as Channel,
    recipient: r.recipient,
    locale: isLocale(r.locale) ? r.locale : "en",
    subject: r.subject,
    body: r.body,
    params: parseParams(r.params),
    status: r.status as MessageStatus,
    attempts: r.attempts,
    lastError: r.last_error,
    createdAt: r.created_at,
    nextAttemptAt: r.next_attempt_at,
    sentAt: r.sent_at,
    dedupeKey: r.dedupe_key,
    free: r.free === 1,
    calendar: r.calendar,
    deliveredAt: r.delivered_at ?? null,
    readAt: r.read_at ?? null,
    deliveryError: r.delivery_error ?? null,
  };
}

function parseParams(json: string | null): Vars | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as Vars;
  } catch {
    return null;
  }
}

/** Give up after this many tries; a sixth attempt is not going to work. */
export const MAX_ATTEMPTS = 5;

/** Minutes to wait before attempt n+1: a minute, then five, then half an hour… */
const BACKOFF_MINUTES = [1, 5, 30, 120];

function backoffFor(attempts: number): number {
  return BACKOFF_MINUTES[Math.min(attempts, BACKOFF_MINUTES.length - 1)];
}

// ---------------------------------------------------------------- composing

/** Where this install lives, for the links inside a message. */
export function baseUrl(): string {
  return (process.env.MYSENAM_URL || "http://localhost:3000").replace(/\/+$/, "");
}

export interface Compose {
  bookingId?: number | null;
  venueId: number;
  kind: MessageKind;
  /** A phone number for WhatsApp, an address for email. */
  recipient: string;
  channel: Channel;
  locale?: Locale;
  /** The phrase keys for the subject and the body, and what fills them. */
  subject?: Phrase;
  body: Phrase;
  vars: Vars;
  /**
   * What this message is about, when saying it twice would be wrong. Queuing
   * the same key again returns the message already there rather than a second
   * one, which is what lets a sweep run as often as it likes.
   */
  dedupeKey?: string;
  /** iCalendar text to attach to an email. */
  calendar?: string;
  /** The urgent notice this carries (lib/urgent.ts). */
  noticeId?: number;
}

/**
 * The most messages one phone number or email address is sent in a day.
 *
 * Every booking messages the number it was made with, and nothing checks the
 * number is the booker's own. Without a ceiling, anybody could use the site
 * to send a stranger confirmation after confirmation — on WhatsApp, each one
 * paid for. A real customer's busiest day (a few bookings, a change, a
 * waitlist offer) is well under it.
 */
export const MESSAGES_PER_RECIPIENT_PER_DAY = 8;

const RECIPIENT_KEY = "(CASE WHEN channel = 'email' THEN lower(recipient) ELSE phone_key(recipient) END)";

/** Messages written for this recipient in the last day, sent or not. */
export async function sentToday(channel: Channel, recipient: string): Promise<number> {
  const { n } = (await getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM messages
        WHERE ${RECIPIENT_KEY} = (CASE WHEN ? = 'email' THEN lower(?) ELSE phone_key(?) END)
          AND created_at >= datetime('now', '-1 day')`
    )
    .get(channel, recipient.trim(), recipient.trim())) as { n: number };
  return n;
}

/**
 * Write one message down.
 *
 * Call it as soon as the thing has happened. A crash in the gap between the
 * booking and this leaves a booking with no confirmation, which is a customer
 * who has a court and no message — the other order would be a message about a
 * court nobody holds, and that is the worse one.
 */
export async function enqueue(input: Compose): Promise<OutboxMessage> {
  const t = translator(input.locale ?? "en");
  const db = getDb();
  // A confirmation waits a few minutes for the customer to open the chat
  // themselves, when they can: the same words as a reply cost nothing.
  const hold =
    input.channel === "whatsapp" && HELD_KINDS.includes(input.kind) && (await chatOfferedFor(input.venueId)) ? chatHoldMinutes() : 0;
  // Past the day's limit for this recipient, it is written down but never
  // sent, with the reason, where staff can see it.
  const capped =
    !UNCAPPED_KINDS.includes(input.kind) && (await sentToday(input.channel, input.recipient)) >= MESSAGES_PER_RECIPIENT_PER_DAY;
  const info = await db
    .prepare(
      `INSERT INTO messages
         (booking_id, venue_id, kind, channel, recipient, locale, subject, body, params, dedupe_key, status, last_error, next_attempt_at, calendar, notice_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?), ?, ?)
       ON CONFLICT(dedupe_key) DO NOTHING`
    )
    .run(
      input.bookingId ?? null,
      input.venueId,
      input.kind,
      input.channel,
      input.recipient.trim(),
      t.locale,
      input.subject ? t(input.subject, input.vars) : null,
      t(input.body, input.vars),
      JSON.stringify(input.vars),
      input.dedupeKey ?? null,
      capped ? "abandoned" : "queued",
      capped ? `Not sent: already ${MESSAGES_PER_RECIPIENT_PER_DAY} messages to this recipient today.` : null,
      `+${hold} minutes`,
      input.channel === "email" ? (input.calendar ?? null) : null,
      input.noticeId ?? null
    );
  if (info.changes === 0 && input.dedupeKey) {
    const existing = await db
      .prepare("SELECT * FROM messages WHERE dedupe_key = ?")
      .get(input.dedupeKey) as MessageRow;
    return toMessage(existing);
  }
  return (await messageById(info.lastInsertRowid as number))!;
}

// ------------------------------------------------------------- chat replies

/**
 * The confirmations worth holding back a few minutes: the customer is looking
 * at the confirmation screen, with a button that opens a chat with us. A
 * waitlist offer or a cancellation is not held — nobody is waiting on a
 * screen for those, and an offer is against the clock.
 */
const HELD_KINDS: MessageKind[] = ["booking_confirmed", "booking_series_confirmed", "class_enrolled"];

/** The platform's WhatsApp number as customers message it, digits only (WHATSAPP_CHAT_NUMBER). */
export function chatNumber(): string | null {
  const digits = (process.env.WHATSAPP_CHAT_NUMBER ?? "").replace(/\D/g, "");
  return digits.length >= 8 ? digits : null;
}

/**
 * Whether customers can open the chat and be answered in it: there is a
 * number to message, Meta's webhook can be checked (WHATSAPP_APP_SECRET), and
 * something to reply through.
 */
export function chatRepliesOn(): boolean {
  if (!chatNumber() || !process.env.WHATSAPP_APP_SECRET) return false;
  return override !== null || process.env.MYSENAM_SEND === "log" || whatsappConfig() !== null;
}

/** Minutes a confirmation waits for the customer to open the chat (MYSENAM_WHATSAPP_CHAT_HOLD_MINUTES, default 3). */
export function chatHoldMinutes(): number {
  const n = Number(process.env.MYSENAM_WHATSAPP_CHAT_HOLD_MINUTES ?? 3);
  return Number.isInteger(n) && n >= 0 && n <= 30 ? n : 3;
}

/** A booking's hours as they read in a message. */
export function hourRange(startHour: number, endHour: number): { from: string; to: string } {
  return { from: formatHour(startHour), to: formatHour(endHour) };
}

// ------------------------------------------------------------------ reading

export async function messageById(id: number): Promise<OutboxMessage | null> {
  const row = await getDb().prepare("SELECT * FROM messages WHERE id = ?").get(id) as
    | MessageRow
    | undefined;
  return row ? toMessage(row) : null;
}

/** The venue's recent messages, newest first. */
export async function listMessages(venueId: number, limit = 50): Promise<OutboxMessage[]> {
  return (
    await getDb()
      .prepare("SELECT * FROM messages WHERE venue_id = ? ORDER BY id DESC LIMIT ?")
      .all(venueId, limit) as MessageRow[]
  ).map(toMessage);
}

export async function messagesForBooking(bookingId: number): Promise<OutboxMessage[]> {
  return (
    await getDb()
      .prepare("SELECT * FROM messages WHERE booking_id = ? ORDER BY id")
      .all(bookingId) as MessageRow[]
  ).map(toMessage);
}

export interface OutboxSummary {
  queued: number;
  sent: number;
  failed: number;
  abandoned: number;
  /** The transport in use, or null when nothing is configured. */
  transport: string | null;
}

export async function outboxSummary(venueId: number): Promise<OutboxSummary> {
  const rows = await getDb()
    .prepare("SELECT status, COUNT(*) AS n FROM messages WHERE venue_id = ? GROUP BY status")
    .all(venueId) as { status: string; n: number }[];
  const by = (s: string) => rows.find((r) => r.status === s)?.n ?? 0;
  return {
    queued: by("queued"),
    sent: by("sent"),
    failed: by("failed"),
    abandoned: by("abandoned"),
    transport: transportName(),
  };
}

// ---------------------------------------------------------------- delivering

export interface Transport {
  name: string;
  /**
   * Throw to fail the attempt; the message is retried with backoff. What it
   * returns, WhatsApp's id for the message, is how delivery and reading are
   * matched back to it later.
   */
  send(message: OutboxMessage): Promise<void | { providerId?: string }>;
}

let override: Transport | null = null;

/** Whether a test has swapped the transport. */
export function transportOverridden(): boolean {
  return override !== null;
}

/** Swap the transport, for tests. Pass null to go back to the configured one. */
export function setTransport(t: Transport | null): void {
  override = t;
}

/**
 * The transport this install sends through.
 *
 * `MYSENAM_SEND=log` writes the message to the server log and marks it sent,
 * which is what you want while developing, whatever else is configured.
 * Otherwise each message goes out on its own channel: WhatsApp when
 * WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID are set, email when SMTP_URL and
 * MAIL_FROM are. With neither, messages queue up and the dashboard says so,
 * which is honest; a message silently marked sent would not be.
 */
export function transport(): Transport | null {
  if (override) return override;
  if (process.env.MYSENAM_SEND !== "log") {
    const wa = whatsappConfig();
    const mail = emailConfig();
    if (!wa && !mail) return null;
    const byChannel: Record<Channel, Transport | null> = {
      whatsapp: wa ? whatsappTransport(wa) : null,
      email: mail ? emailTransport(mail) : null,
    };
    return {
      name: [wa && "whatsapp", mail && "email"].filter(Boolean).join("+"),
      async send(message) {
        const post = byChannel[message.channel];
        if (!post) throw new Error(`No ${message.channel} account is set up on this install.`);
        return await post.send(message);
      },
    };
  }
  return {
    name: "log",
    async send(message) {
      console.info(
        `[outbox] ${message.channel} → ${message.recipient}\n${
          message.subject ? message.subject + "\n" : ""
        }${message.body}\n`
      );
    },
  };
}

export function transportName(): string | null {
  return transport()?.name ?? null;
}

/** Messages that are due to be tried now. */
export async function dueMessages(limit = 25): Promise<OutboxMessage[]> {
  return (
    await getDb()
      .prepare(
        `SELECT * FROM messages
          WHERE status IN ('queued','failed')
            AND next_attempt_at <= datetime('now')
          ORDER BY id LIMIT ?`
      )
      .all(limit) as MessageRow[]
  ).map(toMessage);
}

export interface DrainResult {
  sent: number;
  failed: number;
  abandoned: number;
  /** null when nothing was tried because no transport is configured. */
  transport: string | null;
}

/**
 * Try everything that is due.
 *
 * Called lazily rather than on a timer, in the same spirit as the retention
 * pass: this install has no scheduler, and a booking platform that needs one
 * running to be correct is a booking platform that breaks on a restart.
 */
export async function drainOutbox(limit = 25): Promise<DrainResult> {
  const post = transport();
  if (!post) return { sent: 0, failed: 0, abandoned: 0, transport: null };

  const db = getDb();
  const result: DrainResult = { sent: 0, failed: 0, abandoned: 0, transport: post.name };

  for (const message of await dueMessages(limit)) {
    const attempts = message.attempts + 1;
    // A WhatsApp message the venue pays for is paid before it goes
    // (lib/whatsapp-credit.ts); with nothing left to pay with, it does not go
    // at all. Urgent news is the platform's to pay.
    const paid = message.channel === "whatsapp" && paidByVenue(message.kind);
    if (paid && !(await spendCredit(message.venueId, message.id))) {
      await db
        .prepare("UPDATE messages SET status = 'abandoned', attempts = ?, last_error = ? WHERE id = ?")
        .run(attempts, "Not sent: no WhatsApp credit left. The customer still had the booking code on screen, and any email.", message.id);
      result.abandoned++;
      continue;
    }
    try {
      const out = await post.send(message);
      await db.prepare(
        "UPDATE messages SET status = 'sent', attempts = ?, sent_at = datetime('now'), last_error = NULL, provider_id = ? WHERE id = ?"
      ).run(attempts, (out && out.providerId) || null, message.id);
      result.sent++;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (paid) await refundCredit(message.venueId, message.id);
      if (attempts >= MAX_ATTEMPTS) {
        await db.prepare(
          "UPDATE messages SET status = 'abandoned', attempts = ?, last_error = ? WHERE id = ?"
        ).run(attempts, reason, message.id);
        result.abandoned++;
      } else {
        await db.prepare(
          `UPDATE messages
              SET status = 'failed', attempts = ?, last_error = ?,
                  next_attempt_at = datetime('now', ?)
            WHERE id = ?`
        ).run(attempts, reason, `+${backoffFor(message.attempts)} minutes`, message.id);
        result.failed++;
      }
    }
  }
  return result;
}

/**
 * Put a message back in the queue.
 *
 * For the case the retries cannot help with: the number was wrong, or the
 * venue's account was not set up yet. Staff fix the cause and ask again.
 */
export async function retryMessage(id: number, recipient?: string): Promise<OutboxMessage | null> {
  const existing = await messageById(id);
  if (!existing) return null;
  await getDb()
    .prepare(
      `UPDATE messages
          SET status = 'queued', attempts = 0, last_error = NULL,
              next_attempt_at = datetime('now'),
              recipient = COALESCE(?, recipient)
        WHERE id = ?`
    )
    .run(recipient?.trim() || null, id);
  return await messageById(id);
}

/**
 * What Meta later says about a WhatsApp message it accepted: delivered to the
 * phone, read, or failed after all (a number not on WhatsApp, say). Matched by
 * the id Meta gave it; one we never sent is ignored.
 */
export async function recordDelivery(report: { id: string; status: string; timestamp?: string; error?: string }): Promise<boolean> {
  const at = report.timestamp && /^\d+$/.test(report.timestamp)
    ? new Date(Number(report.timestamp) * 1000).toISOString().replace("T", " ").slice(0, 19)
    : new Date().toISOString().replace("T", " ").slice(0, 19);
  const db = getDb();
  let done;
  if (report.status === "delivered")
    done = await db.prepare("UPDATE messages SET delivered_at = COALESCE(delivered_at, ?) WHERE provider_id = ?").run(at, report.id);
  else if (report.status === "read")
    done = await db
      .prepare("UPDATE messages SET read_at = COALESCE(read_at, ?), delivered_at = COALESCE(delivered_at, ?) WHERE provider_id = ?")
      .run(at, at, report.id);
  else if (report.status === "failed")
    done = await db.prepare("UPDATE messages SET delivery_error = ? WHERE provider_id = ?").run(report.error ?? "WhatsApp could not deliver it.", report.id);
  else return false;
  return done.changes > 0;
}
