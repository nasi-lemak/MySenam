/**
 * SQL for what is evidence, and what is still an active case, in a supervised youth group (ADR 0052; docs/architecture/privacy.md#youth-messaging-evidence).
 * A leaf of its own, importing nothing, so the retention job and the erasure code can use it without a cycle.
 *
 * Four classes are kept apart (docs/architecture/privacy.md): (a) ordinary message retention (operational defaults pending legal approval), (b) safeguarding
 * evidence (the frozen copy of a report, case actions, escalations, review items), (c) audit records (the safeguarding event store, activity entries
 * about youth messaging) and (d) records under a legal hold. Only (a) has a default period; (b) and (c) are never deleted automatically.
 */

/** Group ids in which a case is active: a report open, or a protective restriction in force, or an authority review or an appeal open, or a legal hold in force. */
export const ACTIVE_CASE_GROUPS = `SELECT r.context_id FROM player_message_reports r
   WHERE r.urgent = 1 AND r.context_kind = 'group' AND (r.status = 'open' OR EXISTS (SELECT 1 FROM youth_thread_mutes rm WHERE rm.report_id = r.id AND rm.lifted_at IS NULL))
 UNION SELECT group_id FROM youth_thread_mutes WHERE source = 'report' AND lifted_at IS NULL
 UNION SELECT group_id FROM youth_authority_reviews WHERE closed_at IS NULL
 UNION SELECT pa.group_id FROM youth_restriction_appeals pa JOIN youth_thread_mutes pm ON pm.id = pa.mute_id WHERE pa.status = 'open' AND pm.lifted_at IS NULL
 UNION SELECT group_id FROM youth_evidence_holds WHERE released_at IS NULL`;

/**
 * Reports whose evidence copy is under a legal hold (class (d)): a hold on the case, or on a child and group (every youth report of that group:
 * conservative, so a hold never leaves a related report to be deleted). Retention and erasure leave them as they are.
 */
export const LEGAL_HELD_REPORTS = `SELECT lr.id FROM player_message_reports lr
   WHERE lr.context_kind = 'group' AND EXISTS (
     SELECT 1 FROM youth_evidence_holds h WHERE h.released_at IS NULL
        AND ((h.scope_kind = 'case' AND h.report_id = lr.id) OR (h.scope_kind = 'child_group' AND h.group_id = lr.context_id)))`;

/** A short text with a run of digits long enough to be an identity, case or document number: refused wherever a reference or a note is kept. */
export const hasNumberRun = (text: string): boolean => /\d[\d\s-]{5,}\d/.test(text);
