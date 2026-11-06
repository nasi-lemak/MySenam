import { getDb } from "./db";
import { addDays, todayISO } from "./time";
import { ACTIVE_CASE_GROUPS, LEGAL_HELD_REPORTS } from "./youth-evidence-sql";

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

/** Days a supervised youth group's conversation is kept after the group ended: YOUTH_MESSAGE_RETENTION_DAYS, 60 by default, within 7 to 365 (shorter than adults'). */
export function youthThreadRetentionDays(): number {
  const n = Number(process.env.YOUTH_MESSAGE_RETENTION_DAYS);
  return Number.isInteger(n) && n >= 7 && n <= 365 ? n : 60;
}

/** Days a message a supervisor removed keeps its words (for staff review) before they are deleted: YOUTH_REMOVED_RETENTION_DAYS, 30 by default, within 7 to 365. */
export function youthRemovedRetentionDays(): number {
  const n = Number(process.env.YOUTH_REMOVED_RETENTION_DAYS);
  return Number.isInteger(n) && n >= 7 && n <= 365 ? n : 30;
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
    `SELECT t.id, t.context_kind, t.context_id, t.created_at, t.ended_at, t.staff_state, t.youth, t.youth_since_id FROM player_message_threads t
      WHERE t.id IN (SELECT thread_id FROM player_messages WHERE sender_id = ?) OR t.id IN (SELECT thread_id FROM player_message_reads WHERE user_id = ?)
      ORDER BY t.id`,
    userId,
    userId
  );
  const out = [];
  for (const t of threads) {
    const messages = await all(
      `SELECT m.id, (m.sender_id = ?) AS mine, m.sender_label AS from_label, CASE WHEN m.hidden_at IS NULL THEN m.body END AS body, (m.hidden_at IS NOT NULL) AS removed_by_supervisor, m.created_at
         FROM player_messages m
        WHERE m.thread_id = ? AND m.id > ? AND (m.sender_id IS NULL OR m.sender_id = ? OR NOT EXISTS (
                SELECT 1 FROM player_blocks k WHERE (k.blocker_id = ? AND k.blocked_id = m.sender_id) OR (k.blocker_id = m.sender_id AND k.blocked_id = ?)))
        ORDER BY m.id`,
      userId,
      t.id,
      t.youth_since_id,
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
    reportsMade: await all(
      "SELECT context_kind, reason, note, status, CASE WHEN outcome = 'restriction_continues' THEN 'action_taken' ELSE outcome END AS outcome, created_at FROM player_message_reports WHERE reporter_id = ? ORDER BY id",
      userId
    ),
    // Reports in a youth thread are not counted here, while open or after: nothing in this person's data may say that one names them (ADR 0049). The
    // frozen copy of any report is never in a person's own export (it is the reporter's and the venue's evidence), and a report's evidence is never in the
    // export of the person it names.
    reportsAboutYou: ((await db.prepare("SELECT COUNT(*)::int AS n FROM player_message_reports WHERE reported_id = ? AND urgent = 0").get(userId)) as { n: number }).n,
    suspensions: await all(
      "SELECT source, reason, created_at, lifted_at, lift_reason FROM player_message_suspensions WHERE user_id = ? ORDER BY id",
      userId
    ),
    // The person's own requests for a review of a suspension (ADR 0059): what they wrote and the outcome in neutral words; never anything of a report.
    reviewRequests: await all("SELECT message, status, outcome, created_at, decided_at FROM player_message_suspension_appeals WHERE user_id = ? ORDER BY id", userId),
    // Supervised youth groups (ADR 0044): what this person did, was asked, or was made for them, and the children's group messages a guardian can export.
    youthMessaging: {
      optIns: await all("SELECT group_id, opted_in_at, revoked_at FROM youth_message_optins WHERE user_id = ? ORDER BY id", userId),
      consentsForYou: await all("SELECT group_id, granted_at, revoked_at FROM youth_message_consents WHERE minor_user_id = ? ORDER BY id", userId),
      consentsYouGave: await all("SELECT group_id, minor_user_id, participant_id, granted_at, revoked_at FROM youth_message_consents WHERE guardian_user_id = ? ORDER BY id", userId),
      rolesInGroups: await all("SELECT group_id, role, declared_role, created_at, removed_at FROM youth_group_adults WHERE user_id = ? ORDER BY id", userId),
      // A pause is a pause, whatever placed it: the same one neutral fact for a supervisor's and a report's (ADR 0049).
      pausedInGroups: await all("SELECT group_id, created_at, lifted_at FROM youth_thread_mutes WHERE user_id = ? ORDER BY id", userId),
      noticeChoiceForChild: await all("SELECT notice_mode FROM youth_guardian_settings WHERE minor_user_id = ?", userId),
      childrenGroupMessages: await (await import("./youth-safeguarding")).youthExportForGuardian(userId),
    },
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
  // The frozen copy of a report in a youth thread that is held (open, or its restriction still in force) is evidence a safeguarding review may need:
  // it is kept as it is until the hold ends, then the ordinary report retention applies and the erasure takes it with the rest (ADR 0049).
  await db.prepare(`UPDATE player_message_report_lines SET body = NULL, sender_label = NULL WHERE sender_id = ? AND report_id NOT IN (${HELD_REPORTS})`).run(userId);
  // Under a legal hold (ADR 0052) even the reporter's label and note stay with the held evidence copy: the person's account is erased, the held copy is not.
  await db.prepare(`UPDATE player_message_reports SET reporter_label = NULL, note = NULL WHERE reporter_id = ? AND id NOT IN (${LEGAL_HELD_REPORTS})`).run(userId);
  await db.prepare(`UPDATE player_message_reports SET reported_label = NULL WHERE reported_id = ? AND id NOT IN (${HELD_REPORTS})`).run(userId);
}

/** SQL: the reports in a youth thread whose evidence is held: still open, or the restriction they placed is still in force, or under a legal hold (ADR 0052). Exempt from ordinary retention and from erasure. */
const HELD_REPORTS = `SELECT hr.id FROM player_message_reports hr
   WHERE hr.urgent = 1 AND (hr.status = 'open' OR EXISTS (SELECT 1 FROM youth_thread_mutes hm WHERE hm.report_id = hr.id AND hm.lifted_at IS NULL))
   UNION ${LEGAL_HELD_REPORTS}`;

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
  // A supervised youth group's conversation has its own, shorter period (pruneYouthMessages).
  await db.prepare("DELETE FROM player_message_threads WHERE ended_at IS NOT NULL AND ended_at < ? AND youth = 0").run(threadCutoff);
}

/**
 * Retention of supervised youth groups' conversations, from the retention job: a conversation is deleted `YOUTH_MESSAGE_RETENTION_DAYS` (60)
 * after its group ended, and the words of a message a supervisor removed are deleted `YOUTH_REMOVED_RETENTION_DAYS` (30) after it was removed
 * (the message stays, as "removed", for the thread's own period). Called with the cutoff for the first.
 */
export async function pruneYouthMessages(threadCutoff: string): Promise<void> {
  const db = getDb();
  // An ordinary-retention timer never deletes the evidence of an active case: while a report is open, a restriction is in force, a review or a request for a
  // review is open, or a legal hold stands, the group's conversation (and what a supervisor removed from it) is left alone. Only once the case closes does
  // ordinary retention resume for the live conversation; the evidence copy stays in its own class (ADR 0052).
  await db.prepare(`DELETE FROM player_message_threads WHERE ended_at IS NOT NULL AND ended_at < ? AND youth = 1 AND context_id NOT IN (${ACTIVE_CASE_GROUPS})`).run(threadCutoff);
  await db
    .prepare(
      `UPDATE player_messages SET body = NULL, removed_at = datetime('now') WHERE hidden_at IS NOT NULL AND hidden_at < ? AND body IS NOT NULL
          AND thread_id NOT IN (SELECT t.id FROM player_message_threads t WHERE t.youth = 1 AND t.context_kind = 'group' AND t.context_id IN (${ACTIVE_CASE_GROUPS}))`
    )
    .run(cutoffFor(youthRemovedRetentionDays()));
}

export async function pruneMessageReports(reportCutoff: string): Promise<void> {
  const db = getDb();
  // A report in an ordinary (adults') thread is kept until it has been dealt with and MESSAGE_REPORT_RETENTION_DAYS have passed. A report in a youth thread is
  // **safeguarding evidence**: no period is invented for it, and the ordinary job never deletes it; only an install's own SAFEGUARDING_EVIDENCE_RETENTION_DAYS
  // does, for closed cases (lib/youth-evidence.ts), and never one under a legal hold or with a restriction in force (ADR 0052).
  await db.prepare(`DELETE FROM player_message_reports WHERE urgent = 0 AND status = 'reviewed' AND reviewed_at < ? AND id NOT IN (${HELD_REPORTS})`).run(reportCutoff);
}

/** How many threads and reports the next prune removes: the retention screen's count. */
export async function messagesDue(threadCutoff: string, reportCutoff: string): Promise<{ threads: number; reports: number }> {
  const db = getDb();
  const threads = (await db.prepare("SELECT COUNT(*)::int AS n FROM player_message_threads WHERE ended_at IS NOT NULL AND ended_at < ? AND youth = 0").get(threadCutoff)) as { n: number };
  const reports = (await db.prepare(`SELECT COUNT(*)::int AS n FROM player_message_reports WHERE urgent = 0 AND status = 'reviewed' AND reviewed_at < ? AND id NOT IN (${HELD_REPORTS})`).get(reportCutoff)) as { n: number };
  return { threads: threads.n, reports: reports.n };
}

/** The cutoff stamps for a number of days. */
export const cutoffFor = (days: number): string => `${addDays(todayISO(), -days)} 00:00:00`;
