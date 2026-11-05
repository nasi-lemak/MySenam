import { NextRequest, NextResponse } from "next/server";
import { readJsonObject } from "@/lib/api";
import { getSessionUser } from "@/lib/auth";
import { digestHours } from "@/lib/message-limits";
import { rateLimit } from "@/lib/rate-limit";
import { guardianThreadView } from "@/lib/youth-safeguarding";
import { guardianBlock, guardianOverview, setConsent, setGuardianNoticeMode, switchOffAll } from "@/lib/youth-messages";

export const dynamic = "force-dynamic";

/**
 * A guardian's controls over group messaging for the children they act for (docs/features/player-messages.md#supervised-youth-groups): for each
 * child whose own login is linked, the supervised youth groups they are in, who supervises, which adults were let in, whether a guardian has
 * switched messaging on, whether the child has, and the notice setting. Only the children this account acts for now. With
 * `?participantId=&groupId=`: the child's group conversation, read-only, as the guardian of that child (each read is recorded in the group's
 * record); other children by their short names, as the thread shows them.
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const limited = await rateLimit(req, "messageRead");
  if (limited) return limited;
  const q = req.nextUrl.searchParams;
  if (q.has("participantId") || q.has("groupId")) {
    const groupId = Number(q.get("groupId"));
    if (!Number.isInteger(groupId) || groupId <= 0) return NextResponse.json({ error: "Which group?", code: "YG_NOT_FOUND" }, { status: 404 });
    const view = await guardianThreadView(user.id, Number(q.get("participantId")), groupId);
    if (!view.ok) return NextResponse.json({ error: view.error, code: view.code }, { status: view.status });
    return NextResponse.json(view, { headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.json({ children: await guardianOverview(user.id), digestHours: digestHours() }, { headers: { "Cache-Control": "no-store" } });
}

/**
 * `{ action: "consent", participantId, groupId, on }` switches messaging on or off for one child in one group (default off; on takes the child
 * to be a member of a marked group; off ends every live consent for that child and group at once); `{ action: "allOff", participantId }`
 * switches it off for the child in every group; `{ action: "notices", participantId, mode: "immediate" | "digest" | "daily" | "off" }`: how
 * often notices about the child's group messages are sent (the guardian's choice governs); `{ action: "block", participantId, groupId, userId }`
 * blocks somebody for the child (never a supervisor). Refusals carry a code (`YG_*`, `PM_YOUTH_*`).
 */
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const limited = await rateLimit(req, "messageWrite");
  if (limited) return limited;
  const body = await readJsonObject(req);
  if (body instanceof NextResponse) return body;
  const groupId = Number.isInteger(body.groupId) ? (body.groupId as number) : -1;
  const done =
    body.action === "consent" && typeof body.on === "boolean"
      ? await setConsent(user.id, body.participantId, groupId, body.on)
      : body.action === "allOff"
        ? await switchOffAll(user.id, body.participantId)
        : body.action === "notices"
          ? await setGuardianNoticeMode(user.id, body.participantId, body.mode)
          : body.action === "block"
            ? await guardianBlock(user.id, body.participantId, groupId, body.userId)
            : null;
  if (!done) return NextResponse.json({ error: "Choose what to do." }, { status: 400 });
  if (!done.ok) return NextResponse.json({ error: done.error, code: done.code, vars: done.vars }, { status: done.status });
  return NextResponse.json({ ok: true, children: await guardianOverview(user.id), digestHours: digestHours() });
}
