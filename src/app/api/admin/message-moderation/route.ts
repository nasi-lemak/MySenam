import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { readJsonObject } from "@/lib/api";
import { caseStep, caseView } from "@/lib/youth-report-cases";
import { decideAppeal, listAppeals } from "@/lib/youth-restrictions";
import {
  confirmSuspension,
  keepSuspension,
  liftSuspension,
  listMessageReports,
  listSuspensions,
  reviewMessageReport,
  scopeOf,
  setThreadState,
  suspendMessaging,
} from "@/lib/message-moderation";

export const dynamic = "force-dynamic";

/**
 * A manager's view of reports of messages between players, and of the suspensions in force, for what is theirs: a venue's manager sees the
 * reports of that venue's contexts; the platform owner those of contexts with no venue and the platform-wide suspensions
 * (docs/features/player-messages.md#moderation). `?status=open|reviewed&before=<id>`. Nobody on staff reads an ordinary message.
 * A report in a youth group's thread is a **case** (ADR 0049): the list holds back its copy (`linesHeld`), and `?report=<id>` reads the case with its
 * evidence, **each reading recorded**. A report that is not the caller's, or that names the caller (or the same person's account), is `404` exactly as one that
 * does not exist.
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const q = req.nextUrl.searchParams;
  const status = q.get("status");
  // `?appeals=1`: the open requests for a review of a restriction that are the caller's to decide (ADR 0052): never what any report said or who made it.
  if (q.has("appeals")) return NextResponse.json({ appeals: await listAppeals(admin) }, { headers: { "Cache-Control": "no-store" } });
  if (q.has("report")) {
    const id = Number(q.get("report"));
    const one = Number.isInteger(id) && id > 0 ? await caseView(admin, id) : ({ ok: false, error: "That report is not here.", status: 404 } as const);
    if (!one.ok) return NextResponse.json({ error: one.error }, { status: one.status });
    return NextResponse.json(one, { headers: { "Cache-Control": "no-store" } });
  }
  const [reports, suspensions] = await Promise.all([
    listMessageReports(admin, { status: status === "open" || status === "reviewed" ? status : undefined, before: Number(q.get("before")) || undefined }),
    listSuspensions(admin),
  ]);
  // `appeals`: the open requests for a review of a restriction that are the caller's to decide (ADR 0052).
  return NextResponse.json({ reports, suspensions, appeals: await listAppeals(admin), scope: scopeOf(admin).owner ? "platform" : "venue" });
}

/**
 * `{ action: "review", id, outcome: "no_action" | "action_taken" }`, `{ action: "thread", id, state: "open" | "muted" | "closed", reason }`,
 * `{ action: "suspend", userId, reportId?, reason }`, `{ action: "lift", id, reason }` (a venue's manager may lift an automatic suspension that rests on that venue's
 * reports alone, the owner any), `{ action: "confirm", id, reason }` (the owner's, for an automatic suspension), `{ action: "keep", id, reason }` (answers the suspended person's
 * request for a review: it stands, by somebody who did not apply it; ADR 0059). Each is logged by number and reason, never with any message text. A report in a youth thread has a third review outcome,
 * `restriction_continues`, and its case steps: `{ action: "case", id, step: "confirm" | "extend" | "lift" | "escalate", reason }`,
 * `{ action: "case", id, step: "decide", outcome: "removed_from_group" | "messaging_suspended", reason }` (the protective restriction becomes a moderator's recorded
 * decision), `{ action: "case", id, step: "safeguarding", kind: "suspected_abuse" | "imminent_danger" | "possible_reportable_incident" | "other", reason }` (the owner is told
 * at once; nothing is sent to any authority), `{ action: "appeal", id, outcome: "lifted" | "continues", reason, text? }` (decides a request for a review, by somebody other
 * than whoever applied the restriction; ADR 0052),
 * `{ action: "case", id, step: "note", text }` and `{ action: "case", id, step: "notify", text }` (the one way the reported adult is ever told: the
 * moderator's own words, never naming who reported or repeating what was reported). Case steps are recorded in the case's own audit.
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const body = await readJsonObject(req);
  if (body instanceof NextResponse) return body;
  const id = Number.isInteger(body.id) ? (body.id as number) : null;
  const done =
    body.action === "review" && id !== null
      ? await reviewMessageReport(admin, id, body.outcome)
      : body.action === "thread" && id !== null
        ? await setThreadState(admin, id, body.state, body.reason)
        : body.action === "suspend"
          ? await suspendMessaging(admin, { userId: body.userId, reason: body.reason, reportId: body.reportId })
          : body.action === "case" && id !== null
            ? await caseStep(admin, id, { step: body.step, reason: body.reason, text: body.text, outcome: body.outcome, kind: body.kind })
            : body.action === "appeal" && id !== null
              ? await decideAppeal(admin, id, { outcome: body.outcome, reason: body.reason, text: body.text })
            : body.action === "lift" && id !== null
            ? await liftSuspension(admin, id, body.reason)
            : body.action === "confirm" && id !== null
              ? await confirmSuspension(admin, id, body.reason)
              : body.action === "keep" && id !== null
                ? await keepSuspension(admin, id, body.reason)
                : null;
  if (!done) return NextResponse.json({ error: "Choose what to do." }, { status: 400 });
  if (!done.ok) return NextResponse.json({ error: done.error }, { status: done.status });
  return NextResponse.json(done);
}
