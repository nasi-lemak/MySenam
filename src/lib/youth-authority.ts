import { getDb, withTransaction } from "./db";
import { logAction } from "./activity";
import type { Admin } from "./admin-auth";
import { inScope, scopeOf } from "./message-moderation";
import { adminIsAccusedIn, adminIsGuardianOrSupervisor, guardianStaffEmails } from "./safeguarding-conflict";
import { shortName } from "./public-names";
import { staffSentences, tellOwnersEach } from "./owner-alerts";
import { consentEvent, lockConsentState, needsAgreement, youthGroupsOfMember, type AuthorityLevel } from "./youth-consent";
import { youthReviewDays } from "./youth-launch";
import { refuseYouth, youthGroupOf, type YouthRefusal } from "./youth-messages";

/**
 * Custody and authority as a recorded decision with its basis, status and restrictions (docs/features/player-messages.md
 * #custody-and-authority-a-recorded-decision; ADR 0052, which amends ADR 0049), and the **authority review** that follows when a link is disputed or unclear.
 *
 * **MySenam does not interpret custody orders or make legal determinations.** An operator records *that* they verified something and on what basis; the app
 * applies that recorded decision and nothing more. No custody order, identity number or other document is collected or stored: the supporting record, if
 * there is one, is held by the venue under its own controls. Who may verify is a pending legal question; the interim rule (a venue's manager for a child the
 * venue manages, and the platform's owner, never a supervisor, never a guardian of the child, never staff who are the same person as one) is labelled as such.
 */

export const AUTHORITY_STATUSES = ["asserted", "verified", "disputed", "unclear"] as const;
export type AuthorityStatus = (typeof AUTHORITY_STATUSES)[number];
export const AUTHORITY_BASES = ["parent", "legal_guardian", "other_authorised", "not_stated"] as const;
export type AuthorityBasis = (typeof AUTHORITY_BASES)[number];
export const AUTHORITY_RESTRICTIONS = ["none", "may_object_only", "no_messaging_say"] as const;
export type AuthorityRestriction = (typeof AUTHORITY_RESTRICTIONS)[number];

/**
 * What a recorded decision comes to. **A restriction that removes a guardian's say takes effect only on a `verified` decision**: an asserted one (the
 * venue's or the guardian's word) sets the link to `unclear` instead and the guardian keeps their say, with youth messaging for the child off until it is
 * reviewed. `disputed` and `unclear` also keep it off (lib/youth-consent.ts `authorityHoldSql`), whatever the restriction.
 */
export function effectiveDecision(status: AuthorityStatus, restriction: AuthorityRestriction): { status: AuthorityStatus; level: AuthorityLevel } {
  if (restriction === "none") return { status, level: "decides" };
  if (status === "verified") return { status, level: restriction === "may_object_only" ? "objects_only" : "none" };
  return { status: status === "asserted" ? "unclear" : status, level: "decides" };
}

/** The old three-level words, as the restrictions that say the same. */
export const restrictionOfLevel = (level: AuthorityLevel): AuthorityRestriction => (level === "objects_only" ? "may_object_only" : level === "none" ? "no_messaging_say" : "none");

// ------------------------------------------------------------------ opening reviews

/** Opens an authority review for the child in each youth group they are in that has none open (inside a transaction or not). Returns how many opened. */
export async function openAuthorityReviews(minorId: number, cause: "disputed" | "unclear" | "conflict_unresolved", opts: { onlyGroups?: number[]; quietDays?: number } = {}): Promise<number> {
  const db = getDb();
  let opened = 0;
  for (const g of opts.onlyGroups ?? (await youthGroupsOfMember(minorId))) {
    if (opts.quietDays !== undefined) {
      const recent = await db
        .prepare(`SELECT 1 FROM youth_authority_reviews WHERE group_id = ? AND minor_user_id = ? AND (closed_at IS NULL OR closed_at > datetime('now', '-${opts.quietDays} days'))`)
        .get(g, minorId);
      if (recent) continue;
    }
    const made = await db
      .prepare("INSERT INTO youth_authority_reviews (group_id, minor_user_id, cause) VALUES (?, ?, ?) ON CONFLICT DO NOTHING RETURNING id")
      .get(g, minorId, cause);
    if (made) {
      opened += 1;
      await consentEvent(g, "system", "authority_review_opened", { minorId, detail: `cause ${cause}` });
    }
  }
  return opened;
}

/**
 * From the scheduler: opens an authority review for a child and group where a guardian link is disputed or unclear (and none is open, nor was one closed
 * within `YOUTH_REVIEW_DAYS`: a review that ended "remains unclear" is looked at again after that interval), and where a guardian conflict (an objection) has
 * stayed unresolved beyond `YOUTH_REVIEW_DAYS`. The period is operational, not a legal one. Safe to repeat.
 */
export async function authorityHousekeeping(): Promise<number> {
  const db = getDb();
  const days = youthReviewDays();
  let opened = 0;
  const held = (await db
    .prepare(
      `SELECT DISTINCT pt.linked_user_id AS minor, g.authority_status AS status FROM participants pt JOIN participant_guardians g ON g.participant_id = pt.id
        WHERE pt.linked_user_id IS NOT NULL AND g.revoked_at IS NULL AND g.archived_at IS NULL AND g.authority_status IN ('disputed', 'unclear')`
    )
    .all()) as { minor: number; status: "disputed" | "unclear" }[];
  for (const h of held) opened += await openAuthorityReviews(h.minor, h.status, { quietDays: days });
  const objections = (await db
    .prepare(`SELECT group_id, minor_user_id FROM youth_message_objections WHERE closed_at IS NULL AND created_at < datetime('now', '-${days} days')`)
    .all()) as { group_id: number; minor_user_id: number }[];
  for (const o of objections) {
    if (!(await needsAgreement(o.group_id, o.minor_user_id))) continue;
    opened += await openAuthorityReviews(o.minor_user_id, "conflict_unresolved", { onlyGroups: [o.group_id], quietDays: days });
  }
  return opened;
}

// ------------------------------------------------------------------ what a safeguarding administrator sees and does

export interface AuthorityReview {
  id: number;
  groupId: number;
  groupName: string;
  /** The child by their short name, as every public surface shows a child. */
  child: string;
  cause: "disputed" | "unclear" | "conflict_unresolved";
  openedAt: string;
  escalated: boolean;
  /** Each live guardian link of the child: what an operator recorded. For safeguarding administrators only. */
  guardians: { guardianshipId: number; name: string; status: AuthorityStatus; basis: AuthorityBasis; restrictions: AuthorityRestriction; standard: string | null; decidedBy: string | null; decidedAt: string | null }[];
}

interface ReviewRow {
  id: number;
  group_id: number;
  minor_user_id: number;
  cause: AuthorityReview["cause"];
  opened_at: string;
  escalated_at: string | null;
  group_name: string;
  child_name: string;
}

const firstName = (name: string): string => name.trim().split(/\s+/)[0] ?? name;

/** The review, if it is this staff member's: in the group's scope (or escalated to the owner), and not a guardian or supervisor of the child, nor named by a report in the group. */
async function reviewFor(admin: Admin, id: number): Promise<ReviewRow | null> {
  const r = (await getDb()
    .prepare(
      `SELECT v.id, v.group_id, v.minor_user_id, v.cause, v.opened_at, v.escalated_at, g.name AS group_name, u.name AS child_name
         FROM youth_authority_reviews v JOIN community_groups g ON g.id = v.group_id JOIN users u ON u.id = v.minor_user_id WHERE v.id = ? AND v.closed_at IS NULL`
    )
    .get(id)) as ReviewRow | undefined;
  if (!r) return null;
  const y = await youthGroupOf(r.group_id);
  if (!y) return null;
  const scope = scopeOf(admin);
  if (!(inScope(scope, y.venueId) || (scope.owner && r.escalated_at !== null))) return null;
  if ((await adminIsAccusedIn(admin, r.group_id)) || (await adminIsGuardianOrSupervisor(admin, r.group_id, r.minor_user_id))) return null;
  return r;
}

/** The open authority reviews that are this staff member's. Each reading is not separately logged: the list shows no message and no document. */
export async function listAuthorityReviews(admin: Admin): Promise<AuthorityReview[]> {
  const db = getDb();
  const ids = (await db.prepare("SELECT id FROM youth_authority_reviews WHERE closed_at IS NULL ORDER BY id").all()) as { id: number }[];
  const out: AuthorityReview[] = [];
  for (const { id } of ids) {
    const r = await reviewFor(admin, id);
    if (!r) continue;
    const guardians = (await db
      .prepare(
        `SELECT g.id, u.name, g.authority_status, g.authority_basis, g.authority_restrictions, g.authority_standard, g.messaging_authority_by, g.messaging_authority_at
           FROM participants pt JOIN participant_guardians g ON g.participant_id = pt.id LEFT JOIN users u ON u.id = g.user_id
          WHERE pt.linked_user_id = ? AND g.revoked_at IS NULL AND g.archived_at IS NULL ORDER BY g.id`
      )
      .all(r.minor_user_id)) as {
      id: number; name: string | null; authority_status: AuthorityStatus; authority_basis: AuthorityBasis; authority_restrictions: AuthorityRestriction; authority_standard: string | null;
      messaging_authority_by: string | null; messaging_authority_at: string | null;
    }[];
    out.push({
      id: r.id,
      groupId: r.group_id,
      groupName: r.group_name,
      child: shortName(r.child_name),
      cause: r.cause,
      openedAt: r.opened_at,
      escalated: r.escalated_at !== null,
      guardians: guardians.map((g) => ({
        guardianshipId: g.id, name: firstName(g.name ?? ""), status: g.authority_status, basis: g.authority_basis, restrictions: g.authority_restrictions, standard: g.authority_standard,
        decidedBy: g.messaging_authority_by, decidedAt: g.messaging_authority_at,
      })),
    });
  }
  return out;
}

/**
 * Closes an authority review with an outcome and a reason: **resolved** (messaging is no longer held off for this child and group: no link is disputed or
 * unclear and no guardian conflict waits) or **remains unclear** (it stays off; it is looked at again after `YOUTH_REVIEW_DAYS`). Recording a verified
 * decision is the other action (lib/youth-safeguarding.ts `staffSetGuardianAuthority`). Not found for a review that is not theirs.
 */
export async function closeAuthorityReview(admin: Admin, id: unknown, outcome: unknown, reasonRaw: unknown): Promise<{ ok: true } | YouthRefusal> {
  const reason = typeof reasonRaw === "string" && reasonRaw.trim().length >= 3 ? reasonRaw.trim().replace(/\s+/g, " ").slice(0, 300) : null;
  if (!Number.isInteger(id)) return refuseYouth("YG_REVIEW");
  const first = await reviewFor(admin, id as number);
  if (!first) return refuseYouth("YG_REVIEW");
  if (outcome !== "resolved" && outcome !== "remains_unclear") return refuseYouth("YG_OUTCOME");
  if (!reason) return refuseYouth("YG_REASON");
  const done = await withTransaction(async (): Promise<{ ok: true } | YouthRefusal> => {
    await lockConsentState([first.group_id], first.minor_user_id);
    if (outcome === "resolved" && (await needsAgreement(first.group_id, first.minor_user_id))) return refuseYouth("YG_REVIEW_OPEN");
    const closed = await getDb()
      .prepare("UPDATE youth_authority_reviews SET closed_at = datetime('now'), outcome = ?, closed_by = ?, close_reason = ? WHERE id = ? AND closed_at IS NULL")
      .run(outcome, admin.name, reason, first.id);
    if (closed.changes === 0) return refuseYouth("YG_REVIEW");
    await consentEvent(first.group_id, "staff", "authority_review_closed", { minorId: first.minor_user_id, detail: `review ${first.id}: ${outcome}` });
    return { ok: true as const };
  });
  if (!done.ok) return done;
  const y = await youthGroupOf(first.group_id);
  await logAction(admin, { venueId: y?.venueId ?? null, action: "messages.youth_authority_review", detail: `Supervised youth group ${first.group_id}, review ${first.id}: ${outcome}` });
  return { ok: true };
}

/**
 * Escalates an authority review to the platform's owner (a safeguarding notice to the owners, never naming a child or a guardian: only the group and the review
 * number). The owner then sees the review as well. A review already with the owner, or the owner's own, cannot be escalated again.
 */
export async function escalateAuthorityReview(admin: Admin, id: unknown): Promise<{ ok: true } | YouthRefusal> {
  if (!Number.isInteger(id)) return refuseYouth("YG_REVIEW");
  const r = await reviewFor(admin, id as number);
  if (!r) return refuseYouth("YG_REVIEW");
  if (scopeOf(admin).owner || r.escalated_at !== null) return refuseYouth("YG_ESCALATED");
  const done = await getDb().prepare("UPDATE youth_authority_reviews SET escalated_at = datetime('now'), escalated_by = ? WHERE id = ? AND escalated_at IS NULL").run(admin.name, r.id);
  if (done.changes === 0) return refuseYouth("YG_ESCALATED");
  await consentEvent(r.group_id, "staff", "authority_review_escalated", { minorId: r.minor_user_id, detail: `review ${r.id}` });
  try {
    await tellOwnersEach(
      (t) => ({ subject: t("msg4.mail.reviewSubject", { group: r.group_name }), body: staffSentences(t, t("msg4.mail.reviewEscalated", { group: r.group_name, id: r.id })) }),
      { exceptEmails: await guardianStaffEmails(r.minor_user_id), kind: "safeguarding_notice" }
    );
  } catch (err) {
    console.error("[mysenam] could not queue a safeguarding notice:", err instanceof Error ? err.message : "unknown error");
  }
  const y = await youthGroupOf(r.group_id);
  await logAction(admin, { venueId: y?.venueId ?? null, action: "messages.youth_authority_review", detail: `Supervised youth group ${r.group_id}, review ${r.id}: escalated to the platform's owner` });
  return { ok: true };
}
