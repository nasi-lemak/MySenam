import { getDb, withTransaction } from "./db";
import { isOwner, type Admin } from "./admin-auth";
import { logAction } from "./activity";
import { countedReporters, LIMITS } from "./messages";
import { kindInUrl, type ContextKind, type SeatLabel } from "./message-contexts";
import { declaredAdult } from "./player-profiles";
import { adminIsAccusedIn, adminIsUser, namesTheViewerSql } from "./safeguarding-conflict";

/**
 * What a venue's staff and the platform's owner may do about messages between players (docs/features/player-messages.md#moderation;
 * ADR 0039).
 *
 * **Who sees what.** Nobody on staff reads an ordinary message: there is no screen of threads. What staff see is a *report*, with the
 * copy of the thread's last messages frozen with it. A venue's staff see the reports of contexts that belong to their venue (its games,
 * its tournaments, leagues and ladders, its teams); the platform owner sees the reports of contexts with no venue (a community group, a
 * team that plays from no venue) and the platform-wide suspensions, the automatic ones above all. The owner does not read a venue's
 * reports (except those behind an automatic suspension in force, which the owner is asked to review: ADR 0059) and a venue does not read another's: a context's venue is
 * fixed when its thread begins.
 *
 * **What they may do:** mark a report dealt with (nothing needed, or something done); mute a thread (nobody may write, undone by
 * a manager) or close it for good; and suspend a person's messaging with a reason, for the venue's own contexts only (a venue, and only
 * with a report about that person in hand) or everywhere (the owner). Each is logged in the activity log by its report or thread number
 * and the reason given, never any message text. These are manager-only routes (lib/roles.ts).
 */

export interface Scope {
  owner: boolean;
  venueIds: number[];
}

export const scopeOf = (admin: Admin): Scope => ({ owner: isOwner(admin), venueIds: admin.venueIds ?? [] });

/** A thread, report or suspension is this person's to deal with only where its venue is theirs (no venue: the owner's). */
export const inScope = (scope: Scope, venueId: number | null): boolean => (venueId === null ? scope.owner : !scope.owner && scope.venueIds.includes(venueId));

/** SQL for a venue column: the rows this scope may see. */
function scopeSql(scope: Scope, column: string): { sql: string; args: number[] } {
  if (scope.owner) return { sql: `${column} IS NULL`, args: [] };
  if (scope.venueIds.length === 0) return { sql: "FALSE", args: [] };
  return { sql: `${column} IN (${scope.venueIds.map(() => "?").join(",")})`, args: scope.venueIds };
}

/**
 * SQL for the reports a scope may see: a venue's own, the owner's (no venue), and, for the owner, any a venue's staff or a moderator escalated
 * (ADR 0049). A report in a youth thread that names the viewer (or the same person's staff login) is never among them.
 */
function reportScope(scope: Scope, alias: string, admin: Admin): { sql: string; args: (string | number)[] } {
  const base = scopeSql(scope, `${alias}.venue_id`);
  const names = namesTheViewerSql(alias, admin);
  // The owner is asked to review an automatic suspension, so the owner reads the reports behind it, a venue's too, for as long as it is in force (ADR 0059): not a youth
  // thread's, which are cases of their own (ADR 0049).
  const behindOne = `${alias}.urgent = 0 AND EXISTS (SELECT 1 FROM player_message_suspensions bs WHERE bs.source = 'automatic' AND bs.lifted_at IS NULL AND bs.venue_id IS NULL
                       AND bs.user_id = ${alias}.reported_id AND ${alias}.created_at >= datetime(bs.created_at, '-${LIMITS.autoSuspendDays} days'))`;
  const visible = scope.owner ? `(${base.sql} OR ${alias}.escalated_at IS NOT NULL OR (${behindOne}))` : base.sql;
  return { sql: `${visible} AND NOT ${names.sql}`, args: [...base.args, ...names.args] };
}

export type Refused = { ok: false; error: string; status: number };
const no = (error: string, status = 400): Refused => ({ ok: false, error, status });

const parseLabel = (raw: string | null): SeatLabel | null => {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as SeatLabel;
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
};

export interface ReportLine {
  id: number;
  from: SeatLabel | null;
  body: string | null;
  at: string;
  flagged: boolean;
}

export interface MessageReportOut {
  id: number;
  createdAt: string;
  status: "open" | "reviewed";
  outcome: "no_action" | "action_taken" | null;
  reason: string;
  note: string | null;
  kind: string;
  contextId: number;
  venueId: number | null;
  threadId: number | null;
  threadState: "open" | "muted" | "closed" | null;
  /** In a supervised youth group's thread: told at once, a longer copy, the reported person muted until it is reviewed. */
  urgent: boolean;
  /** An urgent report's copy is held back: it is read one report at a time, each reading recorded (lib/youth-report-cases.ts `caseView`). */
  linesHeld: boolean;
  /** Escalated to the platform's owner (by a moderator, or because the person reported is staff at the venue). */
  escalated: boolean;
  /** A protective restriction (a hold, not a finding) is in force on the reported person's seat. */
  restricted: boolean;
  reporter: SeatLabel | null;
  /** The reported person: their account number (to suspend them), how they showed, whether their messaging is stopped here, and how many different people have reported them in the window. */
  reported: { userId: number | null; label: SeatLabel | null; suspended: boolean; reporters: number } | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  lines: ReportLine[];
}

/** Reports in this scope, open first, newest first, a page at a time. */
export async function listMessageReports(admin: Admin, filter: { status?: "open" | "reviewed"; before?: number; limit?: number } = {}): Promise<MessageReportOut[]> {
  const scope = reportScope(scopeOf(admin), "r", admin);
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  const db = getDb();
  const rows = (await db
    .prepare(
      `SELECT r.id, r.created_at, r.status, r.outcome, r.reason, r.note, r.context_kind, r.context_id, r.venue_id, r.thread_id, t.staff_state, r.urgent,
              r.reporter_label, r.reported_label, r.reported_id, r.reviewed_by_name, r.reviewed_at, (r.escalated_at IS NOT NULL) AS escalated,
              EXISTS (SELECT 1 FROM youth_thread_mutes ym WHERE ym.report_id = r.id AND ym.lifted_at IS NULL) AS restricted,
              EXISTS (SELECT 1 FROM player_message_suspensions s WHERE s.user_id = r.reported_id AND s.lifted_at IS NULL AND (s.venue_id IS NULL OR s.venue_id IS NOT DISTINCT FROM r.venue_id)) AS suspended,
              (SELECT COUNT(DISTINCT x.reporter_id)::int FROM player_message_reports x WHERE x.reported_id = r.reported_id AND x.created_at >= ?) AS reporters
         FROM player_message_reports r LEFT JOIN player_message_threads t ON t.id = r.thread_id
        WHERE ${scope.sql} AND (?::text IS NULL OR r.status = ?) AND (?::int IS NULL OR r.id < ?)
        ORDER BY (r.status = 'open') DESC, r.id DESC LIMIT ?`
    )
    .all(
      new Date(Date.now() - LIMITS.autoSuspendDays * 86_400_000).toISOString().slice(0, 19).replace("T", " "),
      ...scope.args,
      filter.status ?? null,
      filter.status ?? null,
      filter.before ?? null,
      filter.before ?? null,
      limit
    )) as {
    id: number; created_at: string; status: "open" | "reviewed"; outcome: "no_action" | "action_taken" | null; reason: string; note: string | null; context_kind: ContextKind;
    context_id: number; venue_id: number | null; thread_id: number | null; staff_state: "open" | "muted" | "closed" | null; reporter_label: string | null; reported_label: string | null;
    reported_id: number | null; reviewed_by_name: string | null; reviewed_at: string | null; suspended: boolean; reporters: number; urgent: number; escalated: boolean; restricted: boolean;
  }[];
  const out: MessageReportOut[] = [];
  for (const r of rows) {
    // The copy of a report in a youth thread is evidence: not in a list, read one report at a time with each reading recorded (youth-report-cases.ts).
    const lines = r.urgent === 1 ? [] : (await db
      .prepare("SELECT id, sender_label, body, sent_at, flagged FROM player_message_report_lines WHERE report_id = ? ORDER BY id")
      .all(r.id)) as { id: number; sender_label: string | null; body: string | null; sent_at: string; flagged: number }[];
    out.push({
      id: r.id,
      createdAt: r.created_at,
      status: r.status,
      outcome: r.outcome,
      reason: r.reason,
      note: r.note,
      kind: kindInUrl(r.context_kind),
      contextId: r.context_id,
      venueId: r.venue_id,
      threadId: r.thread_id,
      threadState: r.staff_state,
      urgent: r.urgent === 1,
      linesHeld: r.urgent === 1,
      escalated: r.escalated,
      restricted: r.restricted,
      reporter: parseLabel(r.reporter_label),
      reported: r.reported_id === null ? null : { userId: r.reported_id, label: parseLabel(r.reported_label), suspended: r.suspended, reporters: r.reporters },
      reviewedBy: r.reviewed_by_name,
      reviewedAt: r.reviewed_at,
      lines: lines.map((l) => ({ id: l.id, from: parseLabel(l.sender_label), body: l.body, at: l.sent_at, flagged: l.flagged === 1 })),
    });
  }
  return out;
}

/**
 * Mark a report dealt with. Not found for one outside this scope, for one already reviewed, and for one in a youth thread that names this staff
 * member. A report in a youth thread has a third outcome, `restriction_continues` (it is dealt with and the protective restriction stays in force
 * until it is lifted), and its review is recorded in the case's own audit, not in the staff activity log (ADR 0049).
 */
export async function reviewMessageReport(admin: Admin, id: number, outcome: unknown): Promise<{ ok: true } | Refused> {
  if (outcome !== "no_action" && outcome !== "action_taken" && outcome !== "restriction_continues") return no("Say whether anything was needed.");
  const scope = reportScope(scopeOf(admin), "r", admin);
  const done = await getDb()
    .prepare(
      `UPDATE player_message_reports r SET status = 'reviewed', outcome = ?, reviewed_at = datetime('now'), reviewed_by_name = ?
        WHERE r.id = ? AND r.status = 'open' AND (r.urgent = 1 OR ?::text <> 'restriction_continues') AND ${scope.sql} RETURNING r.venue_id, r.urgent, r.context_id, r.reported_id`
    )
    .get(outcome, admin.name, id, outcome, ...scope.args) as { venue_id: number | null; urgent: number; context_id: number; reported_id: number | null } | undefined;
  if (!done) return no("That report is not here, or it has been dealt with.", 404);
  // A person a report muted in a supervised youth group's thread is paused only until the report is reviewed: nothing needed lifts it.
  if (outcome === "no_action")
    await getDb().prepare("UPDATE youth_thread_mutes SET lifted_at = datetime('now'), lifted_by = ? WHERE report_id = ? AND lifted_at IS NULL").run(admin.name, id);
  if (done.urgent === 1) await (await import("./youth-report-cases")).caseAudit(id, done.context_id, admin.name, "reviewed", outcome);
  else await logAction(admin, { venueId: done.venue_id, action: "messages.report_reviewed", detail: `Report ${id}: ${outcome === "no_action" ? "nothing needed" : "action taken"}` });
  // An automatic suspension rests on the reports counted: with this one found to need no action, fewer than the rule's number may be left (ADR 0059).
  if (outcome === "no_action" && done.reported_id !== null) await recheckAutomaticSuspension(done.reported_id, admin, done.venue_id);
  return { ok: true };
}

/**
 * The published rule counts reports found to need no action out: an automatic suspension is **lifted** when fewer than the rule's number of different
 * people's reports are left to count, and does not outlive the reports it rests on. Run whenever a report is found to need no action. The lift records who
 * dismissed the report and why (activity log `messages.suspension_lifted`); an open request for a review of it is answered *lifted*. A suspension the owner
 * confirmed (a decision of their own) is not touched.
 */
export async function recheckAutomaticSuspension(userId: number, by: Pick<Admin, "name"> & { id: number | null }, venueId: number | null): Promise<boolean> {
  if ((await countedReporters(userId)) >= LIMITS.autoSuspendReporters) return false;
  const reason = "The reports it rested on were found to need no action.";
  const lifted = (await getDb()
    .prepare(
      `UPDATE player_message_suspensions SET lifted_at = datetime('now'), lifted_by_name = ?, lift_reason = ?
        WHERE user_id = ? AND source = 'automatic' AND venue_id IS NULL AND lifted_at IS NULL RETURNING id`
    )
    .all(by.name, reason, userId)) as { id: number }[];
  for (const l of lifted) {
    await answerReview(l.id, "lifted", by.name, reason);
    await logAction(by, { venueId, action: "messages.suspension_lifted", detail: `Person ${userId}. ${reason}` });
  }
  return lifted.length > 0;
}

/** An open request for a review of this suspension is answered, in neutral words (`lifted` or `continues`); nothing of any report is kept in it. */
async function answerReview(suspensionId: number, outcome: "lifted" | "continues", by: string, reason: string): Promise<void> {
  await getDb()
    .prepare(
      `UPDATE player_message_suspension_appeals SET status = 'decided', outcome = ?, decided_by_name = ?, decision_reason = ?, decided_at = datetime('now')
        WHERE suspension_id = ? AND status = 'open'`
    )
    .run(outcome, by, reason, suspensionId);
}

const reasonOf = (raw: unknown): string | null => (typeof raw === "string" && raw.trim().length >= 3 ? raw.trim().replace(/\s+/g, " ").slice(0, 300) : null);

/** Mute a thread (nobody may write; a manager can undo it), close it for good, or open a muted one again. A reason is kept with each. */
export async function setThreadState(admin: Admin, threadId: number, state: unknown, reasonRaw: unknown): Promise<{ ok: true; state: "open" | "muted" | "closed" } | Refused> {
  if (state !== "open" && state !== "muted" && state !== "closed") return no("Choose open, muted or closed.");
  const reason = reasonOf(reasonRaw);
  if (!reason) return no("Say why, in a few words.");
  const scope = scopeOf(admin);
  const closed: { group: number | null } = { group: null };
  const result = await withTransaction(async (): Promise<{ ok: true; state: "open" | "muted" | "closed" } | Refused> => {
    closed.group = null;
    const db = getDb();
    const t = (await db.prepare("SELECT id, venue_id, staff_state, youth, context_id FROM player_message_threads WHERE id = ? FOR UPDATE").get(threadId)) as
      | { id: number; venue_id: number | null; staff_state: "open" | "muted" | "closed"; youth: number; context_id: number }
      | undefined;
    if (!t || !inScope(scope, t.venue_id)) return no("That conversation is not here.", 404);
    // A member of staff a report names has no say over the conversation it was made in (ADR 0049).
    if (t.youth === 1 && (await adminIsAccusedIn(admin, t.context_id))) return no("That conversation is not here.", 404);
    if (t.staff_state === "closed") return no("A conversation closed by staff cannot be opened again.", 409);
    await db
      .prepare("UPDATE player_message_threads SET staff_state = ?, staff_reason = ?, staff_admin_name = ?, staff_at = datetime('now') WHERE id = ?")
      .run(state, reason, admin.name, threadId);
    await logAction(admin, { venueId: t.venue_id, action: "messages.thread_state", detail: `Conversation ${threadId}: ${state}. ${reason}` });
    if (t.youth === 1 && state === "closed") closed.group = t.context_id;
    return { ok: true as const, state };
  });
  // Urgent: a youth group's conversation closed is told at once to its supervisors and the minors' guardians (lib/youth-safeguarding.ts).
  if (result.ok && closed.group !== null) await (await import("./youth-safeguarding")).tellThreadClosed(closed.group).catch(() => undefined);
  return result;
}

export interface SuspensionOut {
  id: number;
  userId: number;
  /** How they show, for a suspension a report named; their first name otherwise. */
  who: string;
  source: "staff" | "automatic";
  venueId: number | null;
  reason: string;
  adminName: string | null;
  createdAt: string;
  /** An automatic one still awaiting the owner's review. */
  pendingReview: boolean;
  /** The date an automatic one is to be reviewed by (operational, not a legal period), and whether it has passed: nothing lifts by itself. */
  reviewBy: string | null;
  overdue: boolean;
  /** The reports behind an automatic one that this reader may read, by number. */
  reportIds: number[];
  /** The suspended person asked for a review, and has not been answered: their words (never what any report said) and when. */
  reviewRequested: { id: number; text: string | null; at: string } | null;
}

/**
 * The reports an automatic suspension rests on: about the same person, within the rule's window before it was made, none found to need no action. `s` is the
 * suspension's alias, `r` the report's.
 */
const BEHIND = (s: string, r: string) =>
  `${r}.reported_id = ${s}.user_id AND ${r}.created_at >= datetime(${s}.created_at, '-${LIMITS.autoSuspendDays} days') AND (${r}.outcome IS NULL OR ${r}.outcome <> 'no_action')`;

/**
 * An automatic suspension a venue's manager may deal with: every report behind it is one of theirs (its venue's), and at least one is. A suspension is platform-wide
 * (`venue_id` null), so one that rests on another venue's reports, or on a conversation with no venue, is the owner's alone (ADR 0059).
 */
function managedAutomatic(scope: Scope, alias: string): { sql: string; args: number[] } {
  if (scope.owner || scope.venueIds.length === 0) return { sql: "FALSE", args: [] };
  const marks = scope.venueIds.map(() => "?").join(",");
  return {
    sql: `(${alias}.source = 'automatic' AND ${alias}.venue_id IS NULL
            AND EXISTS (SELECT 1 FROM player_message_reports mr WHERE ${BEHIND(alias, "mr")} AND mr.venue_id IN (${marks}))
            AND NOT EXISTS (SELECT 1 FROM player_message_reports xr WHERE ${BEHIND(alias, "xr")} AND (xr.venue_id IS NULL OR xr.venue_id NOT IN (${marks}))))`,
    args: [...scope.venueIds, ...scope.venueIds],
  };
}

/** SQL for the suspensions this scope may see and lift: a venue's own, the owner's platform-wide ones, and, for a manager, an automatic one resting on that venue's reports alone. */
function suspensionScope(scope: Scope, alias: string): { sql: string; args: number[] } {
  const base = scopeSql(scope, `${alias}.venue_id`);
  const auto = managedAutomatic(scope, alias);
  return { sql: `(${base.sql} OR ${auto.sql})`, args: [...base.args, ...auto.args] };
}

/** Suspensions in force in this scope. */
export async function listSuspensions(admin: Admin): Promise<SuspensionOut[]> {
  const scope = suspensionScope(scopeOf(admin), "s");
  const names = namesTheViewerSql("sr", admin);
  const rows = (await getDb()
    .prepare(
      `SELECT s.id, s.user_id, split_part(u.name, ' ', 1) AS first_name, s.source, s.venue_id, s.reason, s.admin_name, s.created_at,
              COALESCE(s.review_by, datetime(s.created_at, '+${LIMITS.autoSuspendReviewDays} days')) AS review_by,
              (SELECT a.id FROM player_message_suspension_appeals a WHERE a.suspension_id = s.id AND a.status = 'open') AS appeal_id,
              (SELECT a.message FROM player_message_suspension_appeals a WHERE a.suspension_id = s.id AND a.status = 'open') AS appeal_text,
              (SELECT a.created_at FROM player_message_suspension_appeals a WHERE a.suspension_id = s.id AND a.status = 'open') AS appeal_at
         FROM player_message_suspensions s JOIN users u ON u.id = s.user_id
        WHERE s.lifted_at IS NULL AND ${scope.sql}
          AND NOT EXISTS (SELECT 1 FROM player_message_reports sr WHERE sr.id = s.report_id AND ${names.sql})
        ORDER BY s.id DESC LIMIT 200`
    )
    .all(...scope.args, ...names.args)) as {
    id: number; user_id: number; first_name: string; source: "staff" | "automatic"; venue_id: number | null; reason: string; admin_name: string | null; created_at: string; review_by: string;
    appeal_id: number | null; appeal_text: string | null; appeal_at: string | null;
  }[];
  const reader = reportScope(scopeOf(admin), "r", admin);
  const out: SuspensionOut[] = [];
  for (const r of rows) {
    const reportIds =
      r.source === "automatic"
        ? (((await getDb()
            .prepare(
              `SELECT r.id FROM player_message_reports r JOIN player_message_suspensions s ON s.id = ?
                WHERE ${BEHIND("s", "r")} AND ${reader.sql} ORDER BY r.id`
            )
            .all(r.id, ...reader.args)) as { id: number }[]).map((x) => x.id))
        : [];
    out.push({
      id: r.id,
      userId: r.user_id,
      who: r.first_name,
      source: r.source,
      venueId: r.venue_id,
      reason: r.reason,
      adminName: r.admin_name,
      createdAt: r.created_at,
      pendingReview: r.source === "automatic",
      reviewBy: r.source === "automatic" ? r.review_by : null,
      overdue: r.source === "automatic" && r.review_by.slice(0, 19) < new Date().toISOString().slice(0, 19).replace("T", " "),
      reportIds,
      reviewRequested: r.appeal_id !== null ? { id: r.appeal_id, text: r.appeal_text, at: r.appeal_at ?? "" } : null,
    });
  }
  return out;
}

/**
 * Suspend somebody's messaging. A venue's staff do it for their venue's contexts only, and only with a report in their scope about that
 * person (so an account number is never enough to act on a stranger); the platform owner does it everywhere, naming the person by a
 * report in theirs or, for a person who has messaged nobody a venue knows, by account number.
 */
export async function suspendMessaging(admin: Admin, input: { userId: unknown; reason: unknown; reportId?: unknown }): Promise<{ ok: true; id: number } | Refused> {
  if (!Number.isInteger(input.userId)) return no("Whose messages?");
  const userId = input.userId as number;
  const reason = reasonOf(input.reason);
  if (!reason) return no("Say why, in a few words.");
  const scope = scopeOf(admin);
  const done = await withTransaction(async () => {
    const db = getDb();
    let venueId: number | null = null;
    let reportId: number | null = null;
    let aboutYouthReport = false;
    if (Number.isInteger(input.reportId)) {
      const r = (await db.prepare("SELECT id, venue_id, reported_id, urgent, escalated_at FROM player_message_reports WHERE id = ?").get(input.reportId)) as
        | { id: number; venue_id: number | null; reported_id: number | null; urgent: number; escalated_at: string | null }
        | undefined;
      if (!r || !(inScope(scope, r.venue_id) || (scope.owner && r.escalated_at !== null)) || r.reported_id !== userId) return no("That report is not here.", 404);
      if (r.urgent === 1 && (await adminIsUser(admin, r.reported_id))) return no("That report is not here.", 404);
      reportId = r.id;
      venueId = r.venue_id;
      aboutYouthReport = r.urgent === 1;
    } else if (!scope.owner) return no("Name the report this is about.");
    // A venue's staff can stop somebody in their venue's contexts only; the owner, everywhere.
    if (scope.owner) venueId = null;
    const user = await db.prepare("SELECT id FROM users WHERE id = ?").get(userId);
    if (!user) return no("That person is not here.", 404);
    const made = (await db
      .prepare(
        `INSERT INTO player_message_suspensions (user_id, source, venue_id, reason, admin_name, report_id) VALUES (?, 'staff', ?, ?, ?, ?)
         ON CONFLICT DO NOTHING RETURNING id`
      )
      .get(userId, venueId, reason, admin.name, reportId)) as { id: number } | undefined;
    if (!made) return no("Their messages are already paused here.", 409);
    await logAction(admin, { venueId, action: "messages.suspended", detail: `Person ${userId}${reportId ? `, report ${reportId}` : ""}. ${reason}` });
    return { ok: true as const, id: made.id, aboutYouthReport };
  });
  // The person is told their messaging is paused, and a minor's guardians too; but never, by this, of a report in a youth thread, which an adult is told
  // only in words a moderator writes (ADR 0049).
  if (done.ok && !(done.aboutYouthReport && (await declaredAdult(userId)) === true)) await (await import("./youth-safeguarding")).tellSuspended(userId).catch(() => undefined);
  return done.ok ? { ok: true, id: done.id } : done;
}

/**
 * Lift a suspension, with a reason. A venue lifts its own, and an automatic one that rests on its own reports alone; the owner lifts platform-wide ones, the
 * automatic ones included (ADR 0059). An open request for a review of it is answered *lifted*.
 */
export async function liftSuspension(admin: Admin, id: number, reasonRaw: unknown): Promise<{ ok: true } | Refused> {
  const reason = reasonOf(reasonRaw);
  if (!reason) return no("Say why, in a few words.");
  const scope = suspensionScope(scopeOf(admin), "s");
  // A suspension a report in a youth thread brought about, about the same person as this staff login, is not theirs to lift: it is not here for them, as the
  // report is not (ADR 0049's conflict-of-interest guard; found in the review of ADR 0052).
  const names = namesTheViewerSql("sr", admin);
  const done = (await getDb()
    .prepare(
      `UPDATE player_message_suspensions s SET lifted_at = datetime('now'), lifted_by_name = ?, lift_reason = ?
        WHERE s.id = ? AND s.lifted_at IS NULL AND ${scope.sql}
          AND NOT EXISTS (SELECT 1 FROM player_message_reports sr WHERE sr.id = s.report_id AND ${names.sql})
        RETURNING s.venue_id, s.user_id, (SELECT x.venue_id FROM player_message_reports x WHERE x.id = s.report_id) AS report_venue`
    )
    .get(admin.name, reason, id, ...scope.args, ...names.args)) as { venue_id: number | null; user_id: number; report_venue: number | null } | undefined;
  if (!done) return no("That suspension is not here, or it has been lifted.", 404);
  await answerReview(id, "lifted", admin.name, reason);
  await logAction(admin, { venueId: done.venue_id ?? done.report_venue, action: "messages.suspension_lifted", detail: `Person ${done.user_id}. ${reason}` });
  return { ok: true };
}

/**
 * The answer to a request for a review, when the suspension stands: *continues*, with a reason, by somebody who did not apply it (a suspension the
 * owner confirmed, or a manager made, is not decided again by the same login). Only where there is a request to answer; lifting is the other answer.
 */
export async function keepSuspension(admin: Admin, id: number, reasonRaw: unknown): Promise<{ ok: true } | Refused> {
  const reason = reasonOf(reasonRaw);
  if (!reason) return no("Say why, in a few words.");
  const scope = suspensionScope(scopeOf(admin), "s");
  const names = namesTheViewerSql("sr", admin);
  const row = (await getDb()
    .prepare(
      `SELECT s.venue_id, s.user_id, s.admin_name, (SELECT x.venue_id FROM player_message_reports x WHERE x.id = s.report_id) AS report_venue FROM player_message_suspensions s
        WHERE s.id = ? AND s.lifted_at IS NULL AND ${scope.sql}
          AND EXISTS (SELECT 1 FROM player_message_suspension_appeals a WHERE a.suspension_id = s.id AND a.status = 'open')
          AND NOT EXISTS (SELECT 1 FROM player_message_reports sr WHERE sr.id = s.report_id AND ${names.sql})`
    )
    .get(id, ...scope.args, ...names.args)) as { venue_id: number | null; user_id: number; admin_name: string | null; report_venue: number | null } | undefined;
  if (!row) return no("That suspension is not here, or nobody has asked for a review of it.", 404);
  if (row.admin_name && row.admin_name.toLowerCase() === admin.name.toLowerCase()) return no("Somebody who did not apply it answers a request for a review.", 409);
  await answerReview(id, "continues", admin.name, reason);
  await logAction(admin, { venueId: row.venue_id ?? row.report_venue, action: "messages.suspension_reviewed", detail: `Person ${row.user_id}: it stands. ${reason}` });
  return { ok: true };
}

/** The owner's review of an automatic suspension, when it is to stand: it becomes a staff decision, with the owner's reason added. (Lifting it is the other answer.) */
export async function confirmSuspension(admin: Admin, id: number, reasonRaw: unknown): Promise<{ ok: true } | Refused> {
  const reason = reasonOf(reasonRaw);
  if (!reason) return no("Say why, in a few words.");
  if (!scopeOf(admin).owner) return no("That suspension is not waiting for review.", 404);
  const done = (await getDb()
    .prepare(
      `UPDATE player_message_suspensions SET source = 'staff', admin_name = ?, reason = reason || ' (confirmed: ' || ? || ')'
        WHERE id = ? AND lifted_at IS NULL AND source = 'automatic' AND venue_id IS NULL RETURNING user_id`
    )
    .get(admin.name, reason, id)) as { user_id: number } | undefined;
  if (!done) return no("That suspension is not waiting for review.", 404);
  await logAction(admin, { venueId: null, action: "messages.suspension_confirmed", detail: `Person ${done.user_id}. ${reason}` });
  return { ok: true };
}

export interface ModerationAttention {
  /** Reports open now in this reader's scope (a youth thread's are the safeguarding lines): how many, and since when the oldest. */
  openReports: number;
  oldestOpenReport: string | null;
  /** How many whole days the oldest has been open. */
  waitingDays: number;
  /** Automatic suspensions to review, with their review date; and requests for a review of any suspension waiting for an answer. */
  suspensionsToReview: { id: number; since: string; reviewBy: string; overdue: boolean }[];
  reviewRequests: number;
}

/**
 * The needs-attention lines for reports of messages and suspensions (ADR 0059), for a manager or the owner: nothing about a person, a message or a report beyond
 * a count, an age and a number. Derived from what is open, so dismissing a report or lifting a suspension clears it.
 */
export async function moderationAttention(admin: Admin): Promise<ModerationAttention> {
  const scope = reportScope(scopeOf(admin), "r", admin);
  const open = (await getDb()
    .prepare(`SELECT COUNT(*)::int AS n, MIN(r.created_at) AS oldest FROM player_message_reports r WHERE r.status = 'open' AND r.urgent = 0 AND ${scope.sql}`)
    .get(...scope.args)) as { n: number; oldest: string | null };
  const suspensions = await listSuspensions(admin);
  const oldest = open.oldest ? Date.parse(`${open.oldest.replace(" ", "T")}Z`) : null;
  return {
    openReports: open.n,
    oldestOpenReport: open.oldest,
    waitingDays: oldest === null ? 0 : Math.floor((Date.now() - oldest) / 86_400_000),
    suspensionsToReview: suspensions.filter((x) => x.pendingReview).map((x) => ({ id: x.id, since: x.createdAt, reviewBy: x.reviewBy ?? "", overdue: x.overdue })),
    reviewRequests: suspensions.filter((x) => x.reviewRequested !== null).length,
  };
}
