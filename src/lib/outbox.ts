import { getDb } from "./db";
import { formatHour } from "./time";
import { Locale, isLocale, translator } from "./i18n";
import type { Phrase, Vars } from "./i18n";
import { emailConfig, emailTransport, whatsappConfig, whatsappTransport } from "./transports";

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
  | "class_enrolled";

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
}

/**
 * Write one message down.
 *
 * Call it as soon as the thing has happened. A crash in the gap between the
 * booking and this leaves a booking with no confirmation, which is a customer
 * who has a court and no message — the other order would be a message about a
 * court nobody holds, and that is the worse one.
 */
export function enqueue(input: Compose): OutboxMessage {
  const t = translator(input.locale ?? "en");
  const db = getDb();
  const info = db
    .prepare(
      `INSERT INTO messages
         (booking_id, venue_id, kind, channel, recipient, locale, subject, body, params, dedupe_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      input.dedupeKey ?? null
    );
  if (info.changes === 0 && input.dedupeKey) {
    const existing = db
      .prepare("SELECT * FROM messages WHERE dedupe_key = ?")
      .get(input.dedupeKey) as MessageRow;
    return toMessage(existing);
  }
  return messageById(info.lastInsertRowid as number)!;
}

/**
 * How a customer is best reached.
 *
 * A phone number is always there — it is what a booking is made with — and an
 * email address only sometimes. WhatsApp is how Malaysia actually talks, so it
 * is the first choice, and email is the fallback for anyone who gave one.
 *
 * An install that can send email but has no WhatsApp account emails anyone
 * who gave an address, rather than queuing a WhatsApp message that nothing
 * will ever send.
 */
export function channelFor(phone: string, email?: string | null): Channel {
  const hasPhone = phone.trim() !== "";
  const hasEmail = !!email && email.trim() !== "";
  const real = override === null && process.env.MYSENAM_SEND !== "log";
  if (real && !whatsappConfig() && emailConfig() && hasEmail) return "email";
  return hasPhone ? "whatsapp" : hasEmail ? "email" : "whatsapp";
}

/** The channel and the address on it, for a customer with a phone and maybe an email. */
export function addressFor(
  phone: string,
  email?: string | null
): { channel: Channel; recipient: string } {
  const channel = channelFor(phone, email);
  return { channel, recipient: channel === "email" ? (email ?? "").trim() : phone.trim() };
}

/** A booking's hours as they read in a message. */
export function hourRange(startHour: number, endHour: number): { from: string; to: string } {
  return { from: formatHour(startHour), to: formatHour(endHour) };
}

// ------------------------------------------------------------------ reading

export function messageById(id: number): OutboxMessage | null {
  const row = getDb().prepare("SELECT * FROM messages WHERE id = ?").get(id) as
    | MessageRow
    | undefined;
  return row ? toMessage(row) : null;
}

/** The venue's recent messages, newest first. */
export function listMessages(venueId: number, limit = 50): OutboxMessage[] {
  return (
    getDb()
      .prepare("SELECT * FROM messages WHERE venue_id = ? ORDER BY id DESC LIMIT ?")
      .all(venueId, limit) as MessageRow[]
  ).map(toMessage);
}

export function messagesForBooking(bookingId: number): OutboxMessage[] {
  return (
    getDb()
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

export function outboxSummary(venueId: number): OutboxSummary {
  const rows = getDb()
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
  /** Throw to fail the attempt; the message is retried with backoff. */
  send(message: OutboxMessage): Promise<void>;
}

let override: Transport | null = null;

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
        await post.send(message);
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
export function dueMessages(limit = 25): OutboxMessage[] {
  return (
    getDb()
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

  for (const message of dueMessages(limit)) {
    const attempts = message.attempts + 1;
    try {
      await post.send(message);
      db.prepare(
        "UPDATE messages SET status = 'sent', attempts = ?, sent_at = datetime('now'), last_error = NULL WHERE id = ?"
      ).run(attempts, message.id);
      result.sent++;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (attempts >= MAX_ATTEMPTS) {
        db.prepare(
          "UPDATE messages SET status = 'abandoned', attempts = ?, last_error = ? WHERE id = ?"
        ).run(attempts, reason, message.id);
        result.abandoned++;
      } else {
        db.prepare(
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
export function retryMessage(id: number, recipient?: string): OutboxMessage | null {
  const existing = messageById(id);
  if (!existing) return null;
  getDb()
    .prepare(
      `UPDATE messages
          SET status = 'queued', attempts = 0, last_error = NULL,
              next_attempt_at = datetime('now'),
              recipient = COALESCE(?, recipient)
        WHERE id = ?`
    )
    .run(recipient?.trim() || null, id);
  return messageById(id);
}
