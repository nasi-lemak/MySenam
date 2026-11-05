import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { logAction } from "@/lib/activity";
import { jsonObject } from "@/lib/api";
import { approvedMoveDetail, decideMoveRequest } from "@/lib/class-move-requests";
import { classMoveDetail } from "@/lib/class-moves";
import { tickOutbox } from "@/lib/notify";

export const dynamic = "force-dynamic";

/**
 * A manager decides a front-desk request to move a class (lib/class-move-requests.ts, ADR 0045; the desk: 403 `MANAGER_ONLY`).
 * `{ approve: true, note? }` makes the move now, in the one transaction that marks the request approved, after reading again that the class, who is enrolled
 * and who is waiting are what the desk was shown, and tells everyone as any move does (200 `{ request, moveId, classes, told }`); `{ decline: true, reason }`
 * declines it with a reason and changes nothing and tells nobody. 404 for a request at a venue the manager does not manage, 409 once it is decided or closed
 * (`CLS3_REQ_DECIDED`), when what it was asked about changed (`CLS3_REQ_CHANGED`, and the request is closed) or when something now stands in the way (the
 * move's own refusal, with `conflicts`; the request stays for another try or a decline), 400 for a decline without a reason (`CLS3_REASON`). Logged
 * `class.move_approved` and `class.moved`, or `class.move_declined`.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const { id } = await params;
  const requestId = Number(id);
  if (!Number.isInteger(requestId) || requestId <= 0) return NextResponse.json({ error: "Invalid request id." }, { status: 400 });
  let body: Record<string, unknown>;
  try {
    body = await jsonObject(req);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if ((body.approve === true) === (body.decline === true)) return NextResponse.json({ error: "Say approve or decline." }, { status: 400 });
  const done = await decideMoveRequest(admin, requestId, body.approve === true ? { approve: true, note: body.note } : { decline: true, reason: body.reason });
  if (!done.ok) {
    return NextResponse.json(
      { error: done.error, code: done.code, vars: done.vars, ...("conflicts" in done && done.conflicts ? { conflicts: done.conflicts } : {}) },
      { status: done.status }
    );
  }
  if (done.result) {
    await logAction(admin, {
      venueId: done.request.venueId,
      action: "class.moved",
      detail: `${classMoveDetail(done.result)}; ${approvedMoveDetail(done.request, admin.name)}`,
    });
    await tickOutbox();
    return NextResponse.json({ request: done.request, moveId: done.result.moveId, classes: done.result.moved.map((m) => m.after), told: done.result.told });
  }
  return NextResponse.json({ request: done.request });
}
