import { NextRequest, NextResponse } from "next/server";
import { readJsonObject } from "@/lib/api";
import { getSessionUser } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import {
  endYouthGroup,
  markYouthGroup,
  muteSender,
  removeMessage,
  requestVenue,
  setGroupQuiet,
  setSupervisedThreadState,
  setYouthAdult,
  unmute,
  youthGroupState,
} from "@/lib/youth-messages";

export const dynamic = "force-dynamic";

const idOf = async (params: Promise<{ id: string }>): Promise<number | null> => {
  const id = Number((await params).id);
  return Number.isInteger(id) && id > 0 ? id : null;
};

/**
 * A group's supervised-youth settings, for its organiser and its supervisors only (anybody else gets `404 YG_NOT_FOUND`, as for a group that
 * does not exist): whether it is marked, who supervises and which adults were let in (with what each said they are), the venue asked, the rest
 * hours, how many young members have every consent on, and who is muted. An advanced setting of a group, never part of anybody's setup.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const id = await idOf(params);
  if (id === null) return NextResponse.json({ error: "Invalid group.", code: "YG_NOT_FOUND" }, { status: 404 });
  const limited = await rateLimit(req, "messageRead");
  if (limited) return limited;
  const state = await youthGroupState(user.id, id);
  if ("ok" in state) return NextResponse.json({ error: state.error, code: state.code }, { status: state.status });
  return NextResponse.json({ state }, { headers: { "Cache-Control": "no-store" } });
}

/**
 * `{ action }` for the group's organiser: `"mark"`; `"end", reason` (closes the conversation for good); `"venue", venueId` (or `null` to withdraw)
 * asks a venue to look after it; `"quiet", from, to` ("HH:MM", lengthens the install's rest hours, never shortens them; `null` for both clears the
 * group's own); `"adult", memberUserId, role: "supervisor" | "adult", declaredRole` lets an adult member in; `"removeAdult", memberUserId`.
 * For a supervisor: `"removeMessage", messageId, reason`; `"mute", messageId, reason` (the sender of that message can read and not write);
 * `"unmute", muteId`; `"thread", state: "open" | "muted" | "closed", reason`. Each is recorded in the group's own record (never message text);
 * refusals carry a code (`YG_*`).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const id = await idOf(params);
  if (id === null) return NextResponse.json({ error: "Invalid group.", code: "YG_NOT_FOUND" }, { status: 404 });
  const limited = await rateLimit(req, "messageWrite");
  if (limited) return limited;
  const body = await readJsonObject(req);
  if (body instanceof NextResponse) return body;
  const done =
    body.action === "mark"
      ? await markYouthGroup(user.id, id)
      : body.action === "end"
        ? await endYouthGroup({ userId: user.id }, id, body.reason)
        : body.action === "venue"
          ? await requestVenue(user.id, id, body.venueId === null ? null : Number.isInteger(body.venueId) ? (body.venueId as number) : -1)
          : body.action === "quiet"
            ? await setGroupQuiet(user.id, id, body.from === null && body.to === null ? null : { from: body.from, to: body.to })
            : body.action === "adult"
              ? await setYouthAdult(user.id, id, { memberUserId: body.memberUserId, role: body.role, declaredRole: body.declaredRole })
              : body.action === "removeAdult"
                ? await setYouthAdult(user.id, id, { memberUserId: body.memberUserId, role: "adult", declaredRole: "other", remove: true })
                : body.action === "removeMessage"
                  ? await removeMessage(user.id, id, body.messageId, body.reason)
                  : body.action === "mute"
                    ? await muteSender(user.id, id, body.messageId, body.reason)
                    : body.action === "unmute"
                      ? await unmute(user.id, id, body.muteId)
                      : body.action === "thread"
                        ? await setSupervisedThreadState(user.id, id, body.state, body.reason)
                        : null;
  if (!done) return NextResponse.json({ error: "Choose what to do." }, { status: 400 });
  if (!done.ok) return NextResponse.json({ error: done.error, code: done.code, vars: done.vars }, { status: done.status });
  return NextResponse.json(done);
}
