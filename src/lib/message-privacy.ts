import { getDb } from "./db";
import { addDays, todayISO } from "./time";

/**
 * What the privacy rules do to messages between players (docs/architecture/privacy.md#messages-between-players; ADR 0039): the
 * personal-data export, erasure with the account, and retention. Messages are personal data of both sides: the export holds what a
 * person wrote and what they were shown, erasure replaces what they wrote with "message removed" (the other side's messages stay
 * for them), and a thread is deleted a set time after its context ended. Nothing of this is public, in the venue API or in the MCP tools.
 */

/** Days a thread is kept after its context ended: the install's (MESSAGE_RETENTION_DAYS), 90 by default, within 7 to 730. */
export function threadRetentionDays(): number {
  const n = Number(process.env.MESSAGE_RETENTION_DAYS);
  return Number.isInteger(n) && n >= 7 && n <= 730 ? n : 90;
}

/** Days a report and its frozen copy are kept after it was dealt with: MESSAGE_REPORT_RETENTION_DAYS, 365 by default, within 30 to 1095. */
export function reportRetentionDays(): number {
  const n = Number(process.env.MESSAGE_REPORT_RETENTION_DAYS);
  return Number.isInteger(n) && n >= 30 && n <= 1095 ? n : 365;
}

/**
 * Everything messaging holds about this account: its setting, the contexts it muted, each thread it can read with the messages it was
 * shown (its own, and the others' as they showed in the context, never an address or a full name), the reports it made, and the
 * suspensions that applied to it, with their reasons. How many reports were made about it is counted, not described: the report is the
 * reporter's and the venue's record.
 */
export async function messagesExport(userId: number): Promise<unknown> {
  const db = getDb();
  const all = async (sql: string, ...args: unknown[]) => (await db.prepare(sql).all(...args)) as Record<string, unknown>[];
  const threads = await all(
    `SELECT t.id, t.context_kind, t.context_id, t.created_at, t.ended_at, t.staff_state FROM player_message_threads t
      WHERE t.id IN (SELECT thread_id FROM player_messages WHERE sender_id = ?) OR t.id IN (SELECT thread_id FROM player_message_reads WHERE user_id = ?)
      ORDER BY t.id`,
    userId,
    userId
  );
  const out = [];
  for (const t of threads) {
    const messages = await all(
      `SELECT m.id, (m.sender_id = ?) AS mine, m.sender_label AS from_label, m.body, m.created_at
         FROM player_messages m
        WHERE m.thread_id = ? AND (m.sender_id IS NULL OR m.sender_id = ? OR NOT EXISTS (
                SELECT 1 FROM player_blocks k WHERE (k.blocker_id = ? AND k.blocked_id = m.sender_id) OR (k.blocker_id = m.sender_id AND k.blocked_id = ?)))
        ORDER BY m.id`,
      userId,
      t.id,
      userId,
      userId,
      userId
    );
    out.push({ ...t, messages });
  }
  return {
    settings: (await all("SELECT enabled, email_notices, explained_at, enabled_at FROM player_message_settings WHERE user_id = ?", userId))[0] ?? null,
    mutedContexts: await all("SELECT context_kind, context_id, muted_at FROM player_message_mutes WHERE user_id = ? ORDER BY muted_at", userId),
    threads: out,
    emailNoticesSent: await all("SELECT sent_at FROM player_message_notices WHERE user_id = ? ORDER BY sent_at", userId),
    reportsMade: await all("SELECT context_kind, reason, note, status, outcome, created_at FROM player_message_reports WHERE reporter_id = ? ORDER BY id", userId),
    reportsAboutYou: ((await db.prepare("SELECT COUNT(*)::int AS n FROM player_message_reports WHERE reported_id = ?").get(userId)) as { n: number }).n,
    suspensions: await all(
      "SELECT source, reason, created_at, lifted_at, lift_reason FROM player_message_suspensions WHERE user_id = ? ORDER BY id",
      userId
    ),
  };
}

/**
 * Called inside the erasure of an account, before its row goes: what they wrote becomes "message removed" in every thread (and in the
 * frozen copy of a report), their label and the words of the reports they made are cleared, and what is theirs alone goes with the
 * account (its setting, mutes, read marks, notices and suspensions, by the foreign keys). The other people's messages stay for them.
 */
export async function forgetMessagesOfUser(userId: number): Promise<void> {
  const db = getDb();
  await db.prepare("UPDATE player_messages SET body = NULL, sender_label = NULL, removed_at = datetime('now') WHERE sender_id = ?").run(userId);
  await db.prepare("UPDATE player_message_report_lines SET body = NULL, sender_label = NULL WHERE sender_id = ?").run(userId);
  await db.prepare("UPDATE player_message_reports SET reporter_label = NULL, note = NULL WHERE reporter_id = ?").run(userId);
  await db.prepare("UPDATE player_message_reports SET reported_label = NULL WHERE reported_id = ?").run(userId);
}

/**
 * Retention, from the retention job (lib/privacy.ts): a thread whose context has ended is deleted `days` after it ended (messages,
 * read marks and notices with it); one not yet seen to have ended is looked at first, so a game played and forgotten is dated by when it
 * finished, not by when somebody next opened it. A report is kept until it has been dealt with and then `reportDays` more, with its frozen
 * copy; an open one stays.
 */
export async function pruneMessages(threadCutoff: string): Promise<void> {
  const db = getDb();
  // Contexts that ended without anybody looking: dated now, as `access` does on a first look (the end of a game is read from the game).
  const { contextOf } = await import("./message-contexts");
  const unseen = (await db
    .prepare("SELECT id, context_kind, context_id FROM player_message_threads WHERE ended_at IS NULL")
    .all()) as { id: number; context_kind: Parameters<typeof contextOf>[0]; context_id: number }[];
  for (const t of unseen) {
    const ctx = await contextOf(t.context_kind, t.context_id);
    // A context that no longer exists (its game or team deleted) has ended, with no date of its own.
    if (!ctx || ctx.info.ended)
      await db
        .prepare("UPDATE player_message_threads SET ended_at = ? WHERE id = ? AND ended_at IS NULL")
        .run(ctx?.info.endedAt ?? new Date().toISOString().slice(0, 19).replace("T", " "), t.id);
  }
  await db.prepare("DELETE FROM player_message_threads WHERE ended_at IS NOT NULL AND ended_at < ?").run(threadCutoff);
}

export async function pruneMessageReports(reportCutoff: string): Promise<void> {
  await getDb().prepare("DELETE FROM player_message_reports WHERE status = 'reviewed' AND reviewed_at < ?").run(reportCutoff);
}

/** How many threads and reports the next prune removes: the retention screen's count. */
export async function messagesDue(threadCutoff: string, reportCutoff: string): Promise<{ threads: number; reports: number }> {
  const db = getDb();
  const threads = (await db.prepare("SELECT COUNT(*)::int AS n FROM player_message_threads WHERE ended_at IS NOT NULL AND ended_at < ?").get(threadCutoff)) as { n: number };
  const reports = (await db.prepare("SELECT COUNT(*)::int AS n FROM player_message_reports WHERE status = 'reviewed' AND reviewed_at < ?").get(reportCutoff)) as { n: number };
  return { threads: threads.n, reports: reports.n };
}

/** The cutoff stamps for a number of days. */
export const cutoffFor = (days: number): string => `${addDays(todayISO(), -days)} 00:00:00`;
