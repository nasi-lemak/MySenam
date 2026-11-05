import { getDb, withTransaction } from "./db";
import { isOwner, type Admin } from "./admin-auth";
import { logAction } from "./activity";
import { LIMITS } from "./messages";
import { kindInUrl, type ContextKind, type SeatLabel } from "./message-contexts";

/**
 * What a venue's staff and the platform's owner may do about messages between players (docs/features/player-messages.md#moderation;
 * ADR 0039).
 *
 * **Who sees what.** Nobody on staff reads an ordinary message: there is no screen of threads. What staff see is a *report*, with the
 * copy of the thread's last messages frozen with it. A venue's staff see the reports of contexts that belong to their venue (its games,
 * its tournaments, leagues and ladders, its teams); the platform owner sees the reports of contexts with no venue (a community group, a
 * team that plays from no venue) and the platform-wide suspensions, the automatic ones above all. The owner does not read a venue's
 * reports and a venue does not read another's: a context's venue is fixed when its thread begins.
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
  reporter: SeatLabel | null;
  /** The reported person: their account number (to suspend them), how they showed, whether their messaging is stopped here, and how many different people have reported them in the window. */
  reported: { userId: number | null; label: SeatLabel | null; suspended: boolean; reporters: number } | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  lines: ReportLine[];
}

/** Reports in this scope, open first, newest first, a page at a time. */
export async function listMessageReports(admin: Admin, filter: { status?: "open" | "reviewed"; before?: number; limit?: number } = {}): Promise<MessageReportOut[]> {
  const scope = scopeSql(scopeOf(admin), "r.venue_id");
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200);
  const db = getDb();
  const rows = (await db
    .prepare(
      `SELECT r.id, r.created_at, r.status, r.outcome, r.reason, r.note, r.context_kind, r.context_id, r.venue_id, r.thread_id, t.staff_state,
              r.reporter_label, r.reported_label, r.reported_id, r.reviewed_by_name, r.reviewed_at,
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
    reported_id: number | null; reviewed_by_name: string | null; reviewed_at: string | null; suspended: boolean; reporters: number;
  }[];
  const out: MessageReportOut[] = [];
  for (const r of rows) {
    const lines = (await db
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
      reporter: parseLabel(r.reporter_label),
      reported: r.reported_id === null ? null : { userId: r.reported_id, label: parseLabel(r.reported_label), suspended: r.suspended, reporters: r.reporters },
      reviewedBy: r.reviewed_by_name,
      reviewedAt: r.reviewed_at,
      lines: lines.map((l) => ({ id: l.id, from: parseLabel(l.sender_label), body: l.body, at: l.sent_at, flagged: l.flagged === 1 })),
    });
  }
  return out;
}

/** Mark a report dealt with. Not found for one outside this scope, and for one already reviewed. */
export async function reviewMessageReport(admin: Admin, id: number, outcome: unknown): Promise<{ ok: true } | Refused> {
  if (outcome !== "no_action" && outcome !== "action_taken") return no("Say whether anything was needed.");
  const scope = scopeSql(scopeOf(admin), "venue_id");
  const done = await getDb()
    .prepare(
      `UPDATE player_message_reports SET status = 'reviewed', outcome = ?, reviewed_at = datetime('now'), reviewed_by_name = ?
        WHERE id = ? AND status = 'open' AND ${scope.sql} RETURNING venue_id`
    )
    .get(outcome, admin.name, id, ...scope.args) as { venue_id: number | null } | undefined;
  if (!done) return no("That report is not here, or it has been dealt with.", 404);
  await logAction(admin, { venueId: done.venue_id, action: "messages.report_reviewed", detail: `Report ${id}: ${outcome === "no_action" ? "nothing needed" : "action taken"}` });
  return { ok: true };
}

const reasonOf = (raw: unknown): string | null => (typeof raw === "string" && raw.trim().length >= 3 ? raw.trim().replace(/\s+/g, " ").slice(0, 300) : null);

/** Mute a thread (nobody may write; a manager can undo it), close it for good, or open a muted one again. A reason is kept with each. */
export async function setThreadState(admin: Admin, threadId: number, state: unknown, reasonRaw: unknown): Promise<{ ok: true; state: "open" | "muted" | "closed" } | Refused> {
  if (state !== "open" && state !== "muted" && state !== "closed") return no("Choose open, muted or closed.");
  const reason = reasonOf(reasonRaw);
  if (!reason) return no("Say why, in a few words.");
  const scope = scopeOf(admin);
  return withTransaction(async () => {
    const db = getDb();
    const t = (await db.prepare("SELECT id, venue_id, staff_state FROM player_message_threads WHERE id = ? FOR UPDATE").get(threadId)) as
      | { id: number; venue_id: number | null; staff_state: "open" | "muted" | "closed" }
      | undefined;
    if (!t || !inScope(scope, t.venue_id)) return no("That conversation is not here.", 404);
    if (t.staff_state === "closed") return no("A conversation closed by staff cannot be opened again.", 409);
    await db
      .prepare("UPDATE player_message_threads SET staff_state = ?, staff_reason = ?, staff_admin_name = ?, staff_at = datetime('now') WHERE id = ?")
      .run(state, reason, admin.name, threadId);
    await logAction(admin, { venueId: t.venue_id, action: "messages.thread_state", detail: `Conversation ${threadId}: ${state}. ${reason}` });
    return { ok: true as const, state };
  });
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
}

/** Suspensions in force in this scope. */
export async function listSuspensions(admin: Admin): Promise<SuspensionOut[]> {
  const scope = scopeSql(scopeOf(admin), "s.venue_id");
  const rows = (await getDb()
    .prepare(
      `SELECT s.id, s.user_id, split_part(u.name, ' ', 1) AS first_name, s.source, s.venue_id, s.reason, s.admin_name, s.created_at
         FROM player_message_suspensions s JOIN users u ON u.id = s.user_id
        WHERE s.lifted_at IS NULL AND ${scope.sql} ORDER BY s.id DESC LIMIT 200`
    )
    .all(...scope.args)) as { id: number; user_id: number; first_name: string; source: "staff" | "automatic"; venue_id: number | null; reason: string; admin_name: string | null; created_at: string }[];
  return rows.map((r) => ({
    id: r.id,
    userId: r.user_id,
    who: r.first_name,
    source: r.source,
    venueId: r.venue_id,
    reason: r.reason,
    adminName: r.admin_name,
    createdAt: r.created_at,
    pendingReview: r.source === "automatic",
  }));
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
  return withTransaction(async () => {
    const db = getDb();
    let venueId: number | null = null;
    let reportId: number | null = null;
    if (Number.isInteger(input.reportId)) {
      const r = (await db.prepare("SELECT id, venue_id, reported_id FROM player_message_reports WHERE id = ?").get(input.reportId)) as { id: number; venue_id: number | null; reported_id: number | null } | undefined;
      if (!r || !inScope(scope, r.venue_id) || r.reported_id !== userId) return no("That report is not here.", 404);
      reportId = r.id;
      venueId = r.venue_id;
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
    return { ok: true as const, id: made.id };
  });
}

/** Lift a suspension, with a reason. A venue lifts its own; the owner lifts platform-wide ones, the automatic ones included. */
export async function liftSuspension(admin: Admin, id: number, reasonRaw: unknown): Promise<{ ok: true } | Refused> {
  const reason = reasonOf(reasonRaw);
  if (!reason) return no("Say why, in a few words.");
  const scope = scopeSql(scopeOf(admin), "venue_id");
  const done = (await getDb()
    .prepare(
      `UPDATE player_message_suspensions SET lifted_at = datetime('now'), lifted_by_name = ?, lift_reason = ?
        WHERE id = ? AND lifted_at IS NULL AND ${scope.sql} RETURNING venue_id, user_id`
    )
    .get(admin.name, reason, id, ...scope.args)) as { venue_id: number | null; user_id: number } | undefined;
  if (!done) return no("That suspension is not here, or it has been lifted.", 404);
  await logAction(admin, { venueId: done.venue_id, action: "messages.suspension_lifted", detail: `Person ${done.user_id}. ${reason}` });
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
