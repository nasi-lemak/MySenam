/**
 * Youth messaging: the one launch switch, and the operational periods of the interim safeguards (docs/features/player-messages.md
 * #interim-safeguards-pending-legal-review; docs/operations/legal-review-youth-messaging.md; ADR 0052).
 *
 * The owner approved an **interim** product and safety direction, subject to review by qualified Malaysian legal and child-safeguarding professionals
 * **before live youth messaging is enabled**. Nothing in this file, or in anything it governs, settles a legal question: every period here is an
 * operational default, never a legal period, and every standard is labelled as pending legal review.
 */

/** The label kept next to every authority decision: what standard it was recorded to. Not a legal test. */
export const INTERIM_STANDARD = "interim: pending legal review";

/**
 * Whether youth messaging is on for this install. **Off in production unless `YOUTH_MESSAGING_LAUNCH_APPROVED=yes`**; on in development and tests, so
 * local work and the suites run. Read on every call. When it is off no group can be marked a youth group, no minor has a seat anywhere, no youth thread
 * can be read or written, and what is stored is shown to nobody but safeguarding administrators, for open cases; adults' messaging is unaffected.
 */
export function youthMessagingEnabled(): boolean {
  if (process.env.NODE_ENV !== "production") return true;
  return process.env.YOUTH_MESSAGING_LAUNCH_APPROVED === "yes";
}

/** The plain sentence every screen says when youth messaging is off (the dictionaries hold it in every language as `err.YG_OFF`). */
export const YOUTH_OFF_SENTENCE = "Youth messaging is not enabled on this install: it needs safeguarding and legal approval first.";

const wholeDays = (name: string, fallback: number, min: number, max: number): number => {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

/** Days an authority conflict (or an objection) may stay unresolved before an authority review opens: YOUTH_REVIEW_DAYS, 7 by default, within 1 to 90. Operational, not a legal period. */
export const youthReviewDays = (): number => wholeDays("YOUTH_REVIEW_DAYS", 7, 1, 90);

/** Days a protective restriction may stand before it must be reviewed: YOUTH_PROTECTIVE_REVIEW_DAYS, 7 by default, within 1 to 90. Operational, not a legal period. */
export const protectiveReviewDays = (): number => wholeDays("YOUTH_PROTECTIVE_REVIEW_DAYS", 7, 1, 90);

/**
 * Days after which a **closed** case's evidence and case actions are deleted, **only if the install sets `SAFEGUARDING_EVIDENCE_RETENTION_DAYS`**
 * (which needs legal approval before it is set). Unset (or not a whole number of at least 30): null, and nothing of the kind is ever deleted by the retention job.
 */
export function safeguardingEvidenceRetentionDays(): number | null {
  const raw = process.env.SAFEGUARDING_EVIDENCE_RETENTION_DAYS;
  if (raw === undefined || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 30 && n <= 36_500 ? n : null;
}

/** Months a closed case (or a hold) may be kept before the platform's owner is asked to decide, not delete: SAFEGUARDING_REVIEW_MONTHS, 12 by default, within 1 to 120. */
export const safeguardingReviewMonths = (): number => wholeDays("SAFEGUARDING_REVIEW_MONTHS", 12, 1, 120);
