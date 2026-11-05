import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { readJsonObject } from "@/lib/api";
import {
  listYouthGroupsForStaff, staffAnswerVenue, staffEndYouthGroup, staffReadYouthThread, staffRemoveYouthAdult, staffResolveObjection, staffSafeguardingView, staffSetGuardianAuthority,
} from "@/lib/youth-safeguarding";

export const dynamic = "force-dynamic";

/**
 * Supervised youth groups that are the caller's to look after: a venue's manager sees those that asked their venue (waiting to be answered,
 * or accepted), the platform owner those with no venue; **managers and owner only** (front desk `403 MANAGER_ONLY`). No message text in the
 * list. `?group=<id>`: the group's conversation, for moderation and safeguarding review: a deliberate exception to "nobody on staff reads
 * an ordinary message", for supervised youth groups only, for an accepted venue or the owner (a group that did not ask the caller's venue is
 * `404 YG_NOT_FOUND`), and **every such read is recorded** in the staff activity log and the group's own record
 * (docs/features/player-messages.md#supervised-youth-groups). `?safeguarding=<id>`: the children of the group whose own login is linked, with any
 * hold on their messaging (who opened it, at what level: for safeguarding administrators only), and each guardian's recorded level and note
 * (ADR 0049); the same scope, never a guardian or supervisor of the child, each read recorded. A group in which a report names the caller (or
 * the same person's account) is `404` for both.
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const group = req.nextUrl.searchParams.get("group");
  const safeguarding = req.nextUrl.searchParams.get("safeguarding");
  if (safeguarding !== null) {
    const id = Number(safeguarding);
    if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "That group is not here.", code: "YG_NOT_FOUND" }, { status: 404 });
    const view = await staffSafeguardingView(admin, id);
    if (!view.ok) return NextResponse.json({ error: view.error, code: view.code }, { status: view.status });
    return NextResponse.json(view, { headers: { "Cache-Control": "no-store" } });
  }
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
 * `{ action: "authority", guardianshipId, level: "decides" | "objects_only" | "none", note? }` records what a guardian may do about the child's group
 * messaging (the venue's word, never verified; a note of up to 200 characters, no identity numbers); `{ action: "resolve", objectionId, reason }`
 * settles a hold on a child's messaging (it does not switch messaging on). Both are manager-only, audited, and refused as not found for a guardian
 * or supervisor of the child (ADR 0049).
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
          : body.action === "authority"
            ? await staffSetGuardianAuthority(admin, { guardianshipId: body.guardianshipId, level: body.level, note: body.note })
            : body.action === "resolve"
              ? await staffResolveObjection(admin, body.objectionId, body.reason)
              : null;
  if (!done) return NextResponse.json({ error: "Choose what to do." }, { status: 400 });
  if (!done.ok) return NextResponse.json({ error: done.error, code: done.code }, { status: done.status });
  return NextResponse.json(done);
}
