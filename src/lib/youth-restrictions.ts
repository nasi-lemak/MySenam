import { getDb, withTransaction } from "./db";
import { isOwner, type Admin } from "./admin-auth";
import { inScope, scopeOf } from "./message-moderation";
import { baseUrl, emailPlayer } from "./outbox";
import { declaredAdult } from "./player-profiles";
import { adminIsAccusedIn, adminIsUser, namesTheViewerSql, staffEmailsOf } from "./safeguarding-conflict";
import { siteName } from "./site";
import { staffSentences, tellOwnersEach, tellVenueStaffEach } from "./owner-alerts";
import { consentEvent } from "./youth-consent";
import { protectiveReviewDays, safeguardingReviewMonths } from "./youth-launch";
import { refuseYouth, youthGroupOf, youthOff, type YouthRefusal } from "./youth-messages";
import { caseAudit, givesAwayReport } from "./youth-report-cases";
import { safeguardingReviewDue } from "./youth-evidence";

/**
 * A restriction on an adult in a youth group's conversation: temporary protection or a decision, reviewed, never indefinite, and open to a request for a
 * review that does not reveal why (docs/features/player-messages.md#a-restriction-on-an-adult-is-protective-or-a-decision; ADR 0052, which amends ADR 0049).
 *
 * - **Protective** (the default, placed by a report at once: temporary and **not a finding**) or **a decision** (a moderator's recorded outcome with its
 *   reason). Nothing anywhere presents an allegation as proven.
 * - **No indefinite unreviewed restriction.** A protective restriction has a date to be reviewed by (`YOUTH_PROTECTIVE_REVIEW_DAYS`, operational, **not a
 *   legal period**). Passing it unreviewed **escalates to the platform's owner** (a needs-attention line and a safeguarding email, repeated at the review
 *   interval) and **never lifts or converts the restriction by itself**. A moderator's review (continue with a reason, lift with a reason, or convert to a
 *   decision: lib/youth-report-cases.ts) starts it again.
 * - **A request for a review** (`askForReview`) from the neutral line, the same for every cause: one short text; nothing of any report is shown or asked. It
 *   is decided by somebody other than whoever applied the restriction (a different manager of the venue, else the platform's owner), with a reason, recorded;
 *   the adult is told only that it was received and, when decided, the outcome in neutral words. **No legal right to a review or to notification is promised:
 *   rights to review and notification are pending legal review.**
 */

const clean = (raw: unknown, max: number): string => (typeof raw === "string" ? raw.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim().replace(/\s+/g, " ").slice(0, max) : "");

type Result<T = object> = ({ ok: true } & T) | YouthRefusal;

// ------------------------------------------------------------------ the restricted adult asks

/**
 * An adult whose access to a youth group's conversation is restricted (for any cause: the answer does not depend on which) asks for it to be looked at again:
 * one short text, optional. Refused as if the group were not theirs for anybody who is not restricted there (a stranger's answer), and once only while a request
 * is open. Rate-limited by the route. Nothing of any report is shown, asked or confirmed.
 */
export async function askForReview(userId: number, groupId: number, textRaw: unknown): Promise<Result<{ state: "received" }>> {
  { const off = youthOff(); if (off) return off; }
  if ((await declaredAdult(userId)) !== true) return refuseYouth("YG_NOT_FOUND");
  const text = clean(textRaw, 300);
  const made = await withTransaction(async (): Promise<{ id: number; reportId: number | null } | YouthRefusal> => {
    const db = getDb();
    const mute = (await db
      .prepare("SELECT id, report_id FROM youth_thread_mutes WHERE group_id = ? AND user_id = ? AND lifted_at IS NULL FOR UPDATE")
      .get(groupId, userId)) as { id: number; report_id: number | null } | undefined;
    if (!mute) return refuseYouth("YG_NOT_FOUND");
    const row = (await db
      .prepare("INSERT INTO youth_restriction_appeals (mute_id, group_id, user_id, message) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING id")
      .get(mute.id, groupId, userId, text || null)) as { id: number } | undefined;
    if (!row) return refuseYouth("YG_APPEAL_DUP");
    await consentEvent(groupId, "system", "review_requested", { actorId: userId, detail: `request ${row.id}` });
    if (mute.report_id !== null) await caseAudit(mute.report_id, groupId, "the restricted person", "review_requested", `request ${row.id}`);
    return { id: row.id, reportId: mute.report_id };
  });
  if ("ok" in made) return made;
  // The people who may decide it are told one is waiting (counts and place only: nothing of why).
  try {
    const group = (await getDb().prepare("SELECT name FROM community_groups WHERE id = ?").get(groupId)) as { name: string } | undefined;
    const y = await youthGroupOf(groupId);
    const write = (t: Parameters<Parameters<typeof tellOwnersEach>[0]>[0]) => ({
      subject: t("msg4.mail.appealSubject", { group: group?.name ?? "" }),
      body: staffSentences(t, t("msg4.mail.appealBody", { group: group?.name ?? "", id: made.id })),
    });
    const opts = { exceptEmails: await staffEmailsOf(userId), kind: "safeguarding_notice" as const };
    if (!y || y.venueId === null) await tellOwnersEach(write, opts);
    else await tellVenueStaffEach(y.venueId, write, { ...opts, managersOnly: true });
  } catch (err) {
    console.error("[mysenam] could not queue a safeguarding notice:", err instanceof Error ? err.message : "unknown error");
  }
  return { ok: true, state: "received" };
}

export interface MyReviewState {
  state: "none" | "received" | "decided";
  /** The outcome of the latest decided request, in neutral words; never why. */
  outcome: "lifted" | "continues" | null;
  /** What the moderator chose to add, if anything (never naming who reported or repeating what was reported). */
  text: string | null;
}

/** What this person's latest request for a review of a restriction in this group stands at: only what they asked and what was decided. */
export async function myReviewState(userId: number, groupId: number): Promise<MyReviewState> {
  const r = (await getDb()
    .prepare("SELECT status, outcome, decision_text FROM youth_restriction_appeals WHERE user_id = ? AND group_id = ? ORDER BY id DESC LIMIT 1")
    .get(userId, groupId)) as { status: "open" | "decided"; outcome: "lifted" | "continues" | null; decision_text: string | null } | undefined;
  if (!r) return { state: "none", outcome: null, text: null };
  return r.status === "open" ? { state: "received", outcome: null, text: null } : { state: "decided", outcome: r.outcome, text: r.decision_text };
}

// ------------------------------------------------------------------ what a reviewer sees and decides

export interface AppealItem {
  id: number;
  groupId: number;
  groupName: string;
  createdAt: string;
  /** What kind of restriction it is and since when: a report's protective restriction, a moderator's decision, or a supervisor's pause. Never why. */
  restriction: { kind: "protective" | "decision" | "supervisor"; since: string };
  /** The restricted person, by their first name. */
  person: string;
  /** What they wrote (up to 300 characters). */
  message: string | null;
  /** The case this restriction belongs to, for a reviewer who may open it. */
  reportId: number | null;
}

interface AppealRow {
  id: number;
  mute_id: number;
  group_id: number;
  user_id: number;
  message: string | null;
  created_at: string;
  group_name: string;
  person: string;
  mute_kind: "protective" | "decision";
  mute_source: "supervisor" | "report";
  mute_created_at: string;
  muted_by: string | null;
  decided_by_mute: string | null;
  report_id: number | null;
}

const firstName = (name: string): string => name.trim().split(/\s+/)[0] ?? name;

/** Everybody who applied, extended, confirmed or decided this restriction, by the names the record keeps: none of them reviews a request about it. */
async function appliersOf(row: Pick<AppealRow, "muted_by" | "decided_by_mute" | "report_id">): Promise<Set<string>> {
  const names = new Set<string>();
  for (const n of [row.muted_by, row.decided_by_mute]) if (n) names.add(n.toLowerCase());
  if (row.report_id !== null) {
    const rows = (await getDb()
      .prepare("SELECT DISTINCT actor_name FROM youth_report_actions WHERE report_id = ? AND action IN ('restriction_extended', 'restriction_confirmed', 'restriction_decided', 'restriction_lifted')")
      .all(row.report_id)) as { actor_name: string }[];
    for (const r of rows) names.add(r.actor_name.toLowerCase());
  }
  return names;
}

/** The managers of a venue who may be asked to review: its business's managers and its branch's, never front desk. */
async function managersOfVenue(venueId: number): Promise<{ name: string; email: string }[]> {
  return (await getDb()
    .prepare("SELECT a.name, a.email FROM admins a WHERE (a.venue_id = ? AND a.role <> 'desk') OR a.business_id = (SELECT business_id FROM venues WHERE id = ?)")
    .all(venueId, venueId)) as { name: string; email: string }[];
}

const APPEAL_SQL = `SELECT p.id, p.mute_id, p.group_id, p.user_id, p.message, p.created_at, g.name AS group_name, u.name AS person,
         m.kind AS mute_kind, m.source AS mute_source, m.created_at AS mute_created_at, m.muted_by, m.decided_by AS decided_by_mute, m.report_id
    FROM youth_restriction_appeals p JOIN youth_thread_mutes m ON m.id = p.mute_id JOIN community_groups g ON g.id = p.group_id JOIN users u ON u.id = p.user_id`;

/**
 * The request, if it is this staff member's to decide: open; in the group's scope (a manager of the accepted venue, or the platform's owner for a group
 * with none; the owner also where the venue has no manager but the one who applied the restriction, or the person asking); **not whoever applied the
 * restriction, not the person asking (or the same person's staff login), and not a staff member a report in the group names.** Otherwise it is not here.
 */
async function appealFor(admin: Admin, id: number, lock = false): Promise<AppealRow | null> {
  const row = (await getDb().prepare(`${APPEAL_SQL} WHERE p.id = ? AND p.status = 'open'${lock ? " FOR UPDATE OF p" : ""}`).get(id)) as AppealRow | undefined;
  if (!row) return null;
  const y = await youthGroupOf(row.group_id);
  if (!y) return null;
  if ((await adminIsUser(admin, row.user_id)) || (await adminIsAccusedIn(admin, row.group_id))) return null;
  const applied = await appliersOf(row);
  if (applied.has(admin.name.toLowerCase())) return null;
  const scope = scopeOf(admin);
  if (y.venueId === null) return scope.owner ? row : null;
  if (!scope.owner) return inScope(scope, y.venueId) ? row : null;
  // The platform's owner: only where no other manager of the venue could review it.
  const others = (await managersOfVenue(y.venueId)).filter((m) => !applied.has(m.name.toLowerCase()));
  return others.length === 0 ? row : null;
}

/** The open requests for a review that are this staff member's to decide. */
export async function listAppeals(admin: Admin): Promise<AppealItem[]> {
  const ids = (await getDb().prepare("SELECT id FROM youth_restriction_appeals WHERE status = 'open' ORDER BY id").all()) as { id: number }[];
  const out: AppealItem[] = [];
  for (const { id } of ids) {
    const r = await appealFor(admin, id);
    if (!r) continue;
    // A case the reviewer may not open (one that names them, or is not their scope) is not offered.
    let reportId: number | null = null;
    if (r.report_id !== null) {
      const names = namesTheViewerSql("r", admin);
      const ok = await getDb().prepare(`SELECT 1 FROM player_message_reports r WHERE r.id = ? AND NOT ${names.sql}`).get(r.report_id, ...names.args);
      reportId = ok ? r.report_id : null;
    }
    out.push({
      id: r.id, groupId: r.group_id, groupName: r.group_name, createdAt: r.created_at,
      restriction: { kind: r.mute_source === "supervisor" ? "supervisor" : r.mute_kind, since: r.mute_created_at }, person: firstName(r.person), message: r.message, reportId,
    });
  }
  return out;
}

/**
 * Decides a request for a review: **lift** the restriction or let it **continue**, with a reason (kept in the case's own record and the group's, never shown to
 * the adult) and, optionally, a few words for the adult (never naming who reported or repeating what was reported). The adult is told the outcome in neutral
 * words. Not found for a request that is not theirs, including one about a restriction they applied.
 */
export async function decideAppeal(admin: Admin, id: unknown, input: { outcome: unknown; reason: unknown; text?: unknown }): Promise<Result> {
  if (!Number.isInteger(id)) return refuseYouth("YG_REVIEW");
  const reason = clean(input.reason, 300);
  const text = clean(input.text, 600);
  const done = await withTransaction(async (): Promise<Result<{ notify: { userId: number; groupId: number; groupName: string; outcome: "lifted" | "continues"; text: string } }>> => {
    const r = await appealFor(admin, id as number, true);
    if (!r) return refuseYouth("YG_REVIEW");
    if (input.outcome !== "lifted" && input.outcome !== "continues") return refuseYouth("YG_OUTCOME");
    if (reason.length < 3) return refuseYouth("YG_REASON");
    if (text) {
      const reporter = r.report_id === null ? null : ((await getDb().prepare("SELECT reporter_id FROM player_message_reports WHERE id = ?").get(r.report_id)) as { reporter_id: number | null } | undefined)?.reporter_id ?? null;
      if (r.report_id !== null && (await givesAwayReport(r.report_id, reporter, text))) return refuseYouth("YG_APPEAL_TEXT");
    }
    const db = getDb();
    const outcome = input.outcome;
    const closed = await db
      .prepare("UPDATE youth_restriction_appeals SET status = 'decided', outcome = ?, decided_by = ?, decided_at = datetime('now'), decision_reason = ?, decision_text = ? WHERE id = ? AND status = 'open'")
      .run(outcome, admin.name, reason, text || null, r.id);
    if (closed.changes === 0) return refuseYouth("YG_REVIEW");
    if (outcome === "lifted") await db.prepare("UPDATE youth_thread_mutes SET lifted_at = datetime('now'), lifted_by = ? WHERE id = ? AND lifted_at IS NULL").run(admin.name, r.mute_id);
    await consentEvent(r.group_id, "staff", "review_decided", { detail: `request ${r.id}: ${outcome}` });
    if (r.report_id !== null) await caseAudit(r.report_id, r.group_id, admin.name, "review_decided", `request ${r.id}: ${outcome}: ${reason}`);
    return { ok: true as const, notify: { userId: r.user_id, groupId: r.group_id, groupName: r.group_name, outcome, text } };
  });
  if (!done.ok) return done;
  const { notify } = done;
  try {
    await emailPlayer({
      kind: "safeguarding_notice",
      venueId: null,
      userId: notify.userId,
      subject: (t) => t("pmy.mail.subject", { site: siteName() }),
      body: (t) => `${t(notify.outcome === "lifted" ? "msg4.mail.appealLifted" : "msg4.mail.appealContinues", { group: notify.groupName })}${notify.text ? `\n\n${notify.text}` : ""}`,
      link: `${baseUrl()}/messages?open=group:${notify.groupId}`,
      dedupeKey: `msg4:appeal:${id}`,
    });
  } catch (err) {
    console.error("[mysenam] could not queue a safeguarding notice:", err instanceof Error ? err.message : "unknown error");
  }
  return { ok: true };
}

// ------------------------------------------------------------------ never indefinite, never unreviewed

export interface OverdueRestriction {
  reportId: number | null;
  groupId: number;
  groupName: string;
  since: string;
  reviewBy: string;
}

const OVERDUE = (days: number) => `m.source = 'report' AND m.kind = 'protective' AND m.lifted_at IS NULL AND COALESCE(m.review_by, datetime(m.created_at, '+${days} days')) <= datetime('now')`;

/**
 * From the scheduler: a protective restriction past its review date (`YOUTH_PROTECTIVE_REVIEW_DAYS`) with no review is told to the platform's owners by a
 * safeguarding email, and again after each further interval. **It is never lifted, converted or shortened by this.** Recorded in the case and the group's
 * record. Returns how many were told. Safe to repeat: a notice is claimed before it is sent.
 */
export async function restrictionHousekeeping(): Promise<number> {
  const db = getDb();
  const days = protectiveReviewDays();
  const rows = (await db
    .prepare(
      `SELECT m.id, m.group_id, m.user_id, m.report_id, g.name AS group_name FROM youth_thread_mutes m JOIN community_groups g ON g.id = m.group_id
        WHERE ${OVERDUE(days)} AND (m.overdue_notified_at IS NULL OR m.overdue_notified_at <= datetime('now', '-${days} days')) ORDER BY m.id`
    )
    .all()) as { id: number; group_id: number; user_id: number; report_id: number | null; group_name: string }[];
  let told = 0;
  for (const m of rows) {
    const claimed = await db
      .prepare(`UPDATE youth_thread_mutes SET overdue_notified_at = datetime('now') WHERE id = ? AND (overdue_notified_at IS NULL OR overdue_notified_at <= datetime('now', '-${days} days'))`)
      .run(m.id);
    if (claimed.changes === 0) continue;
    told += 1;
    await consentEvent(m.group_id, "system", "restriction_review_overdue", { detail: `restriction ${m.id}` });
    if (m.report_id !== null) await caseAudit(m.report_id, m.group_id, "system", "review_overdue", `restriction ${m.id}`);
    try {
      await tellOwnersEach(
        (t) => ({
          subject: t("msg4.mail.overdueSubject", { group: m.group_name }),
          body: staffSentences(t, t("msg4.mail.overdueBody", { group: m.group_name, id: m.report_id ?? m.id, days })),
        }),
        { exceptEmails: await staffEmailsOf(m.user_id), kind: "safeguarding_notice" }
      );
    } catch (err) {
      console.error("[mysenam] could not queue a safeguarding notice:", err instanceof Error ? err.message : "unknown error");
    }
  }
  return told;
}

/**
 * What the scheduler does for youth messaging each tick (lib/scheduler.ts), safe to repeat: a request for a review whose restriction has since been lifted is
 * closed; protective restrictions past their review date are told to the owners (never lifted); authority reviews open where a guardian link is disputed or
 * unclear or a conflict has waited; and the owners are asked, now and then, to decide about what has been kept longer than the review interval.
 */
export async function youthHousekeeping(): Promise<{ overdue: number; reviews: number; prompted: boolean }> {
  await getDb()
    .prepare(
      `UPDATE youth_restriction_appeals SET status = 'decided', outcome = 'lifted', decided_by = 'system', decided_at = datetime('now'), decision_reason = 'The restriction was lifted.'
        WHERE status = 'open' AND mute_id IN (SELECT id FROM youth_thread_mutes WHERE lifted_at IS NOT NULL)`
    )
    .run();
  const overdue = await restrictionHousekeeping();
  const reviews = await (await import("./youth-authority")).authorityHousekeeping();
  const prompted = await (await import("./youth-evidence")).tellOwnersReviewDue();
  return { overdue, reviews, prompted };
}

export interface SafeguardingAttention {
  /** Protective restrictions past their review date with no review (the owner's: never the person's own). */
  overdue: OverdueRestriction[];
  /** Cases escalated for safeguarding, still open. */
  escalatedCases: { reportId: number; groupId: number; groupName: string; kind: string; at: string }[];
  /** Requests for a review waiting for this staff member to decide. */
  appealsWaiting: number;
  /** Authority reviews that are theirs, open. */
  reviewsOpen: number;
  /** Closed cases and holds kept longer than the interval: the platform's owner is asked to decide, not delete. */
  retention: { cases: number; holds: number; months: number } | null;
}

/** The needs-attention lines of safeguarding, for the dashboard: what the owner must act on, and what a manager has waiting. Nothing about a person beyond a case number. */
export async function safeguardingAttention(admin: Admin): Promise<SafeguardingAttention> {
  const db = getDb();
  const owner = isOwner(admin);
  const out: SafeguardingAttention = { overdue: [], escalatedCases: [], appealsWaiting: 0, reviewsOpen: 0, retention: null };
  if (owner) {
    const names = namesTheViewerSql("r", admin);
    const overdue = (await db
      .prepare(
        `SELECT m.report_id, m.group_id, g.name AS group_name, m.created_at, COALESCE(m.review_by, datetime(m.created_at, '+${protectiveReviewDays()} days')) AS due
           FROM youth_thread_mutes m JOIN community_groups g ON g.id = m.group_id LEFT JOIN player_message_reports r ON r.id = m.report_id
          WHERE ${OVERDUE(protectiveReviewDays())} AND (r.id IS NULL OR NOT ${names.sql}) ORDER BY m.id`
      )
      .all(...names.args)) as { report_id: number | null; group_id: number; group_name: string; created_at: string; due: string }[];
    out.overdue = overdue.map((o) => ({ reportId: o.report_id, groupId: o.group_id, groupName: o.group_name, since: o.created_at, reviewBy: o.due }));
    const esc = (await db
      .prepare(
        `SELECT DISTINCT ON (a.report_id) a.report_id, a.group_id, a.detail, a.created_at, g.name AS group_name FROM youth_report_actions a
           JOIN player_message_reports r ON r.id = a.report_id AND r.status = 'open' JOIN community_groups g ON g.id = a.group_id
          WHERE a.action = 'safeguarding_escalated' AND NOT ${names.sql} ORDER BY a.report_id, a.id DESC`
      )
      .all(...names.args)) as { report_id: number; group_id: number; detail: string | null; created_at: string; group_name: string }[];
    out.escalatedCases = esc.map((e) => ({ reportId: e.report_id, groupId: e.group_id, groupName: e.group_name, kind: (e.detail ?? "").split(": ")[0] || "other", at: e.created_at }));
    const due = await safeguardingReviewDue();
    if (due.cases.length > 0 || due.holds.length > 0) out.retention = { cases: due.cases.length, holds: due.holds.length, months: safeguardingReviewMonths() };
  }
  out.appealsWaiting = (await listAppeals(admin)).length;
  out.reviewsOpen = (await (await import("./youth-authority")).listAuthorityReviews(admin)).length;
  return out;
}
