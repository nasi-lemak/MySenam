import { getDb, withTransaction } from "./db";
import type { Admin } from "./admin-auth";
import { inScope, scopeOf, type Refused, type ReportLine } from "./message-moderation";
import { baseUrl, emailPlayer } from "./outbox";
import { declaredAdult } from "./player-profiles";
import { namesTheViewerSql, staffEmailsOf } from "./safeguarding-conflict";
import { siteName } from "./site";
import { staffSentences, tellOwnersEach } from "./owner-alerts";
import type { SeatLabel } from "./message-contexts";
import { consentEvent } from "./youth-consent";
import { protectiveReviewDays } from "./youth-launch";

/**
 * The case a report in a youth group's thread becomes for safeguarding personnel (docs/features/player-messages.md#a-reported-adult-is-not-told;
 * ADR 0049).
 *
 * A report in a youth thread is a **protective** measure, not a finding: the person it names is restricted at once (a hold, shown to them as one
 * neutral line), the report goes to safeguarding personnel only (the venue's managers, or the platform's owner for a group with no venue, never the
 * person reported nor a member of staff who is the same person: `lib/safeguarding-conflict.ts`), and the evidence (the frozen copy of the last
 * messages) is read only here, **each read recorded**. What safeguarding personnel may do:
 *
 * - **confirm** that the restriction stands, **extend** it (put it back in force, and have it continue past the report's review), **lift** it, each
 *   with a reason;
 * - **escalate** to the platform's owner (recorded; the owner then sees the report as well);
 * - **escalate for safeguarding** (suspected abuse, imminent danger, a possibly legally reportable incident, or other): the owner is told at once, and who, when
 *   and why are recorded in the case. Nothing is sent to any authority by MySenam; the case shows a static guidance panel (ADR 0052);
 * - **convert the restriction to a decision** (a moderator's recorded outcome with its reason): a protective restriction is temporary and **not a finding**, a
 *   decision is the moderator's recorded outcome; either is reviewed, and a protective one passing its review date unreviewed is escalated to the owner and
 *   never lifted or converted by itself (lib/youth-restrictions.ts);
 * - add a **note**;
 * - **notify** the reported adult: the one way they are ever told, written by the moderator, never automatic, never naming who reported or repeating
 *   what was reported.
 *
 * Every step is written to `youth_report_actions` (who, what, when, why: never a message's text), apart from the staff activity log, which a
 * reported member of staff can read.
 */

const STEPS = ["confirm", "extend", "lift", "escalate", "note", "notify", "decide", "safeguarding"] as const;

/** Why a moderator escalates a case for safeguarding. A fixed choice: nothing else is asked, and nothing legal is decided here. */
export const ESCALATION_KINDS = ["suspected_abuse", "imminent_danger", "possible_reportable_incident", "other"] as const;
export type EscalationKind = (typeof ESCALATION_KINDS)[number];

/** What a moderator may record a restriction on a reported adult as, when it becomes a decision. */
export const DECISION_OUTCOMES = ["removed_from_group", "messaging_suspended"] as const;
export type DecisionOutcome = (typeof DECISION_OUTCOMES)[number];
type Step = (typeof STEPS)[number];

const no = (error: string, status = 400): Refused => ({ ok: false, error, status });
const NOT_HERE = (): Refused => no("That report is not here.", 404);
const clean = (raw: unknown, min: number, max: number): string | null => (typeof raw === "string" && raw.trim().length >= min ? raw.trim().replace(/[ \t]+/g, " ").slice(0, max) : null);

const parseLabel = (raw: string | null): SeatLabel | null => {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as SeatLabel;
    return v && typeof v === "object" ? v : null;
  } catch {
    return null;
  }
};

/** What was done about a report: who, what, when. Nothing of a message's text; a note or a notification is what the moderator wrote. */
export async function caseAudit(reportId: number, groupId: number, actor: string, action: string, detail: string | null = null): Promise<void> {
  await getDb().prepare("INSERT INTO youth_report_actions (report_id, group_id, action, actor_name, detail) VALUES (?, ?, ?, ?, ?)").run(reportId, groupId, action, actor, detail?.slice(0, 1000) ?? null);
}

interface CaseRow {
  id: number;
  created_at: string;
  status: "open" | "reviewed";
  outcome: string | null;
  reason: string;
  context_id: number;
  venue_id: number | null;
  thread_id: number | null;
  reporter_label: string | null;
  reported_label: string | null;
  reporter_id: number | null;
  reported_id: number | null;
  reviewed_by_name: string | null;
  reviewed_at: string | null;
  escalated_at: string | null;
  escalated_by: string | null;
  escalation_reason: string | null;
  note: string | null;
}

/** The report, if it is a youth report this staff member may deal with: in their scope (or escalated to the owner) and not naming them. Otherwise it is not here. */
export async function caseFor(admin: Admin, id: number, lock = false): Promise<CaseRow | null> {
  const scope = scopeOf(admin);
  const names = namesTheViewerSql("r", admin);
  const r = (await getDb()
    .prepare(
      `SELECT r.id, r.created_at, r.status, r.outcome, r.reason, r.context_id, r.venue_id, r.thread_id, r.reporter_label, r.reported_label, r.reporter_id, r.reported_id,
              r.reviewed_by_name, r.reviewed_at, r.escalated_at, r.escalated_by, r.escalation_reason, r.note
         FROM player_message_reports r WHERE r.id = ? AND r.urgent = 1 AND r.context_kind = 'group' AND NOT ${names.sql}${lock ? " FOR UPDATE OF r" : ""}`
    )
    .get(id, ...names.args)) as CaseRow | undefined;
  if (!r) return null;
  return inScope(scope, r.venue_id) || (scope.owner && r.escalated_at !== null) ? r : null;
}

export interface CaseOut {
  id: number;
  createdAt: string;
  status: "open" | "reviewed";
  outcome: string | null;
  reason: string;
  note: string | null;
  groupId: number;
  venueId: number | null;
  reporter: SeatLabel | null;
  reported: { userId: number | null; label: SeatLabel | null; adult: boolean };
  /** A restriction is in force on the reported person's seat (a hold, not a finding). */
  restricted: boolean;
  /** The restriction in force, if any: protective (temporary, not a finding) or a decision, with its age and review (ADR 0052). */
  restriction: {
    kind: "protective" | "decision";
    since: string;
    ageDays: number;
    reviewBy: string | null;
    overdue: boolean;
    decision: { outcome: DecisionOutcome; reason: string | null; by: string | null; at: string | null } | null;
  } | null;
  escalated: { at: string; by: string; reason: string | null } | null;
  /** Safeguarding escalations recorded in this case: who, when, why (a fixed choice). */
  safeguardingEscalations: { by: string; at: string; kind: EscalationKind; reason: string }[];
  /** Requests for a review of the restriction, from the restricted adult: that one was made and how it stands, never what was said. */
  appeals: { id: number; status: "open" | "decided"; at: string; outcome: "lifted" | "continues" | null }[];
  lines: ReportLine[];
  notes: { id: number; action: string; by: string; detail: string | null; at: string }[];
}

/**
 * The case, with the evidence (the frozen copy). Read only by safeguarding personnel in scope; **each reading is recorded** in the case's own
 * audit. A report that is not theirs, or that names them, is not here (the same 404 as one that does not exist).
 */
export async function caseView(admin: Admin, id: number): Promise<{ ok: true; case: CaseOut } | Refused> {
  const r = await caseFor(admin, id);
  if (!r) return NOT_HERE();
  const db = getDb();
  const lines = (await db
    .prepare("SELECT id, sender_label, body, sent_at, flagged FROM player_message_report_lines WHERE report_id = ? ORDER BY id")
    .all(id)) as { id: number; sender_label: string | null; body: string | null; sent_at: string; flagged: number }[];
  const actions = (await db.prepare("SELECT id, action, actor_name, detail, created_at FROM youth_report_actions WHERE report_id = ? ORDER BY id").all(id)) as {
    id: number; action: string; actor_name: string; detail: string | null; created_at: string;
  }[];
  const mute = (await db
    .prepare(
      `SELECT m.id, m.kind, m.created_at, COALESCE(m.review_by, datetime(m.created_at, '+${protectiveReviewDays()} days')) AS review_by, m.decision_outcome, m.decision_reason, m.decided_by, m.decided_at,
              (m.kind = 'protective' AND COALESCE(m.review_by, datetime(m.created_at, '+${protectiveReviewDays()} days')) <= datetime('now')) AS overdue,
              GREATEST(0, floor(extract(epoch FROM (now() AT TIME ZONE 'utc') - m.created_at::timestamp) / 86400)::int) AS age_days
         FROM youth_thread_mutes m WHERE m.report_id = ? AND m.lifted_at IS NULL`
    )
    .get(id)) as
    | { id: number; kind: "protective" | "decision"; created_at: string; review_by: string; decision_outcome: DecisionOutcome | null; decision_reason: string | null; decided_by: string | null; decided_at: string | null; overdue: boolean; age_days: number }
    | undefined;
  const restricted = Boolean(mute);
  const escalations = actions
    .filter((a) => a.action === "safeguarding_escalated")
    .map((a) => {
      const [kind, ...rest] = (a.detail ?? "").split(": ");
      return { by: a.actor_name, at: a.created_at, kind: ((ESCALATION_KINDS as readonly string[]).includes(kind) ? kind : "other") as EscalationKind, reason: rest.join(": ") };
    });
  const appeals = (await db
    .prepare("SELECT p.id, p.status, p.created_at, p.outcome FROM youth_restriction_appeals p JOIN youth_thread_mutes m ON m.id = p.mute_id WHERE m.report_id = ? ORDER BY p.id")
    .all(id)) as { id: number; status: "open" | "decided"; created_at: string; outcome: "lifted" | "continues" | null }[];
  await caseAudit(id, r.context_id, admin.name, "read");
  return {
    ok: true,
    case: {
      id: r.id,
      createdAt: r.created_at,
      status: r.status,
      outcome: r.outcome,
      reason: r.reason,
      note: r.note,
      groupId: r.context_id,
      venueId: r.venue_id,
      reporter: parseLabel(r.reporter_label),
      reported: { userId: r.reported_id, label: parseLabel(r.reported_label), adult: r.reported_id !== null && (await declaredAdult(r.reported_id)) === true },
      restricted,
      restriction: mute
        ? {
            kind: mute.kind,
            since: mute.created_at,
            ageDays: mute.age_days,
            reviewBy: mute.kind === "protective" ? mute.review_by : null,
            overdue: mute.overdue,
            decision: mute.kind === "decision" ? { outcome: mute.decision_outcome as DecisionOutcome, reason: mute.decision_reason, by: mute.decided_by, at: mute.decided_at } : null,
          }
        : null,
      escalated: r.escalated_at ? { at: r.escalated_at, by: r.escalated_by ?? "", reason: r.escalation_reason } : null,
      safeguardingEscalations: escalations,
      appeals: appeals.map((p) => ({ id: p.id, status: p.status, at: p.created_at, outcome: p.outcome })),
      lines: lines.map((l) => ({ id: l.id, from: parseLabel(l.sender_label), body: l.body, at: l.sent_at, flagged: l.flagged === 1 })),
      notes: actions.map((a) => ({ id: a.id, action: a.action, by: a.actor_name, detail: a.detail, at: a.created_at })),
    },
  };
}

/** Whether a note to the reported adult gives away who reported or repeats what was reported. A speed bump for the moderator's own words, not a guarantee. */
async function givesAway(r: CaseRow, text: string): Promise<boolean> {
  return givesAwayReport(r.id, r.reporter_id, text);
}

/** The same check for any words that go to the reported adult (a note to them, the outcome of their request for a review): not the reporter, not what was reported. */
export async function givesAwayReport(reportId: number, reporterId: number | null, text: string): Promise<boolean> {
  const r = { id: reportId, reporter_id: reporterId };
  const db = getDb();
  const lower = text.toLowerCase();
  if (r.reporter_id !== null) {
    const u = (await db.prepare("SELECT name FROM users WHERE id = ?").get(r.reporter_id)) as { name: string } | undefined;
    for (const part of (u?.name ?? "").toLowerCase().split(/\s+/)) if (part.length >= 3 && new RegExp(`(^|[^\\p{L}])${part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}])`, "u").test(lower)) return true;
  }
  const lines = (await db.prepare("SELECT body FROM player_message_report_lines WHERE report_id = ? AND body IS NOT NULL").all(r.id)) as { body: string }[];
  return lines.some((l) => l.body.trim().length >= 12 && lower.includes(l.body.trim().toLowerCase()));
}

/**
 * One step of the case (see the top of this file), each with its own checks and each recorded. Steps on one report run one at a time (the report's
 * row is locked). Not found for a report that is not theirs or names them.
 */
export async function caseStep(admin: Admin, id: number, input: { step: unknown; reason?: unknown; text?: unknown; outcome?: unknown; kind?: unknown }): Promise<{ ok: true } | Refused> {
  if (typeof input.step !== "string" || !(STEPS as readonly string[]).includes(input.step)) return no("Choose what to do.");
  const step = input.step as Step;
  const done = await withTransaction(async (): Promise<({ ok: true } & { escalate?: { groupId: number; reportId: number }; safeguarding?: { groupId: number; reportId: number; kind: EscalationKind }; notify?: { userId: number; text: string; reportId: number; groupId: number } }) | Refused> => {
    const r = await caseFor(admin, id, true);
    if (!r) return NOT_HERE();
    const db = getDb();
    const by = admin.name;
    const group = r.context_id;
    if (step === "note") {
      const text = clean(input.text, 3, 1000);
      if (!text) return no("Write the note, in a few words or more.");
      await caseAudit(id, group, by, "note", text);
      return { ok: true };
    }
    const reason = clean(input.reason, 3, 300);
    if (step !== "notify" && !reason) return no("Say why, in a few words.");
    if (step === "confirm") {
      if (!(await db.prepare("SELECT 1 FROM youth_thread_mutes WHERE report_id = ? AND lifted_at IS NULL").get(id))) return no("There is no restriction in force on this report.", 409);
      // Continuing a protective restriction after looking at it, with a reason, is a review: its date to be reviewed by starts again.
      await db
        .prepare(`UPDATE youth_thread_mutes SET review_by = datetime('now', '+${protectiveReviewDays()} days'), last_reviewed_at = datetime('now'), last_reviewed_by = ?, overdue_notified_at = NULL WHERE report_id = ? AND lifted_at IS NULL AND kind = 'protective'`)
        .run(by, id);
      await caseAudit(id, group, by, "restriction_confirmed", reason);
      return { ok: true };
    }
    if (step === "extend") {
      if (r.reported_id === null) return no("The person this names is no longer here.", 409);
      const next = `datetime('now', '+${protectiveReviewDays()} days')`;
      const live = await db
        .prepare(`UPDATE youth_thread_mutes SET reason = 'Held by safeguarding review.', muted_by = ?, review_by = CASE WHEN kind = 'protective' THEN ${next} ELSE review_by END, last_reviewed_at = datetime('now'), last_reviewed_by = ?, overdue_notified_at = NULL WHERE report_id = ? AND lifted_at IS NULL`)
        .run(by, by, id);
      // A restriction already lifted is put back in force: the hold is the moderator's to keep, not the report's status. A protective one, with a date to be reviewed by.
      if (live.changes === 0)
        await db
          .prepare(`INSERT INTO youth_thread_mutes (group_id, user_id, source, report_id, reason, muted_by, kind, review_by) VALUES (?, ?, 'report', ?, 'Held by safeguarding review.', ?, 'protective', ${next}) ON CONFLICT DO NOTHING`)
          .run(group, r.reported_id, id, by);
      await caseAudit(id, group, by, "restriction_extended", reason);
      return { ok: true };
    }
    if (step === "lift") {
      const lifted = await db.prepare("UPDATE youth_thread_mutes SET lifted_at = datetime('now'), lifted_by = ? WHERE report_id = ? AND lifted_at IS NULL").run(by, id);
      if (lifted.changes === 0) return no("There is no restriction in force on this report.", 409);
      await caseAudit(id, group, by, "restriction_lifted", reason);
      return { ok: true };
    }
    if (step === "escalate") {
      const scope = scopeOf(admin);
      if (scope.owner || r.escalated_at !== null) return no("This report is already with the platform's owner.", 409);
      await db.prepare("UPDATE player_message_reports SET escalated_at = datetime('now'), escalated_by = ?, escalation_reason = ? WHERE id = ?").run(by, reason, id);
      await caseAudit(id, group, by, "escalated", reason);
      return { ok: true, escalate: { groupId: group, reportId: id } };
    }
    if (step === "decide") {
      // A moderator's recorded outcome, with its reason: for a reported adult. A protective restriction is not a finding; a decision is the moderator's own word.
      const outcome = typeof input.outcome === "string" && (DECISION_OUTCOMES as readonly string[]).includes(input.outcome) ? (input.outcome as DecisionOutcome) : null;
      if (!outcome) return no("Choose the outcome: removed from this group's conversation, or messaging suspended.");
      if (r.reported_id === null || (await declaredAdult(r.reported_id)) !== true) return no("A decision is recorded about a reported adult only. A minor's guardians follow the usual notices.", 409);
      const mute = (await db.prepare("SELECT id, kind FROM youth_thread_mutes WHERE report_id = ? AND lifted_at IS NULL FOR UPDATE").get(id)) as { id: number; kind: string } | undefined;
      if (!mute) return no("There is no restriction in force on this report.", 409);
      if (mute.kind === "decision") return no("A decision has already been recorded for this restriction.", 409);
      await db
        .prepare(
          `UPDATE youth_thread_mutes SET kind = 'decision', decision_outcome = ?, decision_reason = ?, decided_by = ?, decided_at = datetime('now'), review_by = NULL, overdue_notified_at = NULL,
                  last_reviewed_at = datetime('now'), last_reviewed_by = ? WHERE id = ?`
        )
        .run(outcome, reason, by, by, mute.id);
      await caseAudit(id, group, by, "restriction_decided", `${outcome}: ${reason}`);
      await consentEvent(group, "staff", "restriction_decided", { minorId: r.reported_id, detail: `report ${id}: ${outcome}` });
      return { ok: true };
    }
    if (step === "safeguarding") {
      const kind = typeof input.kind === "string" && (ESCALATION_KINDS as readonly string[]).includes(input.kind) ? (input.kind as EscalationKind) : null;
      if (!kind) return no("Choose why: suspected abuse, imminent danger, a possibly reportable incident, or other.");
      // The owner sees the case from now on (as for an ordinary escalation), told at once; who, when and why are in the case.
      if (r.escalated_at === null)
        await db.prepare("UPDATE player_message_reports SET escalated_at = datetime('now'), escalated_by = ?, escalation_reason = ? WHERE id = ?").run(by, "Escalated for safeguarding.", id);
      await caseAudit(id, group, by, "safeguarding_escalated", `${kind}: ${reason}`);
      return { ok: true, safeguarding: { groupId: group, reportId: id, kind } };
    }
    // notify: the only way the reported adult is ever told, in the moderator's own words.
    const text = clean(input.text, 10, 1000);
    if (!text) return no("Write what the person is to be told, in a few sentences.");
    if (r.reported_id === null || (await declaredAdult(r.reported_id)) !== true) return no("Only a reported adult is told this way. A minor's guardians follow the usual notices.", 409);
    if (await givesAway(r, text)) return no("Do not name who made the report or repeat what was reported.");
    await caseAudit(id, group, by, "notified_reported", text);
    return { ok: true, notify: { userId: r.reported_id, text, reportId: id, groupId: group } };
  });
  if (!done.ok) return done;
  if (done.escalate) {
    const { escalate } = done;
    const group = (await getDb().prepare("SELECT name FROM community_groups WHERE id = ?").get(escalate.groupId)) as { name: string } | undefined;
    const r = await getDb().prepare("SELECT reported_id FROM player_message_reports WHERE id = ?").get(escalate.reportId) as { reported_id: number | null } | undefined;
    try {
      await tellOwnersEach(
        (t) => ({ subject: t("msg3.mail.escalatedSubject", { group: group?.name ?? "" }), body: staffSentences(t, t("msg3.mail.escalatedBody", { group: group?.name ?? "", id: escalate.reportId })) }),
        { exceptEmails: await staffEmailsOf(r?.reported_id ?? null), kind: "safeguarding_notice" }
      );
    } catch (err) {
      console.error("[mysenam] could not queue a safeguarding notice:", err instanceof Error ? err.message : "unknown error");
    }
  }
  if (done.safeguarding) {
    const { safeguarding } = done;
    const group = (await getDb().prepare("SELECT name FROM community_groups WHERE id = ?").get(safeguarding.groupId)) as { name: string } | undefined;
    const rep = (await getDb().prepare("SELECT reported_id FROM player_message_reports WHERE id = ?").get(safeguarding.reportId)) as { reported_id: number | null } | undefined;
    try {
      // At once, to every owner (never the person reported if they are staff too): the kind of escalation and where, never who reported or what was said.
      await tellOwnersEach(
        (t) => ({
          subject: t("msg4.mail.safeguardingSubject", { group: group?.name ?? "" }),
          body: staffSentences(t, t("msg4.mail.safeguardingBody", { group: group?.name ?? "", id: safeguarding.reportId, kind: t(`msg4.esc.${safeguarding.kind}` as "msg4.esc.other") }), t("msg4.guidance")),
        }),
        { exceptEmails: await staffEmailsOf(rep?.reported_id ?? null), kind: "safeguarding_notice" }
      );
    } catch (err) {
      console.error("[mysenam] could not queue a safeguarding notice:", err instanceof Error ? err.message : "unknown error");
    }
  }
  if (done.notify) {
    const { notify } = done;
    try {
      const count = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM youth_report_actions WHERE report_id = ? AND action = 'notified_reported'").get(notify.reportId)) as { n: number };
      await emailPlayer({
        kind: "safeguarding_notice",
        venueId: null,
        userId: notify.userId,
        subject: (t) => t("pmy.mail.subject", { site: siteName() }),
        body: () => notify.text,
        link: `${baseUrl()}/messages`,
        dedupeKey: `ysg:notify:${notify.reportId}:${count.n}`,
      });
    } catch (err) {
      console.error("[mysenam] could not queue a safeguarding notice:", err instanceof Error ? err.message : "unknown error");
    }
  }
  return { ok: true };
}
