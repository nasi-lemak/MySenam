import { getDb, withTransaction } from "./db";
import { logAction } from "./activity";
import type { Admin } from "./admin-auth";
import { cutoffFor } from "./message-privacy";
import { scopeOf } from "./message-moderation";
import { shortName } from "./public-names";
import { adminIsAccusedIn, adminIsGuardianOrSupervisor, namesTheViewerSql } from "./safeguarding-conflict";
import { staffSentences, tellOwnersEach } from "./owner-alerts";
import { consentEvent } from "./youth-consent";
import { safeguardingEvidenceRetentionDays, safeguardingReviewMonths } from "./youth-launch";
import { refuseYouth, youthGroupOf, type YouthRefusal } from "./youth-messages";
import { caseAudit } from "./youth-report-cases";
import { ACTIVE_CASE_GROUPS, hasNumberRun, LEGAL_HELD_REPORTS } from "./youth-evidence-sql";

/**
 * Evidence in a supervised youth group: what is held, for how long, and who decides (docs/architecture/privacy.md#youth-messaging-evidence; ADR 0052).
 *
 * Four classes are kept apart. **(a) Ordinary message retention** (the operational defaults `YOUTH_MESSAGE_RETENTION_DAYS` and the rest: pending legal
 * approval). **(b) Safeguarding evidence** (the frozen copy of a report, the case's actions, escalations, review items) and **(c) audit records** (the
 * safeguarding event store, activity entries about youth messaging): **no period is invented for either, and neither is ever deleted automatically.** A
 * deletion period for closed cases applies only if the install sets `SAFEGUARDING_EVIDENCE_RETENTION_DAYS` (which needs legal approval before it is set);
 * unset, the evidence is kept and the platform's owner is prompted to **decide** about what has been kept longer than `SAFEGUARDING_REVIEW_MONTHS`:
 * a decision to keep or to release, never an automatic deletion. **(d) Records under a legal hold** are covered by a hold only the platform's owner sets and
 * releases; legal preservation requirements are pending legal review.
 *
 * Nothing here is legal advice, and no period in it is a legal one.
 */

/** Whether a case is active in this group (a report open or its restriction in force, an authority review or an appeal open, a legal hold): ordinary retention leaves its thread and its case copy alone. */
export async function groupHasActiveCase(groupId: number): Promise<boolean> {
  return Boolean(await getDb().prepare(`SELECT 1 WHERE ?::int IN (${ACTIVE_CASE_GROUPS})`).get(groupId));
}

// ------------------------------------------------------------------ legal holds (the platform's owner only)

const clean = (raw: unknown, min: number, max: number): string | null => (typeof raw === "string" && raw.trim().length >= min ? raw.trim().replace(/\s+/g, " ").slice(0, max) : null);

export interface EvidenceHold {
  id: number;
  scope: "child_group" | "case";
  groupId: number;
  groupName: string | null;
  /** The child by their short name, for a hold on a child and group. */
  child: string | null;
  reportId: number | null;
  reason: string;
  reference: string | null;
  createdBy: string;
  createdAt: string;
  reviewOn: string | null;
  lastReviewedAt: string | null;
  /** The review date has come, or it has been kept longer than the review interval without a review. */
  reviewDue: boolean;
}

/**
 * The platform's owner puts a **legal hold** on a child and group (every youth report of the group and its conversation) or on one case: with a reason, an
 * external reference in words (a short digit-safe text: no case, identity or document number), and an optional review date. While it is in force, retention
 * and erasure leave the covered evidence copy and the conversation alone (an erasure of the person's account is never refused: the held evidence copy stays,
 * its access restricted to safeguarding personnel). **Owner only; never one who is a guardian or supervisor of the child, or named by the report.** Audited
 * in the case's own record and the group's, and in the activity log without a venue (so a venue's staff cannot read it). *Legal preservation requirements are
 * pending legal review.*
 */
export async function createHold(
  admin: Admin,
  input: { scope: unknown; groupId?: unknown; minorUserId?: unknown; reportId?: unknown; reason: unknown; reference?: unknown; reviewOn?: unknown }
): Promise<{ ok: true; id: number } | YouthRefusal> {
  if (!scopeOf(admin).owner) return refuseYouth("YG_OWNER_ONLY");
  const reason = clean(input.reason, 3, 300);
  if (!reason) return refuseYouth("YG_REASON");
  let reference: string | null = null;
  if (input.reference !== undefined && input.reference !== null && input.reference !== "") {
    reference = clean(input.reference, 1, 200);
    if (!reference || hasNumberRun(reference)) return refuseYouth("YG_HOLD_REF");
  }
  let reviewOn: string | null = null;
  if (input.reviewOn !== undefined && input.reviewOn !== null && input.reviewOn !== "") {
    if (typeof input.reviewOn !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(input.reviewOn) || Number.isNaN(Date.parse(input.reviewOn))) return refuseYouth("YG_DATE");
    reviewOn = input.reviewOn;
  }
  const db = getDb();
  let groupId: number;
  let minorId: number | null = null;
  let reportId: number | null = null;
  if (input.scope === "case") {
    if (!Number.isInteger(input.reportId)) return refuseYouth("YG_HOLD");
    const names = namesTheViewerSql("r", admin);
    const r = (await db
      .prepare(`SELECT r.id, r.context_id FROM player_message_reports r WHERE r.id = ? AND r.urgent = 1 AND r.context_kind = 'group' AND NOT ${names.sql}`)
      .get(input.reportId, ...names.args)) as { id: number; context_id: number } | undefined;
    if (!r) return refuseYouth("YG_HOLD");
    groupId = r.context_id;
    reportId = r.id;
  } else if (input.scope === "child_group") {
    if (!Number.isInteger(input.groupId) || !Number.isInteger(input.minorUserId)) return refuseYouth("YG_HOLD");
    groupId = input.groupId as number;
    minorId = input.minorUserId as number;
    if (!(await youthGroupOf(groupId)) || !(await db.prepare("SELECT 1 FROM users WHERE id = ?").get(minorId))) return refuseYouth("YG_HOLD");
    if (await adminIsGuardianOrSupervisor(admin, groupId, minorId)) return refuseYouth("YG_HOLD");
  } else return refuseYouth("YG_HOLD");
  if (await adminIsAccusedIn(admin, groupId)) return refuseYouth("YG_HOLD");
  const made = await withTransaction(async () => {
    const row = (await db
      .prepare(
        `INSERT INTO youth_evidence_holds (scope_kind, group_id, minor_user_id, report_id, reason, reference, created_by, review_on) VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
      )
      .get(input.scope, groupId, minorId, reportId, reason, reference, admin.name, reviewOn)) as { id: number };
    await consentEvent(groupId, "staff", "hold_set", { minorId, detail: `hold ${row.id}${reportId !== null ? `, report ${reportId}` : ""}` });
    if (reportId !== null) await caseAudit(reportId, groupId, admin.name, "hold_set", `hold ${row.id}: ${reason}`);
    return row.id;
  });
  await logAction(admin, { venueId: null, action: "messages.youth_hold", detail: `Legal hold ${made} set on evidence of supervised youth group ${groupId}` });
  return { ok: true, id: made };
}

async function liveHold(id: unknown): Promise<{ id: number; group_id: number; minor_user_id: number | null; report_id: number | null } | null> {
  if (!Number.isInteger(id)) return null;
  return ((await getDb().prepare("SELECT id, group_id, minor_user_id, report_id FROM youth_evidence_holds WHERE id = ? AND released_at IS NULL").get(id)) ?? null) as
    | { id: number; group_id: number; minor_user_id: number | null; report_id: number | null }
    | null;
}

/** The platform's owner releases a hold, with a reason. Retention and erasure then treat the evidence as any other. */
export async function releaseHold(admin: Admin, id: unknown, reasonRaw: unknown): Promise<{ ok: true } | YouthRefusal> {
  if (!scopeOf(admin).owner) return refuseYouth("YG_OWNER_ONLY");
  const reason = clean(reasonRaw, 3, 300);
  if (!reason) return refuseYouth("YG_REASON");
  const h = await liveHold(id);
  if (!h) return refuseYouth("YG_HOLD");
  const done = await withTransaction(async () => {
    const r = await getDb().prepare("UPDATE youth_evidence_holds SET released_at = datetime('now'), released_by = ?, release_reason = ? WHERE id = ? AND released_at IS NULL").run(admin.name, reason, h.id);
    if (r.changes === 0) return false;
    await consentEvent(h.group_id, "staff", "hold_released", { minorId: h.minor_user_id, detail: `hold ${h.id}` });
    if (h.report_id !== null) await caseAudit(h.report_id, h.group_id, admin.name, "hold_released", `hold ${h.id}: ${reason}`);
    return true;
  });
  if (!done) return refuseYouth("YG_HOLD");
  await logAction(admin, { venueId: null, action: "messages.youth_hold", detail: `Legal hold ${h.id} on supervised youth group ${h.group_id} released` });
  return { ok: true };
}

/** The platform's owner records that a hold was looked at, with a reason, and may set the next review date. Resets the review interval. */
export async function reviewHold(admin: Admin, id: unknown, reasonRaw: unknown, reviewOn?: unknown): Promise<{ ok: true } | YouthRefusal> {
  if (!scopeOf(admin).owner) return refuseYouth("YG_OWNER_ONLY");
  const reason = clean(reasonRaw, 3, 300);
  if (!reason) return refuseYouth("YG_REASON");
  let next: string | null = null;
  if (reviewOn !== undefined && reviewOn !== null && reviewOn !== "") {
    if (typeof reviewOn !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(reviewOn) || Number.isNaN(Date.parse(reviewOn))) return refuseYouth("YG_DATE");
    next = reviewOn;
  }
  const h = await liveHold(id);
  if (!h) return refuseYouth("YG_HOLD");
  await getDb().prepare("UPDATE youth_evidence_holds SET last_reviewed_at = datetime('now'), review_on = ? WHERE id = ? AND released_at IS NULL").run(next, h.id);
  await consentEvent(h.group_id, "staff", "hold_reviewed", { minorId: h.minor_user_id, detail: `hold ${h.id}` });
  if (h.report_id !== null) await caseAudit(h.report_id, h.group_id, admin.name, "hold_reviewed", `hold ${h.id}: ${reason}`);
  await logAction(admin, { venueId: null, action: "messages.youth_hold", detail: `Legal hold ${h.id} on supervised youth group ${h.group_id} reviewed` });
  return { ok: true };
}

/** The holds in force, for the platform's owner only. */
export async function listHolds(admin: Admin): Promise<{ ok: true; holds: EvidenceHold[] } | YouthRefusal> {
  if (!scopeOf(admin).owner) return refuseYouth("YG_OWNER_ONLY");
  const months = safeguardingReviewMonths();
  const rows = (await getDb()
    .prepare(
      `SELECT h.id, h.scope_kind, h.group_id, g.name AS group_name, u.name AS child_name, h.report_id, h.reason, h.reference, h.created_by, h.created_at, h.review_on, h.last_reviewed_at,
              (h.review_on IS NOT NULL AND h.review_on <= substr(datetime('now'), 1, 10)) OR COALESCE(h.last_reviewed_at, h.created_at) < datetime('now', '-${months} months') AS due
         FROM youth_evidence_holds h LEFT JOIN community_groups g ON g.id = h.group_id LEFT JOIN users u ON u.id = h.minor_user_id
        WHERE h.released_at IS NULL ORDER BY h.id`
    )
    .all()) as {
    id: number; scope_kind: "child_group" | "case"; group_id: number; group_name: string | null; child_name: string | null; report_id: number | null; reason: string; reference: string | null;
    created_by: string; created_at: string; review_on: string | null; last_reviewed_at: string | null; due: boolean;
  }[];
  return {
    ok: true,
    holds: rows.map((r) => ({
      id: r.id, scope: r.scope_kind, groupId: r.group_id, groupName: r.group_name, child: r.child_name ? shortName(r.child_name) : null, reportId: r.report_id, reason: r.reason, reference: r.reference,
      createdBy: r.created_by, createdAt: r.created_at, reviewOn: r.review_on, lastReviewedAt: r.last_reviewed_at, reviewDue: r.due,
    })),
  };
}

// ------------------------------------------------------------------ the periodic review prompt, and the deletion only an install can set

export interface ReviewDue {
  months: number;
  /** Closed cases kept longer than the interval since they were closed or last looked at, for a decision. */
  cases: { reportId: number; groupId: number; groupName: string | null; closedAt: string }[];
  holds: { id: number; groupId: number; reviewOn: string | null }[];
}

/** SQL: closed youth cases: dealt with, no restriction in force (so no open request for a review of one), and not under a legal hold. */
const CLOSED_CASES = `r.urgent = 1 AND r.context_kind = 'group' AND r.status = 'reviewed'
  AND NOT EXISTS (SELECT 1 FROM youth_thread_mutes cm WHERE cm.report_id = r.id AND cm.lifted_at IS NULL)
  AND r.id NOT IN (${LEGAL_HELD_REPORTS})`;

/** What the platform's owner is asked to decide about: not deletion. Empty when nothing has been kept past `SAFEGUARDING_REVIEW_MONTHS`. */
export async function safeguardingReviewDue(): Promise<ReviewDue> {
  const db = getDb();
  const months = safeguardingReviewMonths();
  const cases = (await db
    .prepare(
      `SELECT r.id, r.context_id, g.name, GREATEST(r.reviewed_at, COALESCE((SELECT MAX(a.created_at) FROM youth_report_actions a WHERE a.report_id = r.id AND a.action = 'retention_reviewed'), r.reviewed_at)) AS basis
         FROM player_message_reports r LEFT JOIN community_groups g ON g.id = r.context_id
        WHERE ${CLOSED_CASES} AND GREATEST(r.reviewed_at, COALESCE((SELECT MAX(a.created_at) FROM youth_report_actions a WHERE a.report_id = r.id AND a.action = 'retention_reviewed'), r.reviewed_at)) < datetime('now', '-${months} months')
        ORDER BY r.id`
    )
    .all()) as { id: number; context_id: number; name: string | null; basis: string }[];
  const holds = (await db
    .prepare(
      `SELECT id, group_id, review_on FROM youth_evidence_holds
        WHERE released_at IS NULL AND ((review_on IS NOT NULL AND review_on <= substr(datetime('now'), 1, 10)) OR COALESCE(last_reviewed_at, created_at) < datetime('now', '-${months} months')) ORDER BY id`
    )
    .all()) as { id: number; group_id: number; review_on: string | null }[];
  return {
    months,
    cases: cases.map((c) => ({ reportId: c.id, groupId: c.context_id, groupName: c.name, closedAt: c.basis })),
    holds: holds.map((h) => ({ id: h.id, groupId: h.group_id, reviewOn: h.review_on })),
  };
}

/**
 * The platform's owner records a decision to **keep** a closed case after looking at it, with a reason: the case leaves the review prompt until the interval
 * has passed again. A prompt asks for a decision; it never deletes anything. (Owner only.)
 */
export async function recordRetentionReview(admin: Admin, reportId: unknown, reasonRaw: unknown): Promise<{ ok: true } | YouthRefusal> {
  if (!scopeOf(admin).owner) return refuseYouth("YG_OWNER_ONLY");
  const reason = clean(reasonRaw, 3, 300);
  if (!reason) return refuseYouth("YG_REASON");
  if (!Number.isInteger(reportId)) return refuseYouth("YG_HOLD");
  const names = namesTheViewerSql("r", admin);
  const r = (await getDb()
    .prepare(`SELECT r.id, r.context_id FROM player_message_reports r WHERE r.id = ? AND ${CLOSED_CASES} AND NOT ${names.sql}`)
    .get(reportId, ...names.args)) as { id: number; context_id: number } | undefined;
  if (!r || (await adminIsAccusedIn(admin, r.context_id))) return refuseYouth("YG_HOLD");
  await caseAudit(r.id, r.context_id, admin.name, "retention_reviewed", reason);
  return { ok: true };
}

/**
 * From the scheduler: if something has been kept past the review interval, the platform's owners are asked, by a safeguarding email, to look and decide
 * (counts only: no name, no group, no text). At most once every 30 days while something is due. Returns whether it asked.
 */
export async function tellOwnersReviewDue(): Promise<boolean> {
  const due = await safeguardingReviewDue();
  if (due.cases.length === 0 && due.holds.length === 0) return false;
  const db = getDb();
  const last = (await db.prepare("SELECT value FROM settings WHERE key = 'safeguarding_review_prompted_at'").get()) as { value: string } | undefined;
  if (last && last.value > ((await db.prepare("SELECT datetime('now', '-30 days') AS t").get()) as { t: string }).t) return false;
  await db
    .prepare("INSERT INTO settings (key, value) VALUES ('safeguarding_review_prompted_at', datetime('now')) ON CONFLICT (key) DO UPDATE SET value = datetime('now')")
    .run();
  try {
    await tellOwnersEach(
      (t) => ({
        subject: t("msg4.mail.retentionSubject"),
        body: staffSentences(t, t("msg4.mail.retentionBody", { cases: due.cases.length, holds: due.holds.length, months: due.months })),
      }),
      { kind: "safeguarding_notice" }
    );
  } catch (err) {
    console.error("[mysenam] could not queue a safeguarding notice:", err instanceof Error ? err.message : "unknown error");
  }
  return true;
}

/**
 * Retention of closed cases' evidence, **only if the install sets `SAFEGUARDING_EVIDENCE_RETENTION_DAYS`** (which needs legal approval before it is set): a
 * closed case older than that, with no restriction in force and no legal hold, is deleted with its case actions. Unset, it
 * does nothing, ever. The audit records of the group (the safeguarding event store, the activity log) are not deleted by this or by anything else automatic.
 */
export async function pruneSafeguardingEvidence(): Promise<number> {
  const days = safeguardingEvidenceRetentionDays();
  if (days === null) return 0;
  const db = getDb();
  const ids = (await db.prepare(`SELECT r.id FROM player_message_reports r WHERE ${CLOSED_CASES} AND r.reviewed_at < ?`).all(cutoffFor(days))) as { id: number }[];
  for (const { id } of ids) {
    await db.prepare("DELETE FROM youth_report_actions WHERE report_id = ?").run(id);
    await db.prepare("DELETE FROM player_message_reports WHERE id = ?").run(id);
  }
  return ids.length;
}

/** How many closed cases the install's own period would delete now (the retention screen's count); 0 when no period is set. */
export async function safeguardingEvidenceDue(): Promise<number> {
  const days = safeguardingEvidenceRetentionDays();
  if (days === null) return 0;
  return ((await getDb().prepare(`SELECT COUNT(*)::int AS n FROM player_message_reports r WHERE ${CLOSED_CASES} AND r.reviewed_at < ?`).get(cutoffFor(days))) as { n: number }).n;
}
