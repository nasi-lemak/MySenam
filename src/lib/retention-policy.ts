import { logAction } from "./activity";
import { isOwner, type Admin } from "./admin-auth";
import { getDb } from "./db";
import { RETENTION } from "./privacy";
import { isValidDateString, todayISO } from "./time";

/**
 * The install's own retention periods for applications to be approved for an
 * activity, and the record of their review (docs/architecture/privacy.md#applications-to-be-approved-for-an-activity;
 * ADR 0024; migration 0143).
 *
 * The defaults (lib/privacy.ts RETENTION: documents 90 days after the
 * decision, a 30-day review window, a closed application's record 365 days)
 * are the product owner's provisional choice: product policy, not a legal
 * requirement of any country, and subject to professional legal review in
 * each country an install serves. Nothing here says they satisfy Malaysia's
 * or Singapore's PDPA. The platform owner sets the install's periods within
 * wide bounds (no country's answer is built in); an activity may keep less
 * than the install, never more; a hold keeps one application longer.
 *
 * Until somebody records a review (who reviewed the periods, on what day, on
 * what basis), the periods are **provisional** wherever they are shown.
 * Changing any period lapses the review. Every change and review is kept
 * (`retention_policy_events`), never pruned.
 */

export interface RetentionPolicy {
  /** Supporting documents, at most this long after the decision. */
  documentDays: number;
  /** The review window: documents of a refused, withdrawn or lapsed application, or of an approval that ended. */
  reviewDays: number;
  /** A closed application's answers, declarations and history; on an approval standing, from the decision. */
  recordDays: number;
  /** What is left of a document the malware scan refused, or could not scan. */
  quarantineDays: number;
  changedAt: string | null;
  changedBy: string | null;
  review: { reviewedOn: string; reviewedBy: string; basis: string; recordedBy: string | null; recordedAt: string | null } | null;
  /** No review recorded since the periods were last set. */
  provisional: boolean;
}

/** What the platform owner may set the install's periods to: wide, so no country's answer is assumed. */
export const POLICY_BOUNDS = {
  documentDays: [7, 365],
  reviewDays: [1, 365],
  recordDays: [30, 2190],
  quarantineDays: [1, 30],
} as const;

export const DEFAULT_POLICY = {
  documentDays: RETENTION.approvalDocumentDays,
  reviewDays: RETENTION.approvalReviewDays,
  recordDays: RETENTION.approvalRequestDays,
  quarantineDays: 7,
} as const;

const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v));

interface PolicyRow {
  approval_document_days: number;
  approval_review_days: number;
  approval_record_days: number;
  scan_quarantine_days: number;
  changed_at: unknown;
  changed_by_name: string | null;
  reviewed_on: string | null;
  reviewed_by: string | null;
  review_basis: string | null;
  review_recorded_by_name: string | null;
  review_recorded_at: unknown;
}

/** The install's periods as they stand. */
export async function retentionPolicy(): Promise<RetentionPolicy> {
  const r = (await getDb().prepare("SELECT * FROM retention_policy WHERE id = 1").get()) as PolicyRow | undefined;
  if (!r) return { ...DEFAULT_POLICY, changedAt: null, changedBy: null, review: null, provisional: true };
  const review =
    r.reviewed_on && r.reviewed_by && r.review_basis
      ? { reviewedOn: r.reviewed_on, reviewedBy: r.reviewed_by, basis: r.review_basis, recordedBy: r.review_recorded_by_name, recordedAt: iso(r.review_recorded_at) }
      : null;
  return {
    documentDays: r.approval_document_days,
    reviewDays: r.approval_review_days,
    recordDays: r.approval_record_days,
    quarantineDays: r.scan_quarantine_days,
    changedAt: iso(r.changed_at),
    changedBy: r.changed_by_name,
    review,
    provisional: review === null,
  };
}

export type PolicyRefusal = { ok: false; error: string; status: number };
const no = (error: string, status = 400): PolicyRefusal => ({ ok: false, error, status });

/** Every change and recorded review of the install's periods, newest first. */
export async function policyEvents(limit = 50): Promise<{ at: string | null; kind: string; by: string; detail: string }[]> {
  const rows = (await getDb()
    .prepare("SELECT at, kind, by_name, detail FROM retention_policy_events ORDER BY id DESC LIMIT ?")
    .all(limit)) as { at: unknown; kind: string; by_name: string; detail: string }[];
  return rows.map((r) => ({ at: iso(r.at), kind: r.kind, by: r.by_name, detail: r.detail }));
}

/**
 * Set the install's periods (the platform owner only). Each within its
 * bounds; the review window no longer than the documents' period. Any change
 * lapses a recorded review: the periods are provisional again until reviewed.
 */
export async function setRetentionPolicy(
  admin: Admin,
  input: { documentDays?: unknown; reviewDays?: unknown; recordDays?: unknown; quarantineDays?: unknown }
): Promise<{ ok: true; policy: RetentionPolicy } | PolicyRefusal> {
  if (!isOwner(admin)) return no("Only the platform owner can change the install's retention periods.", 403);
  const now = await retentionPolicy();
  const read = (v: unknown, current: number, [min, max]: readonly [number, number]): number | null => {
    if (v === undefined || v === null || v === "") return current;
    const n = Number(v);
    return Number.isInteger(n) && n >= min && n <= max ? n : null;
  };
  const documentDays = read(input.documentDays, now.documentDays, POLICY_BOUNDS.documentDays);
  const reviewDays = read(input.reviewDays, now.reviewDays, POLICY_BOUNDS.reviewDays);
  const recordDays = read(input.recordDays, now.recordDays, POLICY_BOUNDS.recordDays);
  const quarantineDays = read(input.quarantineDays, now.quarantineDays, POLICY_BOUNDS.quarantineDays);
  if (documentDays === null) return no("Documents are kept 7 to 365 days after the decision.");
  if (reviewDays === null || reviewDays > documentDays) return no("The review window is 1 day or more, and no longer than documents are kept.");
  if (recordDays === null) return no("A closed application is kept 30 to 2190 days.");
  if (quarantineDays === null) return no("A refused or unscannable document is kept 1 to 30 days.");
  const changed =
    documentDays !== now.documentDays || reviewDays !== now.reviewDays || recordDays !== now.recordDays || quarantineDays !== now.quarantineDays;
  if (!changed) return { ok: true, policy: now };
  const db = getDb();
  const detail = `Documents ${documentDays} days, review window ${reviewDays}, closed applications ${recordDays}, refused or unscannable documents ${quarantineDays} (was ${now.documentDays}, ${now.reviewDays}, ${now.recordDays}, ${now.quarantineDays})`;
  await db.transaction(async () => {
    await db
      .prepare(
        `UPDATE retention_policy SET approval_document_days = ?, approval_review_days = ?, approval_record_days = ?, scan_quarantine_days = ?,
           changed_at = now(), changed_by_name = ?, reviewed_on = NULL, reviewed_by = NULL, review_basis = NULL,
           review_recorded_by_name = NULL, review_recorded_at = NULL
          WHERE id = 1`
      )
      .run(documentDays, reviewDays, recordDays, quarantineDays, admin.name);
    await db.prepare("INSERT INTO retention_policy_events (kind, admin_id, by_name, detail) VALUES ('changed', ?, ?, ?)").run(admin.id, admin.name, detail);
  })();
  await logAction(admin, { venueId: null, action: "retention.policy", detail });
  return { ok: true, policy: await retentionPolicy() };
}

/**
 * Record that somebody qualified reviewed the install's periods (the platform
 * owner records it): who reviewed them (name and firm), on what day, and on
 * what basis. It is the reviewer's view, recorded; the app does not decide
 * whether the periods meet any law.
 */
export async function recordPolicyReview(
  admin: Admin,
  input: { reviewedOn?: unknown; reviewedBy?: unknown; basis?: unknown }
): Promise<{ ok: true; policy: RetentionPolicy } | PolicyRefusal> {
  if (!isOwner(admin)) return no("Only the platform owner can record the review of the retention periods.", 403);
  const reviewedOn = typeof input.reviewedOn === "string" ? input.reviewedOn : "";
  if (!isValidDateString(reviewedOn) || reviewedOn > todayISO()) return no("Give the day of the review: today or earlier.");
  const reviewedBy = typeof input.reviewedBy === "string" ? input.reviewedBy.trim() : "";
  if (reviewedBy.length < 3 || reviewedBy.length > 200) return no("Name who reviewed the periods, and their firm.");
  const basis = typeof input.basis === "string" ? input.basis.trim() : "";
  if (basis.length < 10 || basis.length > 2000) return no("Say what the review was based on, in a sentence or two.");
  const now = await retentionPolicy();
  const db = getDb();
  const detail = `Reviewed by ${reviewedBy} on ${reviewedOn} (documents ${now.documentDays} days, review window ${now.reviewDays}, closed applications ${now.recordDays}, refused or unscannable documents ${now.quarantineDays}): ${basis}`;
  await db.transaction(async () => {
    await db
      .prepare(
        `UPDATE retention_policy SET reviewed_on = ?, reviewed_by = ?, review_basis = ?, review_recorded_by_name = ?, review_recorded_at = now() WHERE id = 1`
      )
      .run(reviewedOn, reviewedBy, basis, admin.name);
    await db.prepare("INSERT INTO retention_policy_events (kind, admin_id, by_name, detail) VALUES ('reviewed', ?, ?, ?)").run(admin.id, admin.name, detail.slice(0, 3000));
  })();
  await logAction(admin, { venueId: null, action: "retention.reviewed", detail: detail.slice(0, 500) });
  return { ok: true, policy: await retentionPolicy() };
}
