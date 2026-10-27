import { logAction } from "./activity";
import { canAccessVenue, isOwner, type Admin } from "./admin-auth";
import { getDb } from "./db";
import { ANONYMOUS, RETENTION, type RetentionLine } from "./privacy";
import { retentionPolicy, type RetentionPolicy } from "./retention-policy";
import { englishOf, said, type ServerPhrase } from "./staff-text";
import { addDays, isValidDateString, todayISO } from "./time";

/**
 * How long applications to be approved for an activity are kept, each part
 * by its purpose (docs/architecture/privacy.md#applications-to-be-approved-for-an-activity;
 * ADR 0021). The periods are provisional defaults the owner accepted, not
 * statutory ones, and remain subject to professional legal review.
 *
 * - **The eligibility** an approval gives is the sign-off or certification it
 *   wrote (lib/sign-offs.ts): who, the activity and venue, sign-off or
 *   certification (with its number and issuer), how long it holds, and who
 *   gave it. It is kept as long as it is valid, as every sign-off is, and
 *   never goes because the application that led to it does.
 * - **Supporting documents** only while the decision, a review or an appeal
 *   needs them: an application refused, withdrawn or lapsed loses them once
 *   its review window has passed (30 days unless the activity says fewer);
 *   an approved one 90 days after the decision at most, or the review window
 *   after its approval ended (lapsed, taken back or replaced), whichever is
 *   first.
 * - **The application's answers, declarations and history** 365 days after it
 *   closed (decided other than approved, or its approval ended), when the
 *   record is deleted. On an approval still standing, the same period after
 *   the decision: the answers, declarations, slot and the reasons in its
 *   history go, the approval and the bare facts of its decision stay.
 * - **What is left of a deleted application** (that it existed, how it ended,
 *   when, and who decided: no answers, documents, name or number), and the
 *   record of who opened its documents, 730 days, as the staff activity log.
 *
 * The periods above are the defaults; the platform owner may set the
 * install's own (lib/retention-policy.ts), still provisional until a review
 * is recorded. A supporting document the malware scan refused, or a working
 * scanner could not scan (lib/document-scanning.ts), goes the install's
 * quarantine period (7 days by default) after that was settled, whatever
 * else applies. A document still waiting for a scanner (pending, or failed
 * only because none answered), stored before scanning existed or not, is
 * never removed for that: only by the periods above. Each document removed
 * is recorded with the rule that removed it (`approval_document_removals`).
 *
 * An activity may set shorter periods (approval_requirements), never longer.
 * Only a hold keeps an application longer: placed for an actual legal,
 * safety or dispute reason by the platform owner (a year at a time at most)
 * or a manager of the venue (90 days at most, 180 in all for one
 * application), with its reason, who placed it in what role, and the day it
 * is to be reviewed; it stops protecting anything after that day unless
 * renewed. Front desk and coaches cannot place one.
 *
 * Deleting a row here does not reach copies already in backups: those age out
 * with the backups themselves (docs/operations/backups.md).
 */

export type HoldBasis = "legal" | "safety" | "dispute" | "incident";
export const HOLD_BASES: HoldBasis[] = ["legal", "safety", "dispute", "incident"];

const LIVE = "('pending', 'info_requested', 'in_person_due')";

/** Today, as a literal for the queries below (a date the app made, never input). */
function dayLiteral(today: string): string {
  if (!isValidDateString(today)) throw new Error(`not a date: ${today}`);
  return `'${today}'`;
}

/** A whole number of days, as a literal for the queries below (the install's policy, checked when set). */
function daysLiteral(n: number): number {
  if (!Number.isInteger(n) || n < 0) throw new Error(`not a number of days: ${n}`);
  return n;
}

/** An activity's own period, or the install's, never past the install's. */
const period = (column: "review_days" | "document_days" | "record_days", install: number, max: number) =>
  `make_interval(days => LEAST(COALESCE(q.${column}, ${daysLiteral(install)}), ${daysLiteral(max)}))`;

/** The install's periods, as the queries below use them. */
type Periods = Pick<RetentionPolicy, "documentDays" | "reviewDays" | "recordDays" | "quarantineDays">;

// As before the install could set its own: an activity's review window may be anything up to the documents' period.
const REVIEW = (p: Periods) => period("review_days", p.reviewDays, p.documentDays);
const DOCUMENTS = (p: Periods) => period("document_days", p.documentDays, p.documentDays);
const RECORD = (p: Periods) => period("record_days", p.recordDays, p.recordDays);

/** Every application, with what its activity says and the sign-off it wrote. */
const FROM = `approval_requests r
  JOIN approval_requirements q ON q.id = r.requirement_id
  LEFT JOIN sign_offs s ON s.id = r.sign_off_id`;

/**
 * When an application closed: decided other than approved; or approved, and
 * its approval has ended (its last day passed, taken back or replaced, or
 * its sign-off gone). NULL while it is live or its approval stands.
 */
const closedAt = (today: string) => `CASE
    WHEN r.closed_at IS NOT NULL THEN r.closed_at
    WHEN r.status IN ('rejected', 'withdrawn', 'expired') THEN r.decided_at
    WHEN r.status = 'approved' AND r.valid_until IS NOT NULL AND r.valid_until < ${dayLiteral(today)} THEN (r.valid_until::date + 1)::timestamptz
    WHEN r.status = 'approved' AND s.revoked_at IS NOT NULL THEN s.revoked_at::timestamptz
    WHEN r.status = 'approved' AND s.id IS NULL THEN now()
  END`;

/** A hold in force on the application. */
const held = (today: string) =>
  `EXISTS (SELECT 1 FROM approval_holds h WHERE h.request_id = r.id AND h.released_at IS NULL AND h.review_by >= ${dayLiteral(today)})`;

/** Applications whose documents are no longer needed. */
const documentsDue = (today: string, p: Periods) => `r.status NOT IN ${LIVE} AND r.decided_at IS NOT NULL AND NOT ${held(today)} AND (
    r.minimised_at IS NOT NULL
    OR r.decided_at < now() - ${DOCUMENTS(p)}
    OR ${closedAt(today)} < now() - ${REVIEW(p)}
  )`;

/** Approved applications whose answers and history detail are due to go, the approval staying. */
const minimiseDue = (today: string, p: Periods) =>
  `r.status = 'approved' AND r.minimised_at IS NULL AND r.decided_at < now() - ${RECORD(p)} AND NOT ${held(today)}`;

/** Closed applications whose record is due to be deleted. */
const recordDue = (today: string, p: Periods) => `r.status NOT IN ${LIVE} AND ${closedAt(today)} < now() - ${RECORD(p)} AND NOT ${held(today)}`;

/** Documents due, and any not tied to an application still holding its record (an orphan). */
const documentRows = (today: string, p: Periods) =>
  `request_id IN (SELECT r.id FROM ${FROM} WHERE ${documentsDue(today, p)})
   OR NOT EXISTS (SELECT 1 FROM approval_requests x WHERE x.id = approval_documents.request_id)`;

/**
 * Documents the malware scan refused (their bytes already gone) or a working
 * scanner could not scan (their bytes still in quarantine, never released):
 * what is left goes the quarantine period after the scan settled, unless a
 * hold keeps the application. Not a document that failed only because no
 * scanner answered: that one waits for a scanner, and goes only by its own
 * retention (documentRows).
 */
const quarantineRows = (today: string, p: Periods) =>
  `(scan_status = 'rejected' OR (scan_status = 'failed' AND scan_failure = 'unscannable'))
   AND scanned_at < now() - make_interval(days => ${daysLiteral(p.quarantineDays)})
   AND request_id IN (SELECT r.id FROM approval_requests r WHERE NOT ${held(today)})`;

/**
 * Note each document about to be removed, and under which rule: numbers and
 * states only (migration 0160). `where` is one of the conditions above,
 * written against approval_documents.
 */
const noteRemovals = (where: string, why: "retention" | "quarantine" | "erasure", ...params: unknown[]) =>
  getDb()
    .prepare(
      `INSERT INTO approval_document_removals (document_id, request_id, venue_id, why, scan_status, scan_failure, legacy_reason)
       SELECT id, request_id, (SELECT x.venue_id FROM approval_requests x WHERE x.id = approval_documents.request_id), '${why}',
              scan_status, scan_failure, legacy_reason
         FROM approval_documents WHERE ${where}`
    )
    .run(...params);

const auditDue = `COALESCE(closed_at, removed_at) < now() - make_interval(days => ${RETENTION.approvalAuditDays})`;
const accessDue = `at < now() - make_interval(days => ${RETENTION.approvalAuditDays})`;

async function count(sql: string): Promise<number> {
  return Number(((await getDb().prepare(sql).get()) as { n: number | string }).n);
}

const line = (key: ServerPhrase, days: number, action: RetentionLine["action"], affected: number): RetentionLine => {
  const what = said(key);
  return { what: englishOf(what), whatPhrase: what, days, action, affected };
};

/** What the next run would do to applications, without doing it (lib/privacy.ts retentionDue). */
export async function approvalRetentionDue(today = todayISO()): Promise<RetentionLine[]> {
  const p = await retentionPolicy();
  return [
    line("srv.ret.approvalDocuments", p.documentDays, "deleted", await count(`SELECT COUNT(*)::int AS n FROM approval_documents WHERE ${documentRows(today, p)}`)),
    line("srv.retx.quarantined", p.quarantineDays, "deleted", await count(`SELECT COUNT(*)::int AS n FROM approval_documents WHERE ${quarantineRows(today, p)}`)),
    line("srv.ret.approvalsMinimised", p.recordDays, "anonymised", await count(`SELECT COUNT(*)::int AS n FROM ${FROM} WHERE ${minimiseDue(today, p)}`)),
    line("srv.ret.approvalsClosed", p.recordDays, "deleted", await count(`SELECT COUNT(*)::int AS n FROM ${FROM} WHERE ${recordDue(today, p)}`)),
    line(
      "srv.ret.approvalsAudit",
      RETENTION.approvalAuditDays,
      "deleted",
      (await count(`SELECT COUNT(*)::int AS n FROM approval_audit WHERE ${auditDue}`)) +
        (await count(`SELECT COUNT(*)::int AS n FROM approval_document_access WHERE ${accessDue}`))
    ),
  ];
}

/** The decision's bare facts, as kept once the application itself goes. */
const AUDIT_SELECT = (today: string | null, why: "retention" | "erasure", keepUser: boolean) => `
  SELECT r.id, r.venue_id, r.sport, ${keepUser ? "r.user_id" : "NULL"}, r.status, r.created_at, r.decided_at,
         (SELECT e.actor_name FROM approval_events e WHERE e.request_id = r.id AND e.action IN ('approved', 'rejected', 'withdrawn', 'expired') ORDER BY e.id DESC LIMIT 1),
         (SELECT e.actor FROM approval_events e WHERE e.request_id = r.id AND e.action IN ('approved', 'rejected', 'withdrawn', 'expired') ORDER BY e.id DESC LIMIT 1),
         ${today ? closedAt(today) : "r.closed_at"}, '${why}'
    FROM ${FROM}`;
const AUDIT_INSERT =
  "INSERT INTO approval_audit (request_id, venue_id, sport, user_id, outcome, applied_at, decided_at, decided_by, decided_by_kind, closed_at, removed_why)";

/**
 * Apply the policy to applications. Run inside the daily retention run's
 * transaction (lib/privacy.ts pruneOldData), before the sign-offs' own rule,
 * so an approval's end is noted while the sign-off it rests on is still there.
 */
export async function pruneApprovals(today = todayISO()): Promise<void> {
  const db = getDb();
  const p = await retentionPolicy();
  // Note when each application closed, once, so it does not move later.
  await db
    .prepare(
      `UPDATE approval_requests SET closed_at = c.at
         FROM (SELECT r.id, ${closedAt(today)} AS at FROM ${FROM} WHERE r.closed_at IS NULL AND r.status NOT IN ${LIVE}) c
        WHERE c.id = approval_requests.id AND c.at IS NOT NULL`
    )
    .run();
  // Documents no longer needed, and any left without an application to hold them.
  await noteRemovals(documentRows(today, p), "retention");
  await db.prepare(`DELETE FROM approval_documents WHERE ${documentRows(today, p)}`).run();
  // What is left of documents the malware scan refused or could not scan, after the quarantine period.
  await noteRemovals(quarantineRows(today, p), "quarantine");
  await db.prepare(`DELETE FROM approval_documents WHERE ${quarantineRows(today, p)}`).run();
  // An approval still standing keeps its bare facts; the answers, declarations and slot go.
  const minimise = `SELECT r.id FROM ${FROM} WHERE ${minimiseDue(today, p)}`;
  await noteRemovals(`request_id IN (${minimise})`, "retention");
  await db.prepare(`DELETE FROM approval_documents WHERE request_id IN (${minimise})`).run();
  await db
    .prepare(
      `UPDATE approval_requests SET name = '${ANONYMOUS}', phone = '', answers = '{}', declared_at = NULL, video_watched_at = NULL,
         waiver_signed_at = NULL, guardian_name = CASE WHEN declared_adult = 1 THEN NULL ELSE '${ANONYMOUS}' END,
         cert_reference = NULL, cert_expires_on = NULL, court_id = NULL, slot_date = NULL, slot_start = NULL, slot_end = NULL,
         hold_until = NULL, slot_status = NULL, booking_id = NULL, authority_declared_at = NULL, minimised_at = now()
        WHERE id IN (${minimise})`
    )
    .run();
  // The history keeps who did what and when; not what anybody wrote.
  await db
    .prepare("UPDATE approval_events SET reason = NULL WHERE reason IS NOT NULL AND request_id IN (SELECT id FROM approval_requests WHERE minimised_at IS NOT NULL)")
    .run();
  // Closed applications past their time: the bare facts kept, the rest deleted (documents, history and holds with it).
  await db.prepare(`${AUDIT_INSERT} ${AUDIT_SELECT(today, "retention", true)} WHERE ${recordDue(today, p)}`).run();
  await noteRemovals(`request_id IN (SELECT r.id FROM ${FROM} WHERE ${recordDue(today, p)})`, "retention");
  await db.prepare(`DELETE FROM approval_requests WHERE id IN (SELECT r.id FROM ${FROM} WHERE ${recordDue(today, p)})`).run();
  // And those bare facts, and who opened which document, after their own period.
  await db.prepare(`DELETE FROM approval_audit WHERE ${auditDue}`).run();
  await db.prepare(`DELETE FROM approval_document_access WHERE ${accessDue}`).run();
  await db.prepare(`DELETE FROM approval_document_removals WHERE removed_at < now() - make_interval(days => ${RETENTION.approvalAuditDays})`).run();
}

/**
 * On erasure (lib/approvals.ts eraseApprovals): the bare facts of each
 * application kept, no longer linked to anybody; the account's link taken
 * off what was already kept.
 */
export async function forgetApplicant(userId: number): Promise<void> {
  const db = getDb();
  await db.prepare(`${AUDIT_INSERT} ${AUDIT_SELECT(null, "erasure", false)} WHERE r.user_id = ?`).run(userId);
  // Their documents go with the applications (lib/approvals.ts eraseApprovals): noted as erased.
  await noteRemovals("request_id IN (SELECT id FROM approval_requests WHERE user_id = ?)", "erasure", userId);
  await db.prepare("UPDATE approval_audit SET user_id = NULL WHERE user_id = ?").run(userId);
  await db.prepare("UPDATE approval_document_access SET user_id = NULL, viewer_name = ? WHERE user_id = ?").run(ANONYMOUS, userId);
}

/** What is kept of a customer's applications already deleted, for their data export. */
export async function removedApplications(userId: number): Promise<unknown[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT a.outcome, a.applied_at, a.decided_at, a.decided_by, a.closed_at, a.removed_at, v.name AS venue, a.sport
         FROM approval_audit a JOIN venues v ON v.id = a.venue_id WHERE a.user_id = ? ORDER BY a.id`
    )
    .all(userId)) as Record<string, unknown>[];
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v));
  return rows.map((r) => ({
    venue: r.venue,
    activity: r.sport,
    status: r.outcome,
    recordRemoved: true,
    appliedAt: iso(r.applied_at),
    decidedAt: iso(r.decided_at),
    decidedBy: r.decided_by ?? null,
    closedAt: iso(r.closed_at),
    removedAt: iso(r.removed_at),
  }));
}

// ------------------------------------------------------------ holds

export interface RetentionHold {
  id: number;
  requestId: number;
  venueId: number;
  /** The applicant and activity, while the application's record still names them. */
  applicant: string;
  sport: string;
  status: string;
  basis: HoldBasis;
  reason: string;
  placedByName: string;
  placedByRole: "owner" | "manager";
  placedAt: string;
  reviewBy: string;
  releasedAt: string | null;
  releasedByName: string | null;
  releaseReason: string | null;
  /** In force: not released, and its review day not passed. */
  active: boolean;
}

type HoldRefusal = { ok: false; error: string; status: number };
const no = (error: string, status = 400): HoldRefusal => ({ ok: false, error, status });

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : String(v ?? ""));

interface HoldRow {
  id: number;
  request_id: number;
  venue_id: number;
  name: string;
  sport: string;
  status: string;
  basis: HoldBasis;
  reason: string;
  placed_by_name: string;
  placed_by_role: "owner" | "manager";
  placed_at: unknown;
  review_by: string;
  released_at: unknown;
  released_by_name: string | null;
  release_reason: string | null;
}

const toHold = (r: HoldRow, today: string): RetentionHold => ({
  id: r.id,
  requestId: r.request_id,
  venueId: r.venue_id,
  applicant: r.name,
  sport: r.sport,
  status: r.status,
  basis: r.basis,
  reason: r.reason,
  placedByName: r.placed_by_name,
  placedByRole: r.placed_by_role,
  placedAt: iso(r.placed_at),
  reviewBy: r.review_by,
  releasedAt: r.released_at === null ? null : iso(r.released_at),
  releasedByName: r.released_by_name,
  releaseReason: r.release_reason,
  active: r.released_at === null && r.review_by >= today,
});

const HOLD_SELECT = `SELECT h.*, r.name, r.sport, r.status FROM approval_holds h JOIN approval_requests r ON r.id = h.request_id`;

/** A venue's holds, those in force first. */
export async function retentionHoldsAt(venueId: number): Promise<RetentionHold[]> {
  const today = todayISO();
  const rows = (await getDb().prepare(`${HOLD_SELECT} WHERE h.venue_id = ? ORDER BY (h.released_at IS NULL AND h.review_by >= ?) DESC, h.id DESC LIMIT 200`).all(venueId, today)) as HoldRow[];
  return rows.map((r) => toHold(r, today));
}

/** Whether a hold keeps one of this account's applications (erasure waits for it: lib/privacy.ts). */
export async function heldUntilFor(userId: number): Promise<string | null> {
  const row = (await getDb()
    .prepare(
      `SELECT MAX(h.review_by) AS until FROM approval_holds h JOIN approval_requests r ON r.id = h.request_id
        WHERE r.user_id = ? AND h.released_at IS NULL AND h.review_by >= ?`
    )
    .get(userId, todayISO())) as { until: string | null } | undefined;
  return row?.until ?? null;
}

/** Who may place a hold, and for how long at most: the platform owner, or a manager of the venue; never front desk. */
function holdRole(admin: Admin): "owner" | "manager" | null {
  if (isOwner(admin)) return "owner";
  return admin.role === "desk" ? null : "manager";
}

/**
 * Keep an application past its time, for an actual legal, safety or dispute
 * reason, until a review day. The platform owner may hold one a year at a
 * time; a manager of the venue 90 days at a time and, for one application,
 * 180 days in all from their first hold on it, after which only the platform
 * owner can keep it longer. A renewal is a new hold, recorded the same way.
 */
export async function placeRetentionHold(
  admin: Admin,
  input: { venueId: number; requestId: unknown; basis: unknown; reason: unknown; reviewBy: unknown }
): Promise<{ ok: true; hold: RetentionHold } | HoldRefusal> {
  const role = holdRole(admin);
  if (!role) return no("Only a manager or the platform owner can keep an application past its time.", 403);
  if (!canAccessVenue(admin, input.venueId)) return no("You do not manage that venue.", 403);
  const requestId = Number(input.requestId);
  const db = getDb();
  const request = Number.isInteger(requestId)
    ? ((await db.prepare("SELECT id, venue_id FROM approval_requests WHERE id = ?").get(requestId)) as { id: number; venue_id: number } | undefined)
    : undefined;
  if (!request || request.venue_id !== input.venueId) return no("Application not found.", 404);
  const basis = input.basis as HoldBasis;
  if (!HOLD_BASES.includes(basis)) return no("Say what the hold is for: a legal claim or obligation, a safety incident, a dispute or an incident under investigation.");
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length < 10 || reason.length > 1000) return no("Say what the hold concerns, in at least a few words.");
  const today = todayISO();
  const reviewBy = typeof input.reviewBy === "string" ? input.reviewBy : "";
  const max = role === "owner" ? RETENTION.approvalOwnerHoldDays : RETENTION.approvalManagerHoldDays;
  if (!isValidDateString(reviewBy) || reviewBy <= today || reviewBy > addDays(today, max))
    return no(role === "owner" ? "Give a review date within a year." : "Give a review date within 90 days.");
  if (role === "manager") {
    // A manager's holds on one application, all told, end within 180 days of the first.
    const first = (await db
      .prepare("SELECT MIN(placed_at) AS first FROM approval_holds WHERE request_id = ? AND placed_by_role = 'manager'")
      .get(requestId)) as { first: unknown };
    const start = first.first ? iso(first.first).slice(0, 10) : today;
    if (reviewBy > addDays(start, RETENTION.approvalManagerHoldTotalDays))
      return no("A manager can keep an application at most 180 days in all. Ask the platform owner to keep it longer.", 403);
  }
  const row = (await db
    .prepare(
      `INSERT INTO approval_holds (request_id, venue_id, basis, reason, placed_by, placed_by_name, placed_by_role, review_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
    )
    .get(requestId, input.venueId, basis, reason, admin.id, admin.name, role, reviewBy)) as { id: number };
  await logAction(admin, {
    venueId: input.venueId,
    action: "approval.hold",
    detail: `Kept application ${requestId} past its time until ${reviewBy} (${basis}): ${reason}`,
  });
  const hold = (await db.prepare(`${HOLD_SELECT} WHERE h.id = ?`).get(row.id)) as HoldRow;
  return { ok: true, hold: toHold(hold, today) };
}

/** Let a hold go before its review day: the application's own periods apply again at the next run. */
export async function releaseRetentionHold(
  admin: Admin,
  input: { venueId: number; holdId: unknown; reason: unknown }
): Promise<{ ok: true } | HoldRefusal> {
  if (!holdRole(admin)) return no("Only a manager or the platform owner can keep an application past its time.", 403);
  if (!canAccessVenue(admin, input.venueId)) return no("You do not manage that venue.", 403);
  const reason = typeof input.reason === "string" && input.reason.trim() !== "" ? input.reason.trim().slice(0, 1000) : null;
  if (!reason) return no("Say why the hold is no longer needed.");
  const done = await getDb()
    .prepare("UPDATE approval_holds SET released_at = now(), released_by_name = ?, release_reason = ? WHERE id = ? AND venue_id = ? AND released_at IS NULL RETURNING request_id")
    .get(admin.name, reason, Number(input.holdId), input.venueId) as { request_id: number } | undefined;
  if (!done) return no("Hold not found.", 404);
  await logAction(admin, { venueId: input.venueId, action: "approval.hold_released", detail: `Released the hold on application ${done.request_id}: ${reason}` });
  return { ok: true };
}
