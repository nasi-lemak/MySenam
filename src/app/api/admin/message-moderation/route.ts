import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { readJsonObject } from "@/lib/api";
import {
  confirmSuspension,
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
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const q = req.nextUrl.searchParams;
  const status = q.get("status");
  const [reports, suspensions] = await Promise.all([
    listMessageReports(admin, { status: status === "open" || status === "reviewed" ? status : undefined, before: Number(q.get("before")) || undefined }),
    listSuspensions(admin),
  ]);
  return NextResponse.json({ reports, suspensions, scope: scopeOf(admin).owner ? "platform" : "venue" });
}

/**
 * `{ action: "review", id, outcome: "no_action" | "action_taken" }`, `{ action: "thread", id, state: "open" | "muted" | "closed", reason }`,
 * `{ action: "suspend", userId, reportId?, reason }`, `{ action: "lift", id, reason }`, `{ action: "confirm", id, reason }` (the owner's, for an
 * automatic suspension). Each is logged by number and reason, never with any message text.
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
          : body.action === "lift" && id !== null
            ? await liftSuspension(admin, id, body.reason)
            : body.action === "confirm" && id !== null
              ? await confirmSuspension(admin, id, body.reason)
              : null;
  if (!done) return NextResponse.json({ error: "Choose what to do." }, { status: 400 });
  if (!done.ok) return NextResponse.json({ error: done.error }, { status: done.status });
  return NextResponse.json(done);
}
