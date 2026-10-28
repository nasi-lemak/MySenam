import { logAction } from "./activity";
import { isOwner, type Admin } from "./admin-auth";
import { getDb } from "./db";
import { RETENTION } from "./privacy";
import { region } from "./region";
import { isValidDateString, localDateOf, todayISO } from "./time";

/**
 * The install's own retention periods for applications to be approved for an
 * activity, and the record of their review (docs/architecture/privacy.md#applications-to-be-approved-for-an-activity;
 * ADR 0024; migrations 0143, 0162).
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
 * **A recorded review is the platform owner's record of what a reviewer
 * advised, not a verification by MySenam, and never a legal approval.** It
 * must say who reviewed the periods (name, and role or qualification as
 * they state it), their firm, the jurisdiction (Malaysia and Singapore are
 * recorded separately), which periods it covers, the day, and a reference to
 * the written advice kept outside MySenam, with what it was based on. A
 * period or jurisdiction no review covers stays **provisional**; the
 * install's own country (`MYSENAM_COUNTRY`) decides whether the periods as a
 * whole are shown as provisional. Changing any period lapses every review in
 * force. Every change, review and lapse is kept (`retention_policy_events`,
 * `retention_policy_reviews`), never pruned.
 */

export const JURISDICTIONS = ["MY", "SG"] as const;
export type Jurisdiction = (typeof JURISDICTIONS)[number];
/** The periods a review may cover, each one class of record. */
export const REVIEW_SCOPE = ["documentDays", "reviewDays", "recordDays", "quarantineDays"] as const;
export type ScopeKey = (typeof REVIEW_SCOPE)[number];

export interface PolicyReview {
  id: number;
  jurisdiction: Jurisdiction;
  reviewerName: string;
  /** Their role or qualification, as they state it: not checked by MySenam. */
  reviewerRole: string;
  firm: string;
  scope: ScopeKey[];
  reviewedOn: string;
  /** Where the written advice is kept, outside MySenam. */
  adviceReference: string;
  basis: string;
  /** The periods as they stood when it was recorded. */
  periods: string;
  recordedBy: string;
  recordedAt: string | null;
}

export interface Coverage {
  /** Reviews in force for this jurisdiction. */
  reviews: PolicyReview[];
  /** Periods a review in force covers. */
  covered: ScopeKey[];
  /** Periods none covers: provisional. */
  provisional: ScopeKey[];
}

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
  /** Reviews in force, as recorded by the platform owner (not verified by MySenam), per jurisdiction. */
  coverage: Record<Jurisdiction, Coverage>;
  /** The install's own country, whose coverage decides `provisional`. */
  home: Jurisdiction;
  /** Some period has no review in force for the install's own country. */
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
}

interface ReviewRow {
  id: number;
  jurisdiction: Jurisdiction;
  reviewer_name: string;
  reviewer_role: string;
  firm: string;
  scope: string;
  reviewed_on: string;
  advice_reference: string;
  basis: string;
  periods: string;
  recorded_by_name: string;
  recorded_at: unknown;
}

const periodsOf = (p: { documentDays: number; reviewDays: number; recordDays: number; quarantineDays: number }) =>
  `${p.documentDays}/${p.reviewDays}/${p.recordDays}/${p.quarantineDays}`;

/** The install's periods as they stand, with the reviews in force. */
export async function retentionPolicy(): Promise<RetentionPolicy> {
  const db = getDb();
  const r = (await db.prepare("SELECT * FROM retention_policy WHERE id = 1").get()) as PolicyRow | undefined;
  const rows = (await db.prepare("SELECT * FROM retention_policy_reviews WHERE lapsed_at IS NULL ORDER BY id").all()) as ReviewRow[];
  const reviews: PolicyReview[] = rows.map((x) => ({
    id: Number(x.id),
    jurisdiction: x.jurisdiction,
    reviewerName: x.reviewer_name,
    reviewerRole: x.reviewer_role,
    firm: x.firm,
    scope: x.scope.split(",").filter((s): s is ScopeKey => (REVIEW_SCOPE as readonly string[]).includes(s)),
    reviewedOn: x.reviewed_on,
    adviceReference: x.advice_reference,
    basis: x.basis,
    periods: x.periods,
    recordedBy: x.recorded_by_name,
    recordedAt: iso(x.recorded_at),
  }));
  const coverage = Object.fromEntries(
    JURISDICTIONS.map((j) => {
      const mine = reviews.filter((v) => v.jurisdiction === j);
      const covered = REVIEW_SCOPE.filter((s) => mine.some((v) => v.scope.includes(s)));
      return [j, { reviews: mine, covered, provisional: REVIEW_SCOPE.filter((s) => !covered.includes(s)) }];
    })
  ) as Record<Jurisdiction, Coverage>;
  const home = region().country as Jurisdiction;
  const periods = r
    ? { documentDays: r.approval_document_days, reviewDays: r.approval_review_days, recordDays: r.approval_record_days, quarantineDays: r.scan_quarantine_days }
    : { ...DEFAULT_POLICY };
  return {
    ...periods,
    changedAt: r ? iso(r.changed_at) : null,
    changedBy: r?.changed_by_name ?? null,
    coverage,
    home,
    provisional: (coverage[home]?.provisional.length ?? REVIEW_SCOPE.length) > 0,
  };
}

export type PolicyRefusal = { ok: false; error: string; status: number };
const no = (error: string, status = 400): PolicyRefusal => ({ ok: false, error, status });

/** Every change, recorded review and lapse of the install's periods, newest first. */
export async function policyEvents(limit = 50): Promise<{ at: string | null; kind: string; by: string; detail: string }[]> {
  const rows = (await getDb()
    .prepare("SELECT at, kind, by_name, detail FROM retention_policy_events ORDER BY id DESC LIMIT ?")
    .all(limit)) as { at: unknown; kind: string; by_name: string; detail: string }[];
  return rows.map((r) => ({ at: iso(r.at), kind: r.kind, by: r.by_name, detail: r.detail }));
}

/** Set the periods and lapse every review in force, inside the caller's transaction. */
async function writePeriods(
  p: { documentDays: number; reviewDays: number; recordDays: number; quarantineDays: number },
  by: { id: number | null; name: string },
  detail: string,
  why: string
): Promise<void> {
  const db = getDb();
  await db
    .prepare(
      `UPDATE retention_policy SET approval_document_days = ?, approval_review_days = ?, approval_record_days = ?, scan_quarantine_days = ?,
         changed_at = now(), changed_by_name = ?, reviewed_on = NULL, reviewed_by = NULL, review_basis = NULL,
         review_recorded_by_name = NULL, review_recorded_at = NULL
        WHERE id = 1`
    )
    .run(p.documentDays, p.reviewDays, p.recordDays, p.quarantineDays, by.name);
  await db.prepare("UPDATE retention_policy_reviews SET lapsed_at = now(), lapse_reason = ? WHERE lapsed_at IS NULL").run(why);
  await db.prepare("INSERT INTO retention_policy_events (kind, admin_id, by_name, detail) VALUES ('changed', ?, ?, ?)").run(by.id, by.name, detail);
}

/**
 * Set the install's periods (the platform owner only). Each within its
 * bounds; the review window no longer than the documents' period. Any change
 * lapses every recorded review: the periods are provisional again until
 * reviewed. The change is also an entry in the erasure ledger (the periods
 * only), so a restore of an older backup applies these periods again.
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
  const periods = { documentDays, reviewDays, recordDays, quarantineDays };
  const detail = `Documents ${documentDays} days, review window ${reviewDays}, closed applications ${recordDays}, refused or unscannable documents ${quarantineDays} (was ${now.documentDays}, ${now.reviewDays}, ${now.recordDays}, ${now.quarantineDays})`;
  const ledger = await import("./erasure-ledger");
  let entry: { id: string } | null = null;
  await db.transaction(async () => {
    await writePeriods(periods, { id: admin.id, name: admin.name }, detail, `The periods changed to ${periodsOf(periods)}.`);
    entry = await ledger.recordLedgerEntry("retention_policy", { detail: JSON.stringify(periods) });
  })();
  if (entry) await ledger.appendToLedgerFile(entry);
  await logAction(admin, { venueId: null, action: "retention.policy", detail });
  return { ok: true, policy: await retentionPolicy() };
}

/**
 * After a restore (lib/erasure-ledger.ts): the newest periods the erasure
 * ledger records, put back where the restored copy has others, lapsing its
 * reviews as any change does. Returns whether anything changed.
 */
export async function applyPolicyFromLedger(detail: string): Promise<boolean> {
  let p: Record<string, unknown>;
  try {
    p = JSON.parse(detail) as Record<string, unknown>;
  } catch {
    return false;
  }
  const inBounds = (k: keyof typeof POLICY_BOUNDS) => Number.isInteger(p[k]) && (p[k] as number) >= POLICY_BOUNDS[k][0] && (p[k] as number) <= POLICY_BOUNDS[k][1];
  if (!(["documentDays", "reviewDays", "recordDays", "quarantineDays"] as const).every(inBounds) || (p.reviewDays as number) > (p.documentDays as number)) return false;
  const periods = { documentDays: p.documentDays as number, reviewDays: p.reviewDays as number, recordDays: p.recordDays as number, quarantineDays: p.quarantineDays as number };
  const now = await retentionPolicy();
  if (periodsOf(now) === periodsOf(periods)) return false;
  const db = getDb();
  await db.transaction(async () => {
    await writePeriods(
      periods,
      { id: null, name: "Restore (erasure ledger)" },
      `Put back after a restore, from the erasure ledger: ${periodsOf(periods)} (the restored copy had ${periodsOf(now)})`,
      "The periods were put back after a restore."
    );
  })();
  return true;
}

export interface ReviewInput {
  jurisdictions?: unknown;
  reviewerName?: unknown;
  reviewerRole?: unknown;
  firm?: unknown;
  scope?: unknown;
  reviewedOn?: unknown;
  adviceReference?: unknown;
  basis?: unknown;
}

const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** Who reviewed, on what authority as they state it, when, where the written advice is kept and on what basis. */
export interface ReviewProvenance {
  reviewerName: string;
  reviewerRole: string;
  firm: string;
  reviewedOn: string;
  adviceReference: string;
  basis: string;
}

/**
 * What every recorded review must say (this file's, and the e-invoice
 * period's: lib/einvoice-retention.ts), read and checked: the reviewer's
 * name, role or qualification and firm, a day today or earlier, a reference
 * to the written advice kept outside MySenam, and its basis.
 */
export function readReviewProvenance(input: ReviewInput): ReviewProvenance | PolicyRefusal {
  const reviewerName = text(input.reviewerName);
  if (reviewerName.length < 3 || reviewerName.length > 200) return no("Give the reviewer's name.");
  const reviewerRole = text(input.reviewerRole);
  if (reviewerRole.length < 3 || reviewerRole.length > 200) return no("Give the reviewer's role or qualification, as they state it.");
  const firm = text(input.firm);
  if (firm.length < 2 || firm.length > 200) return no("Give the reviewer's firm or organisation.");
  const reviewedOn = typeof input.reviewedOn === "string" ? input.reviewedOn : "";
  if (!isValidDateString(reviewedOn) || reviewedOn > todayISO()) return no("Give the day of the review: today or earlier.");
  const adviceReference = text(input.adviceReference);
  if (adviceReference.length < 3 || adviceReference.length > 200) return no("Give a reference to the written advice, kept outside MySenam.");
  const basis = text(input.basis);
  if (basis.length < 10 || basis.length > 2000) return no("Say what the review was based on, in a sentence or two.");
  return { reviewerName, reviewerRole, firm, reviewedOn, adviceReference, basis };
}

/**
 * Record a review of the install's periods (the platform owner records it):
 * one row for each jurisdiction it covers, each saying who reviewed them and
 * on what authority as they state it, their firm, which periods it covers,
 * the day (on or after the periods were last set, and not in the future), a
 * reference to the written advice kept outside MySenam, and what it was
 * based on. It is what the reviewer advised, as recorded by the owner: the
 * app does not decide whether the periods meet any law, and does not call
 * them approved.
 */
export async function recordPolicyReview(admin: Admin, input: ReviewInput): Promise<{ ok: true; policy: RetentionPolicy } | PolicyRefusal> {
  if (!isOwner(admin)) return no("Only the platform owner can record the review of the retention periods.", 403);
  const jurisdictions = Array.isArray(input.jurisdictions) ? [...new Set(input.jurisdictions)] : [];
  if (jurisdictions.length === 0 || !jurisdictions.every((j) => (JURISDICTIONS as readonly unknown[]).includes(j)))
    return no("Say which jurisdiction the review covers: Malaysia (MY), Singapore (SG), or each.");
  const scope = Array.isArray(input.scope) ? [...new Set(input.scope)] : [];
  if (scope.length === 0 || !scope.every((s) => (REVIEW_SCOPE as readonly unknown[]).includes(s)))
    return no("Say which periods the review covers.");
  const given = readReviewProvenance(input);
  if ("ok" in given) return given;
  const { reviewerName, reviewerRole, firm, reviewedOn, adviceReference, basis } = given;
  const now = await retentionPolicy();
  // The change's date where the install is, as the review's date is (todayISO), not the UTC date of the moment.
  if (now.changedAt && reviewedOn < localDateOf(now.changedAt)) return no("The review is dated before the periods were last changed: it cannot have reviewed these periods.");
  const db = getDb();
  const periods = periodsOf(now);
  const covered = (scope as ScopeKey[]).sort((a, b) => REVIEW_SCOPE.indexOf(a) - REVIEW_SCOPE.indexOf(b));
  const detail = `Review recorded (not verified by MySenam) for ${jurisdictions.join(" and ")}: ${reviewerName} (${reviewerRole}), ${firm}, on ${reviewedOn}, covering ${covered.join(", ")} at ${periods}; written advice ${adviceReference}: ${basis}`;
  await db.transaction(async () => {
    for (const j of jurisdictions)
      await db
        .prepare(
          `INSERT INTO retention_policy_reviews (jurisdiction, reviewer_name, reviewer_role, firm, scope, reviewed_on, advice_reference, basis, periods, recorded_by_admin_id, recorded_by_name)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(j, reviewerName, reviewerRole, firm, covered.join(","), reviewedOn, adviceReference, basis, periods, admin.id, admin.name);
    await db.prepare("INSERT INTO retention_policy_events (kind, admin_id, by_name, detail) VALUES ('reviewed', ?, ?, ?)").run(admin.id, admin.name, detail.slice(0, 3000));
  })();
  await logAction(admin, { venueId: null, action: "retention.reviewed", detail: detail.slice(0, 500) });
  return { ok: true, policy: await retentionPolicy() };
}
