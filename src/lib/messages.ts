import { getDb, withTransaction } from "./db";
import { declaredAdult } from "./player-profiles";
import { blockPlayer } from "./player-safety";
import { candidateContexts, contextOf, lockSeat, kindInUrl, type Context, type ContextInfo, type ContextKind, type Seat, type SeatLabel } from "./message-contexts";
import { emailPlayer } from "./outbox";
import { contextTitle } from "./message-titles";
import { LIMITS, REPORT_REASONS } from "./message-limits";

/**
 * Messages between players (docs/features/player-messages.md; ADR 0039).
 *
 * Safe by design rather than by moderation after the fact: a thread exists only inside a context its people already share
 * (lib/message-contexts.ts), only declared adults who turned messaging on can be in one, a message is text only and shows nobody's
 * phone or email, and nothing a message says ever leaves the app: an email tells somebody they have a message in a place, never what it
 * says. No message text is written to a log, the activity log, an error report or the outbox.
 *
 * What is deterministic and published (the limits below, the order of the checks in `sendMessage`): no learned ranking, no scanning of
 * content beyond the contact-detail check, which is a speed bump, not a guarantee.
 */

export { LIMITS, REPORT_REASONS, type MessageReportReason } from "./message-limits";

const MINUTE = 60_000;
const nowStamp = (offsetMs = 0): string => new Date(Date.now() + offsetMs).toISOString().slice(0, 19).replace("T", " ");

// ------------------------------------------------------------------ refusals

export interface Refusal {
  ok: false;
  error: string;
  /** The customer dictionary's `err.<code>`. */
  code: string;
  status: number;
  vars?: Record<string, string | number>;
}

const REFUSALS = {
  PM_NOT_FOUND: ["Not found.", 404],
  PM_OFF: ["Turn on messages from people you play with first.", 403],
  PM_ADULTS: ["Messages are for players who say they are 18 or over.", 403],
  PM_UNDERSTOOD: ["Please read what messages are, and confirm, before turning them on.", 400],
  PM_NOBODY: ["Nobody else here can be written to right now.", 409],
  PM_READ_ONLY: ["This conversation has ended. It can be read, not written to.", 409],
  PM_CLOSED: ["This conversation is closed.", 410],
  PM_PAUSED: ["This conversation has been paused by the venue's staff.", 409],
  PM_SUSPENDED: ["Your messages are paused. The venue or the platform's owners can say why.", 403],
  PM_EMPTY: ["Write something to send.", 400],
  PM_LONG: ["A message can be up to {n} characters.", 400],
  PM_CONTACT: ["Phone numbers and email addresses cannot be sent in messages.", 400],
  PM_RATE: ["You are sending a lot of messages. Please wait a while.", 429],
  PM_NEW_THREADS: ["You have started a lot of conversations today. Please try again tomorrow.", 429],
  PM_REASON: ["What is the report about?", 400],
  PM_REPORT_LIMIT: ["You have sent a lot of reports today. Please try again tomorrow.", 429],
  PM_OWN: ["That is your own message.", 400],
} as const;
export type MessageRefusalCode = keyof typeof REFUSALS;

export function refuse(code: MessageRefusalCode, vars?: Record<string, string | number>): Refusal {
  const [text, status] = REFUSALS[code];
  return { ok: false, code, status, error: vars ? text.replace(/\{(\w+)\}/g, (_, k: string) => String(vars[k] ?? "")) : text, ...(vars ? { vars } : {}) };
}

class Refused extends Error {
  constructor(readonly refusal: Refusal) {
    super(refusal.code);
  }
}

// ------------------------------------------------------------------ the text

/**
 * Whether a message carries an email address or something that reads as a telephone number. A speed bump, not a guarantee: somebody
 * determined can spell a number out, and nothing here understands what a message means. A run of eight or more digits (with spaces,
 * dashes, dots, brackets and a plus) is refused when it has a group of three or more digits or ten digits in all, so a score such as
 * "21-19 21-17" is allowed and "012-345 6789" is not.
 */
export function contactDetail(text: string): "email" | "phone" | null {
  if (/[^\s@]+@[^\s@]+\.[^\s@]{2,}/.test(text)) return "email";
  for (const run of text.match(/\+?\d[\d\s().-]{6,}\d/g) ?? []) {
    const groups = run.match(/\d+/g) ?? [];
    const digits = groups.join("").length;
    if (digits >= 8 && (digits >= 10 || groups.some((g) => g.length >= 3))) return "phone";
  }
  return null;
}

/** The text as it will be kept: control characters out, line ends as `\n`, blank lines squeezed, trimmed. */
export function cleanText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// ------------------------------------------------------------------ settings

export interface MessageSettings {
  enabled: boolean;
  emailNotices: boolean;
  /** They have seen the first screen. */
  explained: boolean;
  /** Declared 18 or over (their word, not verified): the only people who can turn messaging on. */
  adult: boolean;
}

export async function messageSettings(userId: number): Promise<MessageSettings> {
  const row = (await getDb().prepare("SELECT enabled, email_notices, explained_at FROM player_message_settings WHERE user_id = ?").get(userId)) as
    | { enabled: number; email_notices: number; explained_at: string | null }
    | undefined;
  const adult = (await declaredAdult(userId)) === true;
  return { enabled: row?.enabled === 1 && adult, emailNotices: row ? row.email_notices === 1 : true, explained: !!row?.explained_at, adult };
}

export type SettingsResult = { ok: true; settings: MessageSettings } | Refusal;

/** Turn messaging on or off, or the emails. Turning it on takes a declared adult who has read the first screen (`understood`). */
export async function saveMessageSettings(userId: number, input: { enabled?: unknown; emailNotices?: unknown; understood?: unknown }): Promise<SettingsResult> {
  const had = await messageSettings(userId);
  let enabled = had.enabled;
  if ("enabled" in input && typeof input.enabled === "boolean") {
    if (input.enabled) {
      if (!had.adult) return refuse("PM_ADULTS");
      if (!had.explained && input.understood !== true) return refuse("PM_UNDERSTOOD");
    }
    enabled = input.enabled;
  }
  const emailNotices = "emailNotices" in input && typeof input.emailNotices === "boolean" ? input.emailNotices : had.emailNotices;
  await getDb()
    .prepare(
      `INSERT INTO player_message_settings (user_id, enabled, email_notices, explained_at, enabled_at)
       VALUES (?, ?, ?, ${enabled ? "datetime('now')" : "NULL"}, ${enabled ? "datetime('now')" : "NULL"})
       ON CONFLICT (user_id) DO UPDATE SET enabled = excluded.enabled, email_notices = excluded.email_notices,
         explained_at = COALESCE(player_message_settings.explained_at, ${enabled ? "datetime('now')" : "NULL"}),
         enabled_at = CASE WHEN excluded.enabled = 1 AND player_message_settings.enabled = 0 THEN datetime('now') WHEN excluded.enabled = 0 THEN NULL ELSE player_message_settings.enabled_at END,
         updated_at = datetime('now')`
    )
    .run(userId, enabled ? 1 : 0, emailNotices ? 1 : 0);
  return { ok: true, settings: await messageSettings(userId) };
}

/** Which of these people can be written to: messaging on, and declared 18 or over (re-read now, so a later "under 18" ends it). */
async function eligibleAmong(userIds: number[]): Promise<Set<number>> {
  if (userIds.length === 0) return new Set();
  const rows = (await getDb()
    .prepare(
      `SELECT s.user_id FROM player_message_settings s JOIN player_profiles p ON p.user_id = s.user_id
        WHERE s.enabled = 1 AND p.adult = 1 AND s.user_id IN (${userIds.map(() => "?").join(",")})`
    )
    .all(...userIds)) as { user_id: number }[];
  return new Set(rows.map((r) => r.user_id));
}

/** The people (of these) who have blocked `me`, or whom `me` has blocked. */
async function blockedWith(me: number, userIds: number[]): Promise<Set<number>> {
  if (userIds.length === 0) return new Set();
  const marks = userIds.map(() => "?").join(",");
  const rows = (await getDb()
    .prepare(`SELECT blocker_id, blocked_id FROM player_blocks WHERE (blocker_id = ? AND blocked_id IN (${marks})) OR (blocked_id = ? AND blocker_id IN (${marks}))`)
    .all(me, ...userIds, me, ...userIds)) as { blocker_id: number; blocked_id: number }[];
  return new Set(rows.map((r) => (r.blocker_id === me ? r.blocked_id : r.blocker_id)));
}

/** Whether messaging is stopped for this person in this venue's contexts (`venueId` null: only a platform-wide stop counts). */
export async function suspendedIn(userId: number, venueId: number | null): Promise<boolean> {
  return Boolean(
    await getDb()
      .prepare("SELECT 1 FROM player_message_suspensions WHERE user_id = ? AND lifted_at IS NULL AND (venue_id IS NULL OR venue_id = ?) LIMIT 1")
      .get(userId, venueId)
  );
}

// ------------------------------------------------------------------ access

interface ThreadRow {
  id: number;
  context_kind: ContextKind;
  context_id: number;
  venue_id: number | null;
  created_by: number | null;
  last_message_at: string | null;
  message_count: number;
  ended_at: string | null;
  staff_state: "open" | "muted" | "closed";
}

export type Phase = "open" | "read_only" | "paused" | "closed";

interface Access {
  ctx: Context;
  seat: Seat;
  thread: ThreadRow | null;
  phase: Phase;
  /** Others who could be written to (messaging on, adults), blocks aside. */
  others: Seat[];
  /** Of those, the ones neither side has blocked. */
  reachable: Seat[];
  /** When it ended, as far as is known. */
  endedAt: string | null;
}

async function threadOf(kind: ContextKind, id: number, lock = false): Promise<ThreadRow | null> {
  return ((await getDb()
    .prepare(
      `SELECT id, context_kind, context_id, venue_id, created_by, last_message_at, message_count, ended_at, staff_state FROM player_message_threads
        WHERE context_kind = ? AND context_id = ?${lock ? " FOR UPDATE" : ""}`
    )
    .get(kind, id)) ?? null) as ThreadRow | null;
}

function phaseOf(ctx: Context, thread: ThreadRow | null, endedAt: string | null): Phase {
  if (thread?.staff_state === "closed") return "closed";
  if (ctx.info.ended) {
    const since = endedAt ? Date.parse(`${endedAt.replace(" ", "T")}Z`) : Date.now();
    return Date.now() - since >= LIMITS.readOnlyDays * 86_400_000 ? "closed" : "read_only";
  }
  return thread?.staff_state === "muted" ? "paused" : "open";
}

/**
 * Who this person is in the context, what state it is in, and who else could be written to. 404 for anybody who is not in the context
 * (the same as for one that does not exist), and the first screen's refusals for somebody who is in it but has messaging off.
 */
async function access(userId: number, kind: ContextKind, id: number, opts: { lockThread?: boolean; needOn?: boolean } = {}): Promise<Access | Refusal> {
  const ctx = await contextOf(kind, id);
  const seat = ctx?.seats.find((s) => s.userId === userId);
  if (!ctx || !seat) return refuse("PM_NOT_FOUND");
  if (opts.needOn !== false) {
    const settings = await messageSettings(userId);
    if (!settings.adult) return refuse("PM_ADULTS");
    if (!settings.enabled) return refuse("PM_OFF");
  }
  const thread = await threadOf(kind, id, opts.lockThread);
  const endedAt = ctx.info.ended ? (ctx.info.endedAt ?? thread?.ended_at ?? nowStamp()) : null;
  if (thread && ctx.info.ended && !thread.ended_at && endedAt) {
    await getDb().prepare("UPDATE player_message_threads SET ended_at = ? WHERE id = ? AND ended_at IS NULL").run(endedAt, thread.id);
    thread.ended_at = endedAt;
  }
  const others = ctx.seats.filter((s) => s.userId !== userId);
  const eligible = await eligibleAmong(others.map((s) => s.userId));
  const eligibleOthers = others.filter((s) => eligible.has(s.userId));
  const blocked = await blockedWith(userId, eligibleOthers.map((s) => s.userId));
  return { ctx, seat, thread, phase: phaseOf(ctx, thread, endedAt), others: eligibleOthers, reachable: eligibleOthers.filter((s) => !blocked.has(s.userId)), endedAt };
}

/** A message is shown to a reader unless the reader and its sender have blocked one another either way (the sender's own always show). */
const VISIBLE = `(m.sender_id IS NULL OR m.sender_id = ? OR NOT EXISTS (
    SELECT 1 FROM player_blocks k WHERE (k.blocker_id = ? AND k.blocked_id = m.sender_id) OR (k.blocker_id = m.sender_id AND k.blocked_id = ?)))`;

const parseLabel = (raw: string | null): SeatLabel | null => {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as SeatLabel;
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
};

// ------------------------------------------------------------------ reading

export interface MessageOut {
  id: number;
  mine: boolean;
  /** How the sender showed in the context; null for one who has left the install. */
  from: SeatLabel | null;
  /** Null once the sender's account was erased. */
  body: string | null;
  at: string;
}

export interface ThreadView {
  kind: string;
  id: number;
  info: ContextInfo;
  phase: Phase;
  /** People who could be written to now, not counting you; not who. */
  people: number;
  canSend: boolean;
  /** Why not, as a refusal code, when `canSend` is false. */
  whyNot: MessageRefusalCode | null;
  muted: boolean;
  /** The thread's number, for a report or a block. */
  threadId: number | null;
  messages: MessageOut[];
  latestId: number;
}

async function isMuted(userId: number, kind: ContextKind, id: number): Promise<boolean> {
  return Boolean(await getDb().prepare("SELECT 1 FROM player_message_mutes WHERE user_id = ? AND context_kind = ? AND context_id = ?").get(userId, kind, id));
}

export type ThreadResult = { ok: true; view: ThreadView } | Refusal;

/**
 * One thread as this person sees it: the latest messages (those after `after`, for polling), minus anything from somebody who has
 * blocked them or whom they blocked. `markRead` moves their read mark to the newest shown.
 */
export async function threadView(userId: number, kind: ContextKind, id: number, opts: { after?: number; markRead?: boolean } = {}): Promise<ThreadResult> {
  const a = await access(userId, kind, id);
  if ("ok" in a) return a;
  if (a.phase === "closed") return refuse("PM_CLOSED");
  let rows: { id: number; sender_id: number | null; sender_label: string | null; body: string | null; created_at: string }[] = [];
  if (a.thread) {
    rows = (await getDb()
      .prepare(
        `SELECT m.id, m.sender_id, m.sender_label, m.body, m.created_at FROM player_messages m
          WHERE m.thread_id = ? AND m.id > ? AND ${VISIBLE} ORDER BY m.id DESC LIMIT ${LIMITS.shown}`
      )
      .all(a.thread.id, opts.after ?? 0, userId, userId, userId)) as typeof rows;
    rows.reverse();
  }
  const latestId = rows.length > 0 ? rows[rows.length - 1].id : (opts.after ?? 0);
  if (opts.markRead && a.thread && rows.length > 0)
    await getDb()
      .prepare(
        `INSERT INTO player_message_reads (user_id, thread_id, last_read_id) VALUES (?, ?, ?)
         ON CONFLICT (user_id, thread_id) DO UPDATE SET last_read_id = GREATEST(player_message_reads.last_read_id, excluded.last_read_id)`
      )
      .run(userId, a.thread.id, latestId);
  else if (opts.markRead && a.thread)
    await getDb().prepare("INSERT INTO player_message_reads (user_id, thread_id, last_read_id) VALUES (?, ?, 0) ON CONFLICT DO NOTHING").run(userId, a.thread.id);
  const suspended = await suspendedIn(userId, a.ctx.info.venueId);
  const whyNot: MessageRefusalCode | null =
    a.phase === "read_only" ? "PM_READ_ONLY" : a.phase === "paused" ? "PM_PAUSED" : suspended ? "PM_SUSPENDED" : a.others.length === 0 ? "PM_NOBODY" : null;
  return {
    ok: true,
    view: {
      kind: kindInUrl(kind),
      id,
      info: a.ctx.info,
      phase: a.phase,
      people: a.others.length,
      canSend: whyNot === null,
      whyNot,
      muted: await isMuted(userId, kind, id),
      threadId: a.thread?.id ?? null,
      messages: rows.map((r) => ({ id: r.id, mine: r.sender_id === userId, from: parseLabel(r.sender_label), body: r.body, at: r.created_at })),
      latestId,
    },
  };
}

export interface ThreadSummary {
  kind: string;
  id: number;
  info: ContextInfo;
  phase: Phase;
  people: number;
  unread: number;
  muted: boolean;
  lastAt: string | null;
}

/**
 * The person's contexts with somebody to write to, or a thread to read: each with unread messages, newest first. Nothing is listed
 * for somebody who has messaging off, and a context with nobody else on it and no thread is not listed at all.
 */
export async function myThreads(userId: number): Promise<{ settings: MessageSettings; threads: ThreadSummary[]; unread: number }> {
  const settings = await messageSettings(userId);
  if (!settings.enabled) return { settings, threads: [], unread: 0 };
  const out: ThreadSummary[] = [];
  for (const c of (await candidateContexts(userId)).slice(0, 100)) {
    const a = await access(userId, c.kind, c.id, { needOn: false });
    if ("ok" in a || a.phase === "closed") continue;
    let unread = 0;
    let lastAt: string | null = null;
    if (a.thread) {
      const r = (await getDb()
        .prepare(
          `SELECT COUNT(*) FILTER (WHERE m.id > COALESCE(r.last_read_id, 0) AND m.sender_id IS DISTINCT FROM ?)::int AS unread, MAX(m.created_at) AS last_at
             FROM player_messages m LEFT JOIN player_message_reads r ON r.thread_id = m.thread_id AND r.user_id = ?
            WHERE m.thread_id = ? AND ${VISIBLE}`
        )
        .get(userId, userId, a.thread.id, userId, userId, userId)) as { unread: number; last_at: string | null };
      unread = r.unread;
      lastAt = r.last_at;
    }
    if (a.others.length === 0 && lastAt === null) continue;
    out.push({ kind: kindInUrl(c.kind), id: c.id, info: a.ctx.info, phase: a.phase, people: a.others.length, unread, muted: await isMuted(userId, c.kind, c.id), lastAt });
  }
  out.sort((x, y) => (y.lastAt ?? "").localeCompare(x.lastAt ?? "") || x.kind.localeCompare(y.kind) || x.id - y.id);
  return { settings, threads: out, unread: out.filter((t) => !t.muted).reduce((n, t) => n + t.unread, 0) };
}

/** Unread messages across a person's threads, not counting muted contexts: the badge. Zero for anybody with messaging off. */
export async function unreadCount(userId: number): Promise<number> {
  return (await myThreads(userId)).unread;
}

export async function setContextMute(userId: number, kind: ContextKind, id: number, muted: boolean): Promise<{ ok: true; muted: boolean } | Refusal> {
  const a = await access(userId, kind, id, { needOn: false });
  if ("ok" in a) return a;
  if (muted) await getDb().prepare("INSERT INTO player_message_mutes (user_id, context_kind, context_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING").run(userId, kind, id);
  else await getDb().prepare("DELETE FROM player_message_mutes WHERE user_id = ? AND context_kind = ? AND context_id = ?").run(userId, kind, id);
  return { ok: true, muted };
}

// ------------------------------------------------------------------ sending

export type SendResult = { ok: true; message: MessageOut } | Refusal;

/**
 * Write a message. The checks, in this order, each a refusal with its own code: they are in the context (404 otherwise, as if it
 * did not exist), messaging on and declared adult, the text (empty, long, an email or phone number), the context open (not ended,
 * not paused by staff, not closed), not suspended here, somebody else who could be written to, the rate limits, and the limit on
 * new threads. A block between the writer and everybody else left is not a refusal: the message is kept and not delivered, and the
 * writer is not told.
 *
 * The writer's place in a game, team or group is locked `FOR SHARE` and the thread `FOR UPDATE`, so a message never lands after the
 * writer has left (the leaving waits, or this does), and two messages written at once are both kept, in an order.
 */
export async function sendMessage(userId: number, kind: ContextKind, id: number, rawBody: unknown): Promise<SendResult> {
  const text = cleanText(rawBody);
  if (!text) return refuse("PM_EMPTY");
  if ([...text].length > LIMITS.maxLength) return refuse("PM_LONG", { n: LIMITS.maxLength });
  let sent: { message: MessageOut; threadId: number; ctx: Context; reachable: Seat[] };
  try {
    sent = await withTransaction(async () => {
      await lockSeat(kind, id, userId);
      const a = await access(userId, kind, id, { lockThread: true });
      if ("ok" in a) throw new Refused(a);
      // The text comes after "in the context and on", so a stranger learns nothing from what is refused; before the rest, so an address is
      // never kept even in a conversation that is closed.
      if (contactDetail(text)) throw new Refused(refuse("PM_CONTACT"));
      if (a.phase === "closed") throw new Refused(refuse("PM_CLOSED"));
      if (a.phase === "read_only") throw new Refused(refuse("PM_READ_ONLY"));
      if (a.phase === "paused") throw new Refused(refuse("PM_PAUSED"));
      if (await suspendedIn(userId, a.ctx.info.venueId)) throw new Refused(refuse("PM_SUSPENDED"));
      if (a.others.length === 0) throw new Refused(refuse("PM_NOBODY"));
      const db = getDb();
      const hour = nowStamp(-60 * MINUTE);
      const day = nowStamp(-24 * 60 * MINUTE);
      const used = (await db
        .prepare(
          `SELECT COUNT(*) FILTER (WHERE created_at >= ?)::int AS hour, COUNT(*)::int AS day FROM player_messages WHERE sender_id = ? AND created_at >= ?`
        )
        .get(hour, userId, day)) as { hour: number; day: number };
      if (used.hour >= LIMITS.perHour || used.day >= LIMITS.perDay) throw new Refused(refuse("PM_RATE"));
      let thread = a.thread;
      if (!thread) {
        const made = await db
          .prepare("INSERT INTO player_message_threads (context_kind, context_id, venue_id, created_by) VALUES (?, ?, ?, ?) ON CONFLICT (context_kind, context_id) DO NOTHING")
          .run(kind, id, a.ctx.info.venueId, userId);
        thread = (await threadOf(kind, id, true))!;
        // Somebody wrote the first message at the same moment: the thread is theirs, and this is one more message in it.
        if (made.changes > 0) {
          const began = (await db.prepare("SELECT COUNT(*)::int AS n FROM player_message_threads WHERE created_by = ? AND created_at >= ?").get(userId, day)) as { n: number };
          if (began.n > LIMITS.newThreadsPerDay) throw new Refused(refuse("PM_NEW_THREADS"));
        }
        if (thread.staff_state !== "open") throw new Refused(refuse("PM_PAUSED"));
      }
      const inThread = (await db.prepare("SELECT COUNT(*)::int AS n FROM player_messages WHERE thread_id = ? AND sender_id = ? AND created_at >= ?").get(thread.id, userId, hour)) as { n: number };
      if (inThread.n >= LIMITS.perThreadPerHour) throw new Refused(refuse("PM_RATE"));
      const row = (await db
        .prepare("INSERT INTO player_messages (thread_id, sender_id, sender_label, body) VALUES (?, ?, ?, ?) RETURNING id, created_at")
        .get(thread.id, userId, JSON.stringify(a.seat.from), text)) as { id: number; created_at: string };
      await db.prepare("UPDATE player_message_threads SET last_message_at = ?, message_count = message_count + 1 WHERE id = ?").run(row.created_at, thread.id);
      await db
        .prepare(
          `INSERT INTO player_message_reads (user_id, thread_id, last_read_id) VALUES (?, ?, ?)
           ON CONFLICT (user_id, thread_id) DO UPDATE SET last_read_id = GREATEST(player_message_reads.last_read_id, excluded.last_read_id)`
        )
        .run(userId, thread.id, row.id);
      return {
        message: { id: row.id, mine: true, from: a.seat.from, body: text, at: row.created_at },
        threadId: thread.id,
        ctx: a.ctx,
        reachable: a.reachable,
      };
    });
  } catch (err) {
    if (err instanceof Refused) return err.refusal;
    throw err;
  }
  await tellReaders(sent.threadId, sent.ctx, userId, sent.reachable);
  return { ok: true, message: sent.message };
}

// ------------------------------------------------------------------ telling people

/**
 * An email to each person who can read the message, saying they have one in this place, never what it says. At most one per thread
 * per `digestHours`, at most `emailsPerDay` a person, none to somebody who muted the context or turned the emails off. Not WhatsApp.
 * Errors here are logged without any text of a message and never undo the message.
 */
async function tellReaders(threadId: number, ctx: Context, senderId: number, readers: Seat[]): Promise<void> {
  const db = getDb();
  for (const seat of readers) {
    try {
      if (seat.userId === senderId) continue;
      if (await isMuted(seat.userId, ctx.info.kind, ctx.info.id)) continue;
      const s = (await db.prepare("SELECT email_notices FROM player_message_settings WHERE user_id = ?").get(seat.userId)) as { email_notices: number } | undefined;
      if (!s || s.email_notices !== 1) continue;
      const since = (await db
        .prepare(
          `SELECT COUNT(*) FILTER (WHERE thread_id = ? AND sent_at >= ?)::int AS here, COUNT(*)::int AS today FROM player_message_notices WHERE user_id = ? AND sent_at >= ?`
        )
        .get(threadId, nowStamp(-LIMITS.digestHours * 60 * MINUTE), seat.userId, nowStamp(-24 * 60 * MINUTE))) as { here: number; today: number };
      if (since.here > 0 || since.today >= LIMITS.emailsPerDay) continue;
      // The one claim of the period: a second message at the same moment finds it taken.
      const claimed = await db
        .prepare(
          `INSERT INTO player_message_notices (user_id, thread_id)
           SELECT ?, ? WHERE NOT EXISTS (SELECT 1 FROM player_message_notices WHERE user_id = ? AND thread_id = ? AND sent_at >= ?)`
        )
        .run(seat.userId, threadId, seat.userId, threadId, nowStamp(-LIMITS.digestHours * 60 * MINUTE));
      if (claimed.changes === 0) continue;
      const { siteName } = await import("./site");
      const { baseUrl } = await import("./outbox");
      const link = `${baseUrl()}/messages?open=${kindInUrl(ctx.info.kind)}:${ctx.info.id}`;
      await emailPlayer({
        kind: "player_message",
        venueId: null,
        userId: seat.userId,
        subject: (t) => t("pmsg.mail.subject", { site: siteName() }),
        body: (t) => t("pmsg.mail.body", { context: contextTitle(t, ctx.info) }),
        link,
        dedupeKey: `pmsg:${threadId}:${seat.userId}:${Math.floor(Date.now() / (LIMITS.digestHours * 60 * MINUTE))}`,
      });
    } catch (err) {
      // The mail is a courtesy: the message stands. Nothing of its text is in scope here.
      console.error("[mysenam] could not queue a message notice:", err instanceof Error ? err.message : "unknown error");
    }
  }
}

// ------------------------------------------------------------------ safety

/** Block the sender of a message you can read (the same block as everywhere: nothing they write reaches you, nothing you write reaches them, and neither is told). */
export async function blockSender(userId: number, kind: ContextKind, id: number, messageId: number): Promise<{ ok: true } | Refusal> {
  const a = await access(userId, kind, id, { needOn: false });
  if ("ok" in a) return a;
  const sender = a.thread
    ? ((await getDb()
        .prepare(`SELECT m.sender_id FROM player_messages m WHERE m.id = ? AND m.thread_id = ? AND ${VISIBLE}`)
        .get(messageId, a.thread.id, userId, userId, userId)) as { sender_id: number | null } | undefined)
    : undefined;
  if (!sender || sender.sender_id === null) return refuse("PM_NOT_FOUND");
  if (sender.sender_id === userId) return refuse("PM_OWN");
  const done = await blockPlayer(userId, sender.sender_id, { related: true });
  return done.ok ? { ok: true } : refuse("PM_NOT_FOUND");
}

export type ReportResult = { ok: true; suspended: boolean } | Refusal;

/**
 * Report a message you can read, not your own. It freezes a copy of the thread's last messages as you saw them, with the reported one
 * marked, for the staff of the context's venue (the platform owner where it has none). Reporting the same message twice is one report.
 * When `autoSuspendReporters` different people have reported the same person within `autoSuspendDays`, their messaging is suspended
 * everywhere until the platform owner reviews it (deterministic, published; ADR 0039).
 */
export async function reportMessage(userId: number, kind: ContextKind, id: number, input: { messageId: unknown; reason: unknown; note?: unknown }): Promise<ReportResult> {
  if (!(REPORT_REASONS as readonly unknown[]).includes(input.reason)) return refuse("PM_REASON");
  if (!Number.isInteger(input.messageId)) return refuse("PM_NOT_FOUND");
  const messageId = input.messageId as number;
  const note = typeof input.note === "string" ? input.note.trim().slice(0, 1000) || null : null;
  try {
    return await withTransaction(async () => {
      const a = await access(userId, kind, id, { needOn: false });
      if ("ok" in a) throw new Refused(a);
      if (!a.thread) throw new Refused(refuse("PM_NOT_FOUND"));
      const db = getDb();
      const target = (await db
        .prepare(`SELECT m.id, m.sender_id, m.sender_label, m.body FROM player_messages m WHERE m.id = ? AND m.thread_id = ? AND ${VISIBLE}`)
        .get(messageId, a.thread.id, userId, userId, userId)) as { id: number; sender_id: number | null; sender_label: string | null; body: string | null } | undefined;
      if (!target || target.sender_id === null || target.body === null) throw new Refused(refuse("PM_NOT_FOUND"));
      if (target.sender_id === userId) throw new Refused(refuse("PM_OWN"));
      const today = (await db.prepare("SELECT COUNT(*)::int AS n FROM player_message_reports WHERE reporter_id = ? AND created_at >= ?").get(userId, nowStamp(-24 * 60 * MINUTE))) as { n: number };
      if (today.n >= LIMITS.reportsPerDay) throw new Refused(refuse("PM_REPORT_LIMIT"));
      const made = (await db
        .prepare(
          `INSERT INTO player_message_reports (thread_id, message_id, context_kind, context_id, venue_id, reporter_id, reported_id, reporter_label, reported_label, reason, note)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING id`
        )
        .get(a.thread.id, messageId, kind, id, a.thread.venue_id, userId, target.sender_id, JSON.stringify(a.seat.from), target.sender_label, input.reason, note)) as { id: number } | undefined;
      // Said before: one report is enough.
      if (!made) return { ok: true as const, suspended: false };
      const lines = (await db
        .prepare(
          `SELECT m.id, m.sender_id, m.sender_label, m.body, m.created_at FROM player_messages m
            WHERE m.thread_id = ? AND ${VISIBLE} ORDER BY m.id DESC LIMIT ${LIMITS.reportLines}`
        )
        .all(a.thread.id, userId, userId, userId)) as { id: number; sender_id: number | null; sender_label: string | null; body: string | null; created_at: string }[];
      for (const l of lines.reverse())
        await db
          .prepare("INSERT INTO player_message_report_lines (report_id, message_id, sender_id, sender_label, body, sent_at, flagged) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(made.id, l.id, l.sender_id, l.sender_label, l.body, l.created_at, l.id === messageId ? 1 : 0);
      return { ok: true as const, suspended: await autoSuspend(target.sender_id, made.id) };
    });
  } catch (err) {
    if (err instanceof Refused) return err.refusal;
    throw err;
  }
}

/** The published rule: three different people's reports within thirty days (none yet found to need no action) suspend somebody's messaging, until the owner reviews it. */
async function autoSuspend(reportedId: number, reportId: number): Promise<boolean> {
  const db = getDb();
  const { n } = (await db
    .prepare(
      `SELECT COUNT(DISTINCT reporter_id)::int AS n FROM player_message_reports
        WHERE reported_id = ? AND reporter_id IS NOT NULL AND created_at >= ? AND (outcome IS NULL OR outcome <> 'no_action')`
    )
    .get(reportedId, nowStamp(-LIMITS.autoSuspendDays * 24 * 60 * MINUTE))) as { n: number };
  if (n < LIMITS.autoSuspendReporters) return false;
  const made = await db
    .prepare(
      `INSERT INTO player_message_suspensions (user_id, source, venue_id, reason, report_id) VALUES (?, 'automatic', NULL, ?, ?)
       ON CONFLICT DO NOTHING`
    )
    .run(reportedId, `Reported by ${n} different people within ${LIMITS.autoSuspendDays} days`, reportId);
  return made.changes > 0;
}
