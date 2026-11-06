import { getDb } from "./db";
import { formatHour } from "./time";
import { Locale, isLocale, offeredLocales, translator } from "./i18n";
import type { Phrase, T, Vars } from "./i18n";
import { emailConfig, emailTransport, whatsappConfig, whatsappTransport } from "./transports";
import { URGENT_KINDS, chatOfferedFor, paidByVenue, refundCredit, spendCredit } from "./whatsapp-credit";
import { linkIn } from "./link-locale";
import { isPermanentSendError } from "./send-errors";

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
  /** To the venue itself, where it asked: a customer cancelled or changed a booking online, soon enough to matter (lib/notify.ts). */
  | "venue_booking_change"
  /** By email only: a gift voucher bought online, to its buyer. */
  | "gift_voucher"
  /** By email only, once per customer per venue: how was it? (lib/reviews.ts) */
  | "review_request"
  /** By email only, to people who agreed to hear from the venue (lib/marketing.ts). */
  | "campaign"
  /** By email only: asking an address to confirm it wants a venue's news, before any is sent. */
  | "marketing_confirm"
  /** By email only, to a coach: a lesson booked with them, or cancelled (lib/coach-schedule.ts). */
  | "coach_lesson"
  /** By email only: a free hour earned by playing at a venue (lib/loyalty.ts). */
  | "loyalty_reward"
  /** By email only, to a company or school account: its monthly invoice (lib/accounts.ts). */
  | "account_invoice"
  /** By email only, to the venue: a private hire enquiry from its page (lib/enquiries.ts). */
  | "hire_enquiry"
  /** By email only, to a player: a tournament, league or open game they are in (lib/tournaments.ts, leagues.ts, games.ts). */
  | "programme"
  /** By email only, about somebody's own account: confirming a venue application's address, its decision, a password reset link. */
  | "account_email"
  /** By email only, to the platform's owners or a venue's staff: something they would want to know (lib/owner-alerts.ts, alerts.ts). */
  | "staff_alert"
  /** By email only, to somebody who applied to list a venue: the decision on it (lib/applications.ts). */
  | "applicant"
  /**
   * On WhatsApp only, to a guardian a venue recorded by name and number whose number a code has come back from: what changed in
   * who acts for a child, and the venue's page. The venue's name only, never the child's (lib/contact-guardians.ts).
   */
  | "guardian_notice"
  /** By email only: on a waiting list now, with the link to leave it (lib/notify.ts `notifyWaitlistJoined`). */
  | "waitlist_joined"
  /** By email only: a class somebody is enrolled in, or offered a place in, has a new name or instructor (lib/notify.ts `notifyClassChanged`). */
  | "class_changed"
  /** By email only: a place on a waiting list ended without the person doing it: an offer ran out, or the class was called off (lib/notify.ts, ADR 0060). */
  | "waitlist_ended"
  /**
   * To a player entered in a tournament, on the day, by email and on WhatsApp where the venue has chosen it and the player has
   * a number their account proved: their match is next on its court, or they are called to it (lib/tournament-day.ts). Once per
   * fixture, side and call, so not held to the daily limit per recipient: a day's matches would reach it.
   */
  | "tournament_day"
  /**
   * By email only, to a captain, a lineup player or their guardian: what was decided in a team league (a result confirmed, a forfeit
   * requested or decided, a lineup named; lib/team-leagues.ts). It is the venue's decision about somebody's match, and one written
   * off for a busy day's limit is a team that never learns it, so it is not held to the daily limit per recipient.
   */
  | "team_decision"
  /**
   * By email only, to a player: "you have a message in {place}", never the message itself, with a link into the signed-in app
   * (lib/messages.ts, lib/message-digest.ts). Held to the daily limit per recipient like any other.
   */
  | "player_message"
  /**
   * By email only, at once: an urgent safety or moderation event in a supervised youth group, or one that concerns a person's own messaging
   * (a report in its thread, a thread closed, somebody paused, a guardian's consent changed: lib/youth-safeguarding.ts, lib/youth-messages.ts).
   * Never the text of a message, never WhatsApp, never digested, and not held to the daily limit per recipient: a notice written off for a
   * busy day's limit is a guardian or supervisor who never learns of it.
   */
  | "safeguarding_notice"
  /**
   * By email only, to the customer of a booking, once: a sign-off, certification or induction it relied on was taken back and the
   * venue will be in touch about it (lib/safety-flags.ts). The venue's decision about a booking somebody made, so not held to the
   * daily limit per recipient.
   */
  | "booking_safety_notice"
  /**
   * By email only, to a customer: what became of money they paid back for a booking (the refund was made, failed, is late, or is
   * the venue's to make by a date), once per change (lib/notify.ts `notifyRefundStates`). Urgent news: not held to the daily limit.
   */
  | "refund_notice"
  /**
   * By email only, to a customer with something at a venue that has just been taken off the marketplace (owner suspension or an
   * overdue invoice): what stands, what waits and whom to ask, once per suspension (lib/suspension-notices.ts). Urgent news: not held
   * to the daily limit.
   */
  | "venue_suspension_notice";

/**
 * Messages to the venue's own staff, which they asked for: not held to the
 * daily limit per recipient, which is there to keep the site from being used
 * to flood somebody else's phone. A busy venue takes more bookings than that.
 */
const UNCAPPED_KINDS: MessageKind[] = ["venue_new_booking", "venue_booking_change", "hire_enquiry", "staff_alert", "tournament_day", "team_decision", "safeguarding_notice", "booking_safety_notice"];

/**
 * The urgent news a customer must not miss, in one place: what the venue does to their booking (cancelled, moved, changed), the
 * offer of a place that is against the clock, a guardian's notice (`URGENT_KINDS`, lib/whatsapp-credit.ts, which also decides what
 * the platform pays for on WhatsApp), and what became of money paid back (`refund_notice`), and that a venue they hold something at has been taken off (`venue_suspension_notice`). The day's limit per recipient is there
 * so the site cannot be used to flood somebody's phone with bookings made under their number; it must never write one of these off,
 * because a busy day (reminders, campaigns from several venues, class changes) is exactly when a cancellation matters most.
 * They are held to a much higher ceiling of their own instead (`urgentPerRecipientPerDay`).
 */
export const URGENT_NEWS_KINDS: readonly string[] = [...URGENT_KINDS, "refund_notice", "venue_suspension_notice"];

/** The most urgent notices one address or number is sent in a day (MYSENAM_URGENT_PER_RECIPIENT_PER_DAY, default 30). */
export function urgentPerRecipientPerDay(): number {
  const n = Number(process.env.MYSENAM_URGENT_PER_RECIPIENT_PER_DAY ?? 30);
  return Number.isInteger(n) && n >= MESSAGES_PER_RECIPIENT_PER_DAY && n <= 1000 ? n : 30;
}

/**
 * How long a message that keeps failing is kept trying: after this many days of provider trouble it is given up, and the venue's
 * staff and the platform's owners are told (MYSENAM_MESSAGE_MAX_AGE_DAYS, default 7). Until then a failure only delays the next try.
 */
export function maxMessageAgeDays(): number {
  const n = Number(process.env.MYSENAM_MESSAGE_MAX_AGE_DAYS ?? 7);
  return Number.isInteger(n) && n >= 1 && n <= 60 ? n : 7;
}

export interface OutboxMessage {
  id: number;
  bookingId: number | null;
  /** Null for one that belongs to no venue (an applicant, a password reset, the platform's owners). */
  venueId: number | null;
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
  venue_id: number | null;
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

/**
 * Minutes to wait before attempt n+1: a minute, then five, then half an hour, then two hours for as long as it keeps failing.
 * A message is not given up for the number of tries (an outage of a few hours used to use them all up) but for its age
 * (`maxMessageAgeDays`), or at once when its transport says sending again cannot help (lib/send-errors.ts).
 */
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
  /** Null for a message that belongs to no venue. */
  venueId: number | null;
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
  /** Not sent after this many minutes, when what it carries stops working (a reset link). */
  expiresMinutes?: number;
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

/** Messages written for this recipient in the last day, sent or not; only of these kinds when they are given. */
export async function sentToday(channel: Channel, recipient: string, kinds?: readonly string[]): Promise<number> {
  const { n } = (await getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM messages
        WHERE ${RECIPIENT_KEY} = (CASE WHEN ? = 'email' THEN lower(?) ELSE phone_key(?) END)
          AND created_at >= datetime('now', '-1 day')${kinds ? ` AND kind IN (${kinds.map(() => "?").join(",")})` : ""}`
    )
    .get(channel, recipient.trim(), recipient.trim(), ...(kinds ?? []))) as { n: number };
  return n;
}

/**
 * Whether a message of this kind to this recipient is past the day's limit, with the sentence saying so. Staff's own alerts and the
 * like are never held to it; urgent news (`URGENT_NEWS_KINDS`) only to its own high ceiling, counted among urgent news alone; the
 * rest to `MESSAGES_PER_RECIPIENT_PER_DAY` counted over everything. `includesThis`: the message itself is already among those counted
 * (putting it back in the queue).
 */
async function limitReached(kind: MessageKind, channel: Channel, recipient: string, includesThis = false): Promise<string | null> {
  if (UNCAPPED_KINDS.includes(kind)) return null;
  const extra = includesThis ? 1 : 0;
  if (URGENT_NEWS_KINDS.includes(kind)) {
    const ceiling = urgentPerRecipientPerDay();
    return (await sentToday(channel, recipient, URGENT_NEWS_KINDS)) >= ceiling + extra
      ? `Not sent: already ${ceiling} urgent notices to this recipient today.`
      : null;
  }
  return (await sentToday(channel, recipient)) >= MESSAGES_PER_RECIPIENT_PER_DAY + extra
    ? `Not sent: already ${MESSAGES_PER_RECIPIENT_PER_DAY} messages to this recipient today.`
    : null;
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
    input.channel === "whatsapp" && input.venueId !== null && HELD_KINDS.includes(input.kind) && (await chatOfferedFor(input.venueId)) ? chatHoldMinutes() : 0;
  // Past the day's limit for this recipient, it is written down but never
  // sent, with the reason, where staff can see it. Urgent news is held to its own ceiling (`limitReached`).
  const cappedWhy = await limitReached(input.kind, input.channel, input.recipient);
  const capped = cappedWhy !== null;
  const info = await db
    .prepare(
      `INSERT INTO messages
         (booking_id, venue_id, kind, channel, recipient, locale, subject, body, params, dedupe_key, status, last_error, next_attempt_at, calendar, notice_id, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now', ?), ?, ?, ${input.expiresMinutes ? "datetime('now', ?)" : "NULL"})
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
      cappedWhy,
      `+${hold} minutes`,
      input.channel === "email" ? (input.calendar ?? null) : null,
      input.noticeId ?? null,
      ...(input.expiresMinutes ? [`+${Math.round(input.expiresMinutes)} minutes`] : [])
    );
  if (info.changes === 0 && input.dedupeKey) {
    const existing = await db
      .prepare("SELECT * FROM messages WHERE dedupe_key = ?")
      .get(input.dedupeKey) as MessageRow;
    return toMessage(existing);
  }
  const written = (await messageById(info.lastInsertRowid as number))!;
  if (capped) await forgetAccountLink(written);
  return written;
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

/** A booking's hours as they read in a message, in its language (lib/time.ts `formatHour`); English by default. */
export function hourRange(startHour: number, endHour: number, locale: Locale = "en"): { from: string; to: string } {
  return { from: formatHour(startHour, locale), to: formatHour(endHour, locale) };
}

// ------------------------------------------------------------------ reading

export async function messageById(id: number): Promise<OutboxMessage | null> {
  const row = await getDb().prepare("SELECT * FROM messages WHERE id = ?").get(id) as
    | MessageRow
    | undefined;
  return row ? toMessage(row) : null;
}

/**
 * A message as staff may read it. A link into somebody's account (an invitation, a password reset, an address to confirm: kind
 * `account_email`) is theirs alone, whoever reads the outbox: its subject and how it went are shown, never the link. Any other
 * link that carries a secret (`token=`) is hidden the same way. Everything that lists messages to staff goes through it; the
 * sending code reads the message itself.
 */
export function forStaff(m: OutboxMessage): OutboxMessage {
  if (m.kind === "account_email") return { ...m, body: ACCOUNT_LINK_HIDDEN, params: null, calendar: null };
  const hide = (text: string) => text.replace(SECRET_LINK, LINK_HIDDEN);
  const params = m.params
    ? (Object.fromEntries(Object.entries(m.params).map(([k, v]) => [k, typeof v === "string" ? hide(v) : v])) as Vars)
    : null;
  return { ...m, body: hide(m.body), params };
}

/** An address that carries a secret in its query, wherever it sits in a text. */
const SECRET_LINK = /https?:\/\/[^\s"'<>]*[?&]token=[^\s"'<>]*/g;
const LINK_HIDDEN = "(link hidden)";

/** The venue's recent messages, newest first, as staff may read them (`forStaff`). */
export async function listMessages(venueId: number, limit = 50): Promise<OutboxMessage[]> {
  return (
    await getDb()
      .prepare("SELECT * FROM messages WHERE venue_id = ? AND kind <> 'safeguarding_notice' ORDER BY id DESC LIMIT ?")
      .all(venueId, limit) as MessageRow[]
  )
    .map(toMessage)
    .map(forStaff);
}

/** Messages that belong to no venue: to applicants, password resets, alerts to staff. For the platform's owners. */
export async function listPlatformMessages(limit = 50): Promise<OutboxMessage[]> {
  return (
    (await getDb().prepare("SELECT * FROM messages WHERE venue_id IS NULL AND kind <> 'safeguarding_notice' ORDER BY id DESC LIMIT ?").all(limit)) as MessageRow[]
  )
    .map(toMessage)
    .map(forStaff);
}

const ACCOUNT_LINK_HIDDEN = "(Not shown or kept: it carries a link into somebody's account.)";

/**
 * Once an email carrying a link into somebody's account has gone, or been
 * given up, its text is not kept: the link (a password reset, an address to
 * confirm) would otherwise sit in the database and its backups. Part of the
 * same statement that says it went, so no moment (or crash) leaves a sent
 * message still holding its link; its one parameter is ACCOUNT_LINK_HIDDEN.
 */
const FORGET_ACCOUNT_LINK =
  "body = CASE WHEN kind = 'account_email' THEN ? ELSE body END, params = CASE WHEN kind = 'account_email' THEN NULL ELSE params END";

async function forgetAccountLink(message: OutboxMessage): Promise<void> {
  if (message.kind !== "account_email") return;
  await getDb().prepare(`UPDATE messages SET ${FORGET_ACCOUNT_LINK} WHERE id = ?`).run(ACCOUNT_LINK_HIDDEN, message.id);
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
 * WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID are set, email when Amazon SES
 * or SMTP is set up (`emailConfig`). With neither, messages queue up and the dashboard says so,
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

/**
 * What a venue's news to a long list of people is: sent after what customers and staff are waiting for (a confirmation, a waitlist
 * offer, a reset link), never ahead of it. A campaign to two thousand people queues two thousand rows at once, oldest first.
 */
const BULK_KINDS: MessageKind[] = ["campaign", "review_request"];

/** Messages that are due to be tried now: what somebody waits for first, bulk news last, each oldest first. */
export async function dueMessages(limit = 25): Promise<OutboxMessage[]> {
  return (
    await getDb()
      .prepare(
        `SELECT * FROM messages
          WHERE status IN ('queued','failed')
            AND next_attempt_at <= datetime('now')
          ORDER BY (CASE WHEN kind IN (${BULK_KINDS.map(() => "?").join(",")}) THEN 1 ELSE 0 END), id LIMIT ?`
      )
      .all(...BULK_KINDS, limit) as MessageRow[]
  ).map(toMessage);
}

/**
 * Why a message that is waiting should not go now, looked at as it is about to be sent and not as it was written: what it says no
 * longer stands, or the person has withdrawn what it was sent on. Null: send it.
 *  - A reminder is for one booking at one time (its key says which): not for a cancelled booking, not for a booking moved to another
 *    time since (the one for the new time is written separately), not for a time that has begun.
 *  - A venue's campaign goes only to somebody whose consent still stands (not withdrawn, not erased).
 */
async function staleReason(message: OutboxMessage): Promise<string | null> {
  const db = getDb();
  if (message.kind === "booking_reminder" && message.bookingId !== null) {
    const row = (await db
      .prepare("SELECT status, date, start_min, starts_at FROM bookings WHERE id = ?")
      .get(message.bookingId)) as { status: string; date: string; start_min: number; starts_at: string | Date | null } | undefined;
    if (!row) return "Not sent: the booking is gone.";
    if (row.status !== "confirmed") return "Not sent: the booking was cancelled before the reminder could go.";
    const at = /^reminder:[^:]+:(\d{4}-\d{2}-\d{2}):(\d+)/.exec(message.dedupeKey ?? "");
    if (at && (row.date !== at[1] || Number(row.start_min) !== Number(at[2])))
      return "Not sent: the booking was moved to another time before the reminder could go.";
    if (row.starts_at && new Date(row.starts_at).getTime() <= Date.now()) return "Not sent: the booking's time had begun.";
    return null;
  }
  if (message.kind === "campaign") {
    const token = /^campaign:\d+:([^:]+)$/.exec(message.dedupeKey ?? "")?.[1];
    if (!token) return null;
    const consent = (await db
      .prepare("SELECT 1 FROM marketing_consents WHERE token = ? AND withdrawn_at IS NULL AND confirmed_at IS NOT NULL")
      .get(token)) as unknown;
    return consent ? null : "Not sent: they withdrew their consent to hear from the venue after it was queued.";
  }
  return null;
}

/** Whether this message was written more than `maxMessageAgeDays` ago. */
async function agedOut(id: number): Promise<boolean> {
  const row = (await getDb()
    .prepare("SELECT created_at <= datetime('now', ?) AS old FROM messages WHERE id = ?")
    .get(`-${maxMessageAgeDays()} days`, id)) as { old: boolean } | undefined;
  return row?.old === true;
}

/**
 * Messages given up for their age (a provider that stayed down for days): the managers of each venue they belong to are told once a
 * day with how many, and the platform's owners once (lib/alerts.ts `raiseAlert`), with the way to send what is still worth sending
 * (Messages, "Send again everything that failed"). Never throws: telling about a failure must not become one.
 */
async function tellAgedOut(given: OutboxMessage[]): Promise<void> {
  try {
    const { said, englishOf } = await import("./staff-text");
    const { raiseAlert } = await import("./alerts");
    const { tellVenueStaffEach } = await import("./owner-alerts");
    const days = maxMessageAgeDays();
    const byVenue = new Map<number, number>();
    for (const m of given) if (m.venueId !== null) byVenue.set(m.venueId, (byVenue.get(m.venueId) ?? 0) + 1);
    const today = new Date().toISOString().slice(0, 10);
    for (const [venueId, n] of byVenue)
      await tellVenueStaffEach(
        venueId,
        (t) => ({ subject: t("srv.fx6.aged.s"), body: t("srv.fx6.aged.b", { n, days, place: t("srv.fx6.aged.place") }) }),
        { managersOnly: true, dedupeKey: `messages-aged:${venueId}:${today}` }
      );
    const detail = said("srv.fx6.aged.detail", { n: given.length, days, error: given[0].lastError ?? said("srv.alert.noneGiven") });
    await raiseAlert("messages-aged-out", said("srv.fx6.aged.alert"), englishOf(detail), [detail]);
  } catch (err) {
    console.error("[mysenam] could not tell about messages given up for age:", err instanceof Error ? err.message : "unknown error");
  }
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
  const givenUpForAge: OutboxMessage[] = [];

  for (const message of await dueMessages(limit)) {
    // Claimed before it is tried: two drains at once (two requests, two servers) each see it due, and
    // only the one that moves its next try on ten minutes sends it. Should this one die mid-send, the
    // message is tried again when that runs out.
    const claimed = await db
      .prepare(
        `UPDATE messages SET next_attempt_at = datetime('now', '+10 minutes')
          WHERE id = ? AND status IN ('queued','failed') AND next_attempt_at <= datetime('now')`
      )
      .run(message.id);
    if (claimed.changes !== 1) continue;
    const attempts = message.attempts + 1;
    // What it carries has run out (a reset link): sending it now would only confuse.
    const expired = (await db
      .prepare("SELECT 1 FROM messages WHERE id = ? AND expires_at IS NOT NULL AND expires_at <= datetime('now')")
      .get(message.id)) as unknown;
    if (expired) {
      await db
        .prepare(`UPDATE messages SET status = 'abandoned', last_error = ?, ${FORGET_ACCOUNT_LINK} WHERE id = ?`)
        .run("Not sent: it ran out before it could go (the link in it no longer works).", ACCOUNT_LINK_HIDDEN, message.id);
      result.abandoned++;
      continue;
    }
    // Looked at again as it is about to go: a cancelled booking's reminder, a withdrawn consent.
    const stale = await staleReason(message);
    if (stale) {
      await db
        .prepare(`UPDATE messages SET status = 'abandoned', last_error = ?, ${FORGET_ACCOUNT_LINK} WHERE id = ?`)
        .run(stale, ACCOUNT_LINK_HIDDEN, message.id);
      result.abandoned++;
      continue;
    }
    // A WhatsApp message the venue pays for is paid before it goes
    // (lib/whatsapp-credit.ts); with nothing left to pay with, it does not go
    // at all. Urgent news is the platform's to pay.
    const paid = message.channel === "whatsapp" && message.venueId !== null && paidByVenue(message.kind);
    if (paid && !(await spendCredit(message.venueId!, message.id))) {
      await db
        .prepare("UPDATE messages SET status = 'abandoned', attempts = ?, last_error = ? WHERE id = ?")
        .run(attempts, "Not sent: no WhatsApp credit left. The customer still had the booking code on screen, and any email.", message.id);
      result.abandoned++;
      continue;
    }
    try {
      const out = await post.send(message);
      await db.prepare(
        `UPDATE messages SET status = 'sent', attempts = ?, sent_at = datetime('now'), last_error = NULL, provider_id = ?, ${FORGET_ACCOUNT_LINK} WHERE id = ?`
      ).run(attempts, (out && out.providerId) || null, ACCOUNT_LINK_HIDDEN, message.id);
      result.sent++;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      if (paid) await refundCredit(message.venueId!, message.id);
      // Given up at once only where the transport says trying again cannot help; otherwise kept, with a backoff that stops growing
      // at two hours, until it is too old to matter. A provider outage is the provider's, and a recovered one releases what waited.
      const permanent = isPermanentSendError(err);
      const tooOld = !permanent && (await agedOut(message.id));
      if (permanent || tooOld) {
        await db.prepare(
          `UPDATE messages SET status = 'abandoned', attempts = ?, last_error = ?, ${FORGET_ACCOUNT_LINK} WHERE id = ?`
        ).run(
          attempts,
          tooOld ? `${reason} (given up after ${maxMessageAgeDays()} days of trying)` : reason,
          ACCOUNT_LINK_HIDDEN,
          message.id
        );
        result.abandoned++;
        if (tooOld) givenUpForAge.push(message);
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
  if (givenUpForAge.length > 0) await tellAgedOut(givenUpForAge);
  return result;
}

/**
 * Put a message back in the queue.
 *
 * For the case the retries cannot help with: the number was wrong, or the
 * venue's account was not set up yet. Staff fix the cause and ask again.
 */
/** Kinds sent to people who did not book: never to an address staff type in. */
const NOT_READDRESSED: MessageKind[] = ["campaign", "review_request", "marketing_confirm", "account_email"];

export async function retryMessage(
  id: number,
  recipient?: string
): Promise<{ ok: true; message: OutboxMessage } | { ok: false; error: string } | null> {
  const existing = await messageById(id);
  if (!existing) return null;
  // Only what did not go: sending what arrived again is how one customer gets the same message ten times.
  if (existing.status !== "failed" && existing.status !== "abandoned")
    return { ok: false, error: "Only a message that was not sent can be sent again." };
  // Its link is not kept once it has gone or been given up; a new one is asked for instead.
  if (existing.kind === "account_email")
    return { ok: false, error: "This carried a link into somebody's account, which is not kept. They can ask for a new one." };
  const to = recipient?.trim() || null;
  if (to && to !== existing.recipient) {
    if (NOT_READDRESSED.includes(existing.kind))
      return { ok: false, error: "This message only goes to who it was written for." };
    if (existing.channel === "email" ? !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to) : !/^\+?[0-9 -]{7,20}$/.test(to))
      return { ok: false, error: existing.channel === "email" ? "That is not an email address." : "That is not a phone number." };
  }
  // The day's limit holds for whoever it goes to now.
  const readdressed = to !== null && to !== existing.recipient;
  // Counted with this message itself, where it was already theirs.
  if (await limitReached(existing.kind, existing.channel, to ?? existing.recipient, !readdressed))
    return {
      ok: false,
      error: URGENT_NEWS_KINDS.includes(existing.kind)
        ? `Already ${urgentPerRecipientPerDay()} urgent notices to this recipient today. Try again tomorrow.`
        : `Already ${MESSAGES_PER_RECIPIENT_PER_DAY} messages to this recipient today. Try again tomorrow.`,
    };
  await getDb()
    .prepare(
      `UPDATE messages
          SET status = 'queued', attempts = 0, last_error = NULL,
              next_attempt_at = datetime('now'),
              recipient = COALESCE(?, recipient)
        WHERE id = ?`
    )
    .run(to, id);
  return { ok: true, message: (await messageById(id))! };
}

/** The most messages "send again everything that failed" puts back in one go; ask again for the rest. */
export const RESEND_ALL_LIMIT = 500;

/**
 * Put every message of a venue that did not go, written in a window, back in the queue: the one click after a provider outage that
 * `retryMessage` would take one message at a time. Honouring staleness: not an account email (its link is not kept: the person
 * asks for a new one), not a safeguarding notice (not on these screens), not one older than `maxMessageAgeDays` or past its own
 * expiry, not one already given up because what it said no longer stood (a cancelled booking's reminder, a withdrawn consent: they
 * would be given up again), and each is held to the day's limit for its recipient as a single resend is. At most `RESEND_ALL_LIMIT`
 * (the oldest first); the answer says how many went back and how many were left, by reason.
 */
export async function retryFailedMessages(
  venueId: number,
  window: { since: string; until: string }
): Promise<{ requeued: number; skipped: { stale: number; refused: number }; more: boolean }> {
  const rows = (await getDb()
    .prepare(
      `SELECT id, created_at <= datetime('now', ?) AS too_old, (expires_at IS NOT NULL AND expires_at <= datetime('now')) AS expired
         FROM messages
        WHERE venue_id = ? AND status IN ('failed','abandoned') AND created_at >= ? AND created_at <= ?
          AND kind NOT IN ('account_email', 'safeguarding_notice')
          AND COALESCE(last_error, '') NOT LIKE 'Not sent: the booking%' AND COALESCE(last_error, '') NOT LIKE 'Not sent: they withdrew%'
          AND COALESCE(last_error, '') NOT LIKE 'Not sent: it ran out%'
        ORDER BY id LIMIT ?`
    )
    .all(`-${maxMessageAgeDays()} days`, venueId, window.since, window.until, RESEND_ALL_LIMIT + 1)) as { id: number; too_old: boolean; expired: boolean }[];
  const skipped = { stale: 0, refused: 0 };
  let requeued = 0;
  for (const row of rows.slice(0, RESEND_ALL_LIMIT)) {
    if (row.too_old || row.expired) {
      skipped.stale++;
      continue;
    }
    const done = await retryMessage(row.id);
    if (done?.ok) requeued++;
    else skipped.refused++;
  }
  return { requeued, skipped, more: rows.length > RESEND_ALL_LIMIT };
}

/**
 * Give up messages that have not gone yet (queued, or failed and waiting to be
 * tried again), by their dedupe keys (`%` matches the rest of one, as in SQL
 * LIKE): what they carry no longer stands. Marked abandoned with the reason, as
 * the outbox gives up any message, so staff see why it never went; one already
 * sent, or being sent this moment, goes as it would have. A link into somebody's
 * account it carried is not kept, as when any is given up. How many.
 */
export async function abandonUnsent(dedupeKeys: string[], why: string): Promise<number> {
  if (dedupeKeys.length === 0) return 0;
  const done = await getDb()
    .prepare(
      `UPDATE messages SET status = 'abandoned', last_error = ?, ${FORGET_ACCOUNT_LINK}
        WHERE status IN ('queued','failed') AND (${dedupeKeys.map(() => "dedupe_key LIKE ?").join(" OR ")})`
    )
    .run(why, ACCOUNT_LINK_HIDDEN, ...dedupeKeys);
  return done.changes;
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

/**
 * A tournament, league or open-game email to a player with an account,
 * queued like every other message: sent with retries, counted against the
 * day's limit, in the venue's list of messages, and written in the same
 * transaction as what it is about: a change undone, or run again after a
 * conflict, queues nothing twice.
 */
/**
 * An email of plain text, written as it is (not in the customer's language:
 * these go to staff, applicants and account holders in the words chosen
 * where they are sent from). Queued like any other message, so it is retried
 * when the mail server is down and listed with how it went. Accepted by the
 * mail server is "sent"; that is not proof anybody read it.
 */
export async function emailPlain(input: {
  to: string;
  subject: string;
  text: string;
  kind: "account_email" | "staff_alert" | "applicant" | "safeguarding_notice";
  /** The venue it is about, where there is one; null for the platform's own. */
  venueId?: number | null;
  dedupeKey?: string;
  expiresMinutes?: number;
  /** The language the subject and text were written in, recorded with the message; English when not said. */
  locale?: Locale;
}): Promise<OutboxMessage> {
  return enqueue({
    venueId: input.venueId ?? null,
    kind: input.kind,
    channel: "email",
    recipient: input.to,
    locale: input.locale ?? "en",
    subject: "msg.programmeSubject",
    body: "msg.programmeBody",
    vars: { subject: input.subject, text: input.text },
    dedupeKey: input.dedupeKey,
    expiresMinutes: input.expiresMinutes,
  });
}

/** Text for one reader: written in their language by the lookup it is given. */
export type Written = (t: T) => string;

/** Sentences joined as the language writes them: a space between, none in Chinese. */
export function sentences(t: T, ...parts: (string | false | null | undefined)[]): string {
  return parts.filter((p): p is string => Boolean(p)).join(t.locale === "zh" ? "" : " ");
}

/** The language an account last used the site in, if this install offers it; else the install's first. */
export async function accountLocale(userId: number): Promise<Locale> {
  const row = (await getDb().prepare("SELECT locale FROM users WHERE id = ?").get(userId)) as { locale: string | null } | undefined;
  const offered = offeredLocales();
  return isLocale(row?.locale) && offered.includes(row.locale) ? row.locale : offered[0];
}

/**
 * An email to a player about a game, tournament, league or group, written in
 * the language their account last used (users.locale), the greeting too.
 */
export async function emailPlayer(input: { venueId: number | null; userId: number; subject: Written; body: Written; link: string; dedupeKey?: string; decision?: boolean; kind?: MessageKind }): Promise<void> {
  const user = (await getDb().prepare("SELECT name, email FROM users WHERE id = ?").get(input.userId)) as { name: string; email: string } | undefined;
  if (!user) return;
  const { siteName } = await import("./site");
  const locale = await accountLocale(input.userId);
  const t = translator(locale, siteName());
  const text = `${t("mail.hi", { name: user.name.split(/\s+/)[0] })}\n\n${input.body(t)}\n\n${linkIn(input.link, locale)}\n\n${siteName()}`;
  await enqueue({
    venueId: input.venueId,
    kind: input.kind ?? (input.decision ? "team_decision" : "programme"),
    channel: "email",
    recipient: user.email,
    locale,
    subject: "msg.programmeSubject",
    body: "msg.programmeBody",
    vars: { subject: input.subject(t), text },
    // The same notice twice (a job run on two servers) is queued once.
    dedupeKey: input.dedupeKey,
  });
}
