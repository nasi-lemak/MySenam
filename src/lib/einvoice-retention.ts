import { logAction } from "./activity";
import { isOwner, type Admin } from "./admin-auth";
import { getDb } from "./db";
import { readReviewProvenance, type PolicyRefusal, type ReviewInput, type ReviewProvenance } from "./retention-policy";
import { localDateOf } from "./time";

/**
 * How long e-invoice records are kept: the install's one setting, in years
 * from each document's issue (docs/architecture/privacy.md#e-invoice-records;
 * migrations 0225–0226).
 *
 * The owner's decision of 28 October 2026: "Retain legally required
 * e-invoice records for the applicable statutory period, generally seven
 * years where relevant, with legal verification pending. Keep optional
 * customer-profile data separate." So the default is 7 years, **provisional**:
 * the owner's reading of Malaysia's record-keeping period, not a verified
 * legal answer. Nothing here says it satisfies any law.
 *
 * The floor is the same 7 years. The platform owner may keep them longer
 * (up to 20) at any time; a shorter period (down to 5) is set only together
 * with a recorded review saying who advised it: the same provenance as a
 * review of the application periods (lib/retention-policy.ts
 * `readReviewProvenance`), the platform owner's record of what a reviewer
 * advised, never a verification by MySenam. A review may also be recorded
 * for the period as it stands. Changing the period lapses the review in
 * force. Every change, review and lapse goes in `retention_policy_events`
 * beside the application periods' own, never pruned, and in the staff
 * activity log.
 *
 * What happens when the period has passed is the retention run's
 * (lib/myinvois.ts `pruneEInvoices`), through the one exception the
 * database's trigger allows (migration 0226), which reads the period from
 * the same row.
 */

export const EINVOICE_YEARS_DEFAULT = 7;
/** Below this only with a recorded review. */
export const EINVOICE_YEARS_FLOOR = 7;
/** What the period may be at all (the database holds the same bounds). */
export const EINVOICE_YEARS_BOUNDS = [5, 20] as const;

export interface EInvoiceRetentionReview {
  jurisdiction: "MY" | "SG";
  reviewerName: string;
  /** Their role or qualification, as they state it: not checked by MySenam. */
  reviewerRole: string;
  firm: string;
  reviewedOn: string;
  /** Where the written advice is kept, outside MySenam. */
  adviceReference: string;
  basis: string;
  recordedBy: string;
  recordedAt: string | null;
}

export interface EInvoiceRetention {
  years: number;
  floor: number;
  bounds: readonly [number, number];
  /** No review in force: the period is the owner's provisional choice, pending legal verification. */
  provisional: boolean;
  review: EInvoiceRetentionReview | null;
  changedAt: string | null;
  changedBy: string | null;
}

interface Row {
  years: number;
  changed_at: unknown;
  changed_by_name: string | null;
  review_jurisdiction: "MY" | "SG" | null;
  reviewer_name: string | null;
  reviewer_role: string | null;
  review_firm: string | null;
  reviewed_on: string | null;
  advice_reference: string | null;
  review_basis: string | null;
  review_recorded_by_name: string | null;
  review_recorded_at: unknown;
}

const iso = (v: unknown): string | null => (v instanceof Date ? v.toISOString() : v === null || v === undefined ? null : String(v));
const no = (error: string, status = 400): PolicyRefusal => ({ ok: false, error, status });

/** The period as it stands, with the review in force. */
export async function einvoiceRetention(): Promise<EInvoiceRetention> {
  const r = (await getDb().prepare("SELECT * FROM einvoice_retention WHERE id = 1").get()) as Row | undefined;
  const review: EInvoiceRetentionReview | null =
    r?.reviewer_name && r.review_jurisdiction
      ? {
          jurisdiction: r.review_jurisdiction,
          reviewerName: r.reviewer_name,
          reviewerRole: r.reviewer_role ?? "",
          firm: r.review_firm ?? "",
          reviewedOn: r.reviewed_on ?? "",
          adviceReference: r.advice_reference ?? "",
          basis: r.review_basis ?? "",
          recordedBy: r.review_recorded_by_name ?? "",
          recordedAt: iso(r.review_recorded_at),
        }
      : null;
  return {
    years: r ? Number(r.years) : EINVOICE_YEARS_DEFAULT,
    floor: EINVOICE_YEARS_FLOOR,
    bounds: EINVOICE_YEARS_BOUNDS,
    provisional: review === null,
    review,
    changedAt: r ? iso(r.changed_at) : null,
    changedBy: r?.changed_by_name ?? null,
  };
}

const describe = (r: Pick<EInvoiceRetentionReview, "jurisdiction" | "reviewerName" | "reviewerRole" | "firm" | "reviewedOn" | "adviceReference" | "basis">, years: number) =>
  `E-invoice records: review recorded (not verified by MySenam) for ${r.jurisdiction}: ${r.reviewerName} (${r.reviewerRole}), ${r.firm}, on ${r.reviewedOn}, covering ${years} years; written advice ${r.adviceReference}: ${r.basis}`;

/** Record the review in force, inside the caller's transaction. */
async function writeReview(admin: Admin, review: Omit<EInvoiceRetentionReview, "recordedBy" | "recordedAt">, years: number): Promise<string> {
  const db = getDb();
  await db
    .prepare(
      `UPDATE einvoice_retention SET review_jurisdiction = ?, reviewer_name = ?, reviewer_role = ?, review_firm = ?, reviewed_on = ?,
         advice_reference = ?, review_basis = ?, review_recorded_by_name = ?, review_recorded_at = now() WHERE id = 1`
    )
    .run(review.jurisdiction, review.reviewerName, review.reviewerRole, review.firm, review.reviewedOn, review.adviceReference, review.basis, admin.name);
  const detail = describe(review, years).slice(0, 3000);
  await db.prepare("INSERT INTO retention_policy_events (kind, admin_id, by_name, detail) VALUES ('reviewed', ?, ?, ?)").run(admin.id, admin.name, detail);
  return detail;
}

export type EInvoiceRetentionInput = { years?: unknown; review?: unknown };

/**
 * Set how many years e-invoice records are kept (the platform owner only).
 * Longer, within the bounds, at any time; shorter than the floor only with
 * a review recorded with it (`review`: who advised it, as for any recorded
 * review), which is then the review in force. Any change lapses the review
 * that was in force.
 */
export async function setEInvoiceRetention(admin: Admin, input: EInvoiceRetentionInput): Promise<{ ok: true; retention: EInvoiceRetention } | PolicyRefusal> {
  if (!isOwner(admin)) return no("Only the platform owner can change how long e-invoice records are kept.", 403);
  const years = Number(input.years);
  const [min, max] = EINVOICE_YEARS_BOUNDS;
  if (!Number.isInteger(years) || years < min || years > max) return no(`E-invoice records are kept ${min} to ${max} years.`);
  const now = await einvoiceRetention();
  if (years === now.years) return { ok: true, retention: now };
  let review: ReviewProvenance | null = null;
  if (years < EINVOICE_YEARS_FLOOR) {
    if (!input.review || typeof input.review !== "object")
      return no(`Keeping e-invoice records less than ${EINVOICE_YEARS_FLOOR} years needs a recorded review: who advised it, their firm, the day and where the written advice is kept.`);
    const given = readReviewProvenance(input.review as ReviewInput);
    if ("ok" in given) return given;
    review = given;
  }
  const db = getDb();
  const detail = `E-invoice records kept ${years} years from issue (was ${now.years})`;
  let reviewed: string | null = null;
  await db.transaction(async () => {
    await db.prepare("UPDATE einvoice_retention SET years = ?, changed_at = now(), changed_by_name = ? WHERE id = 1").run(years, admin.name);
    if (now.review) {
      await db
        .prepare(
          `UPDATE einvoice_retention SET review_jurisdiction = NULL, reviewer_name = NULL, reviewer_role = NULL, review_firm = NULL, reviewed_on = NULL,
             advice_reference = NULL, review_basis = NULL, review_recorded_by_name = NULL, review_recorded_at = NULL WHERE id = 1`
        )
        .run();
      await db
        .prepare("INSERT INTO retention_policy_events (kind, admin_id, by_name, detail) VALUES ('lapsed', ?, ?, ?)")
        .run(admin.id, admin.name, `E-invoice records: the review by ${now.review.reviewerName}, ${now.review.firm} lapsed: the period changed to ${years} years.`);
    }
    await db.prepare("INSERT INTO retention_policy_events (kind, admin_id, by_name, detail) VALUES ('changed', ?, ?, ?)").run(admin.id, admin.name, detail);
    if (review) reviewed = await writeReview(admin, { jurisdiction: "MY", ...review }, years);
  })();
  await logAction(admin, { venueId: null, action: "einvoice.retention", detail });
  if (reviewed !== null) await logAction(admin, { venueId: null, action: "einvoice.retention_reviewed", detail: String(reviewed).slice(0, 500) });
  return { ok: true, retention: await einvoiceRetention() };
}

/**
 * Record a review of the period as it stands (the platform owner records
 * it): the same provenance as any recorded review, dated on or after the
 * period was last changed. The owner's record of what a reviewer advised;
 * the app does not decide whether the period meets any law.
 */
export async function recordEInvoiceRetentionReview(
  admin: Admin,
  input: ReviewInput & { jurisdiction?: unknown }
): Promise<{ ok: true; retention: EInvoiceRetention } | PolicyRefusal> {
  if (!isOwner(admin)) return no("Only the platform owner can record the review of how long e-invoice records are kept.", 403);
  const jurisdiction = input.jurisdiction === undefined ? "MY" : input.jurisdiction;
  if (jurisdiction !== "MY" && jurisdiction !== "SG") return no("Say which jurisdiction the review covers: Malaysia (MY) or Singapore (SG).");
  const given = readReviewProvenance(input);
  if ("ok" in given) return given;
  const now = await einvoiceRetention();
  if (now.changedAt && given.reviewedOn < localDateOf(now.changedAt))
    return no("The review is dated before the period was last changed: it cannot have reviewed this period.");
  let detail = "";
  await getDb().transaction(async () => {
    detail = await writeReview(admin, { jurisdiction, ...given }, now.years);
  })();
  await logAction(admin, { venueId: null, action: "einvoice.retention_reviewed", detail: detail.slice(0, 500) });
  return { ok: true, retention: await einvoiceRetention() };
}
