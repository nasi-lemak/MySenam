import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { readJsonObject } from "@/lib/api";
import { listYouthGroupsForStaff, staffAnswerVenue, staffEndYouthGroup, staffReadYouthThread, staffRemoveYouthAdult } from "@/lib/youth-safeguarding";

export const dynamic = "force-dynamic";

/**
 * Supervised youth groups that are the caller's to look after: a venue's manager sees those that asked their venue (waiting to be answered,
 * or accepted), the platform owner those with no venue; **managers and owner only** (front desk `403 MANAGER_ONLY`). No message text in the
 * list. `?group=<id>`: the group's conversation, for moderation and safeguarding review: a deliberate exception to "nobody on staff reads
 * an ordinary message", for supervised youth groups only, for an accepted venue or the owner (a group that did not ask the caller's venue is
 * `404 YG_NOT_FOUND`), and **every such read is recorded** in the staff activity log and the group's own record
 * (docs/features/player-messages.md#supervised-youth-groups).
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const group = req.nextUrl.searchParams.get("group");
  if (group !== null) {
    const id = Number(group);
    if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "That group is not here.", code: "YG_NOT_FOUND" }, { status: 404 });
    const read = await staffReadYouthThread(admin, id);
    if (!read.ok) return NextResponse.json({ error: read.error, code: read.code }, { status: read.status });
    return NextResponse.json(read, { headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.json({ groups: await listYouthGroupsForStaff(admin) }, { headers: { "Cache-Control": "no-store" } });
}

/**
 * `{ action: "answer", groupId, accept: boolean }` (a venue's manager answers the group's request to be looked after by their venue);
 * `{ action: "end", groupId, reason }` ends the youth group and closes its conversation for good; `{ action: "removeAdult", groupId,
 * memberUserId, reason }` takes an adult out of its conversation (never the organiser). Each is logged by group number and reason.
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const body = await readJsonObject(req);
  if (body instanceof NextResponse) return body;
  const groupId = Number.isInteger(body.groupId) ? (body.groupId as number) : -1;
  const done =
    body.action === "answer" && typeof body.accept === "boolean"
      ? await staffAnswerVenue(admin, groupId, body.accept)
      : body.action === "end"
        ? await staffEndYouthGroup(admin, groupId, body.reason)
        : body.action === "removeAdult"
          ? await staffRemoveYouthAdult(admin, groupId, body.memberUserId, body.reason)
          : null;
  if (!done) return NextResponse.json({ error: "Choose what to do." }, { status: 400 });
  if (!done.ok) return NextResponse.json({ error: done.error, code: done.code }, { status: done.status });
  return NextResponse.json(done);
}
