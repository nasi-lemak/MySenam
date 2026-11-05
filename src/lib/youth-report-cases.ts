import { getDb, withTransaction } from "./db";
import type { Admin } from "./admin-auth";
import { inScope, scopeOf, type Refused, type ReportLine } from "./message-moderation";
import { baseUrl, emailPlayer } from "./outbox";
import { declaredAdult } from "./player-profiles";
import { namesTheViewerSql, staffEmailsOf } from "./safeguarding-conflict";
import { siteName } from "./site";
import { staffSentences, tellOwnersEach } from "./owner-alerts";
import type { SeatLabel } from "./message-contexts";

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
 * - add a **note**;
 * - **notify** the reported adult: the one way they are ever told, written by the moderator, never automatic, never naming who reported or repeating
 *   what was reported.
 *
 * Every step is written to `youth_report_actions` (who, what, when, why: never a message's text), apart from the staff activity log, which a
 * reported member of staff can read.
 */

const STEPS = ["confirm", "extend", "lift", "escalate", "note", "notify"] as const;
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
async function caseFor(admin: Admin, id: number, lock = false): Promise<CaseRow | null> {
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
  escalated: { at: string; by: string; reason: string | null } | null;
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
  const restricted = Boolean(await db.prepare("SELECT 1 FROM youth_thread_mutes WHERE report_id = ? AND lifted_at IS NULL").get(id));
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
      escalated: r.escalated_at ? { at: r.escalated_at, by: r.escalated_by ?? "", reason: r.escalation_reason } : null,
      lines: lines.map((l) => ({ id: l.id, from: parseLabel(l.sender_label), body: l.body, at: l.sent_at, flagged: l.flagged === 1 })),
      notes: actions.map((a) => ({ id: a.id, action: a.action, by: a.actor_name, detail: a.detail, at: a.created_at })),
    },
  };
}

/** Whether a note to the reported adult gives away who reported or repeats what was reported. A speed bump for the moderator's own words, not a guarantee. */
async function givesAway(r: CaseRow, text: string): Promise<boolean> {
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
export async function caseStep(admin: Admin, id: number, input: { step: unknown; reason?: unknown; text?: unknown }): Promise<{ ok: true } | Refused> {
  if (typeof input.step !== "string" || !(STEPS as readonly string[]).includes(input.step)) return no("Choose what to do.");
  const step = input.step as Step;
  const done = await withTransaction(async (): Promise<({ ok: true } & { escalate?: { groupId: number; reportId: number }; notify?: { userId: number; text: string; reportId: number; groupId: number } }) | Refused> => {
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
      await caseAudit(id, group, by, "restriction_confirmed", reason);
      return { ok: true };
    }
    if (step === "extend") {
      if (r.reported_id === null) return no("The person this names is no longer here.", 409);
      const live = await db.prepare("UPDATE youth_thread_mutes SET reason = 'Held by safeguarding review.', muted_by = ? WHERE report_id = ? AND lifted_at IS NULL").run(by, id);
      // A restriction already lifted is put back in force: the hold is the moderator's to keep, not the report's status.
      if (live.changes === 0)
        await db
          .prepare("INSERT INTO youth_thread_mutes (group_id, user_id, source, report_id, reason, muted_by) VALUES (?, ?, 'report', ?, 'Held by safeguarding review.', ?) ON CONFLICT DO NOTHING")
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
