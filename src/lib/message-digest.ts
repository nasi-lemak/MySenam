import { getDb } from "./db";
import { contextOf, kindInUrl, type Context, type ContextKind, type Seat } from "./message-contexts";
import { digestHours, LIMITS, type NoticeChoice } from "./message-limits";
import { eligibleAmong, isMuted, nowStamp, VISIBLE } from "./messages";
import { contextTitle } from "./message-titles";
import { baseUrl, emailPlayer } from "./outbox";
import { guardianNoticeMode } from "./youth-messages";

/**
 * How people are told they have unread messages (docs/features/player-messages.md#telling-people-a-digest-never-the-message; ADR 0044).
 *
 * A **digest**, not a leading-edge throttle: by default one email per person per conversation per period (`MESSAGE_DIGEST_HOURS`, 6),
 * sent by the scheduler (the outbox tick) once the period in which a message arrived is over, if anything arrived and is still unread: "you
 * have N new messages in {context}". **Never the text of a message, nor its sender.** Each person chooses *at once*, *6-hourly* (the
 * install's period) or *daily* in their messaging settings; for a minor, the guardian's choice governs (`youth_guardian_settings`), and
 * "off" is the guardian's to choose. The per-person limit of `emailsPerDay` notices stands. Periods are fixed slots of the clock (UTC), so
 * a message is told of at the end of its own slot, and a notice that has been sent is recorded with the newest message it covered
 * (`through_id`): the scheduler never tells the same person about the same messages twice, whatever runs it and however often.
 *
 * Urgent safety and moderation events are not here: they are immediate, never digested and never held to the daily limit
 * (lib/youth-safeguarding.ts, the `safeguarding_notice` kind).
 */

export { digestHours };

const HOUR = 3_600_000;
const periodMs = (mode: "digest" | "daily"): number => (mode === "daily" ? 24 : digestHours()) * HOUR;

/** How this reader is told, or null for not at all: their own choice for an adult, their guardian's for a minor. */
async function noticeModeOf(seat: Seat): Promise<NoticeChoice | null> {
  if (seat.minor) {
    const mode = await guardianNoticeMode(seat.userId);
    return mode === "off" ? null : mode;
  }
  const row = (await getDb().prepare("SELECT email_notices, notice_mode FROM player_message_settings WHERE user_id = ?").get(seat.userId)) as { email_notices: number; notice_mode: NoticeChoice } | undefined;
  return row && row.email_notices === 1 ? row.notice_mode : null;
}

const utcMs = (stamp: string): number => Date.parse(`${stamp.replace(" ", "T")}Z`);

/** Notices sent to this person in the last day, against the daily limit. */
async function sentToday(userId: number): Promise<number> {
  return ((await getDb().prepare("SELECT COUNT(*)::int AS n FROM player_message_notices WHERE user_id = ? AND sent_at >= ?").get(userId, nowStamp(-24 * HOUR))) as { n: number }).n;
}

/** Records that these messages have been told of (the claim: a second run finds it taken) and queues the email. False when it was taken already. */
async function notify(userId: number, threadId: number, ctx: Pick<Context, "info">, throughId: number, count: number): Promise<boolean> {
  const claimed = await getDb()
    .prepare("INSERT INTO player_message_notices (user_id, thread_id, through_id, message_count) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING")
    .run(userId, threadId, throughId, count);
  if (claimed.changes === 0) return false;
  const { siteName } = await import("./site");
  await emailPlayer({
    kind: "player_message",
    venueId: null,
    userId,
    subject: (t) => t("pmsg.mail.subject", { site: siteName() }),
    body: (t) => t.plural("pmsg.mail.digest", count, { context: contextTitle(t, ctx.info) }),
    link: `${baseUrl()}/messages?open=${kindInUrl(ctx.info.kind)}:${ctx.info.id}`,
    dedupeKey: `pmsg:d:${threadId}:${userId}:${throughId}`,
  });
  return true;
}

/**
 * Right after a message: an email now, to each reader who chose *at once*, within the daily limit; muted conversations and readers whose
 * block keeps the message from them are left out (`readers` are the writer's reachable seats). Everybody else waits for their digest.
 */
export async function tellImmediate(threadId: number, ctx: Context, senderId: number, readers: Seat[], messageId: number): Promise<void> {
  for (const seat of readers) {
    try {
      if (seat.userId === senderId || (await isMuted(seat.userId, ctx.info.kind, ctx.info.id))) continue;
      if ((await noticeModeOf(seat)) !== "immediate") continue;
      if ((await sentToday(seat.userId)) >= LIMITS.emailsPerDay) continue;
      await notify(seat.userId, threadId, ctx, messageId, 1);
    } catch (err) {
      console.error("[mysenam] could not queue a message notice:", err instanceof Error ? err.message : "unknown error");
    }
  }
}

const lastRun = { at: 0 };

/**
 * The scheduler's part (lib/notify.ts `tickOutbox`): for each conversation with recent messages, each reader who is told by digest and has
 * unread messages from a period that is over, is sent one notice with the count. At most once a minute from the tick; `now` and `force` for tests.
 * Returns how many notices were queued. Never throws: one conversation that fails does not stop the rest.
 */
export async function sendDueDigests(opts: { now?: number; force?: boolean } = {}): Promise<number> {
  const now = opts.now ?? Date.now();
  if (!opts.force && now - lastRun.at < 60_000) return 0;
  lastRun.at = now;
  const db = getDb();
  const threads = (await db
    .prepare(
      `SELECT id, context_kind, context_id, youth_since_id FROM player_message_threads
        WHERE last_message_at >= ? AND staff_state <> 'closed' ORDER BY id`
    )
    .all(new Date(now - 3 * 24 * HOUR).toISOString().slice(0, 19).replace("T", " "))) as { id: number; context_kind: ContextKind; context_id: number; youth_since_id: number }[];
  let sent = 0;
  for (const t of threads) {
    try {
      const ctx = await contextOf(t.context_kind, t.context_id);
      if (!ctx) continue;
      const adults = await eligibleAmong(ctx.seats.filter((s) => !s.minor).map((s) => s.userId));
      for (const seat of ctx.seats) {
        if (!seat.minor && !adults.has(seat.userId)) continue;
        // An adult whose access is paused is told nothing of what is written (ADR 0049): not even that there are messages.
        if (seat.restricted) continue;
        const mode = await noticeModeOf(seat);
        if (mode === null || mode === "immediate") continue;
        if (await isMuted(seat.userId, ctx.info.kind, ctx.info.id)) continue;
        // A supervisor reads everything, blocks or not (the same view as the thread's).
        const supervisor = seat.role === "supervisor";
        const rows = (await db
          .prepare(
            `SELECT m.id, m.created_at FROM player_messages m
              WHERE m.thread_id = ? AND m.sender_id IS DISTINCT FROM ? AND m.hidden_at IS NULL AND m.id > ?
                AND m.id > GREATEST(COALESCE((SELECT r.last_read_id FROM player_message_reads r WHERE r.user_id = ? AND r.thread_id = m.thread_id), 0),
                                    COALESCE((SELECT MAX(n.through_id) FROM player_message_notices n WHERE n.user_id = ? AND n.thread_id = m.thread_id), 0))
                AND ${VISIBLE}
              ORDER BY m.id`
          )
          .all(t.id, seat.userId, t.youth_since_id, seat.userId, seat.userId, seat.userId, supervisor ? 0 : seat.userId, supervisor ? 0 : seat.userId)) as { id: number; created_at: string }[];
        const period = periodMs(mode);
        // Told of at the end of the slot the message arrived in: only the messages whose slot is over.
        const due = rows.filter((r) => Math.floor(utcMs(r.created_at) / period) < Math.floor(now / period));
        if (due.length === 0) continue;
        if ((await sentToday(seat.userId)) >= LIMITS.emailsPerDay) continue;
        if (await notify(seat.userId, t.id, ctx, due[due.length - 1].id, due.length)) sent++;
      }
    } catch (err) {
      console.error("[mysenam] could not queue a message digest:", err instanceof Error ? err.message : "unknown error");
    }
  }
  return sent;
}
