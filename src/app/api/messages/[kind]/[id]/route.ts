import { NextRequest, NextResponse } from "next/server";
import { readJsonObject } from "@/lib/api";
import { sendMessage, setContextMute, threadView } from "@/lib/messages";
import { messageRequest, refused } from "../../respond";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ kind: string; id: string }> };

/**
 * One conversation: `/api/messages/game/12`, `team/3`, `group/4`, `tournament-match/5`, `league-match/6`, `ladder-challenge/7`,
 * `team-fixture/8`. `?after=<message id>` for the ones since (polling) and `?read=1` to mark what is shown as read. 404 for anybody who is
 * not in the context, the same as for one that does not exist.
 */
export async function GET(req: NextRequest, { params }: Params) {
  const asked = await messageRequest(req, params, "messageRead");
  if (asked instanceof NextResponse) return asked;
  const q = req.nextUrl.searchParams;
  const after = Number(q.get("after"));
  const result = await threadView(asked.user.id, asked.kind, asked.id, { after: Number.isInteger(after) && after > 0 ? after : 0, markRead: q.get("read") === "1" });
  if (!result.ok) return refused(result);
  return NextResponse.json(result.view, { headers: { "Cache-Control": "no-store" } });
}

/** `{ body }`: write a message (text only; refused with a code and a sentence, `docs/features/player-messages.md#what-is-refused`). */
export async function POST(req: NextRequest, { params }: Params) {
  const asked = await messageRequest(req, params, "messageWrite");
  if (asked instanceof NextResponse) return asked;
  const body = await readJsonObject(req);
  if (body instanceof NextResponse) return body;
  const sent = await sendMessage(asked.user.id, asked.kind, asked.id, body.body);
  if (!sent.ok) return refused(sent);
  return NextResponse.json({ message: sent.message }, { status: 201 });
}

/** `{ muted: boolean }`: mute this context for yourself (no email, no unread count), or undo it. */
export async function PATCH(req: NextRequest, { params }: Params) {
  const asked = await messageRequest(req, params, "messageWrite");
  if (asked instanceof NextResponse) return asked;
  const body = await readJsonObject(req);
  if (body instanceof NextResponse) return body;
  if (typeof body.muted !== "boolean") return NextResponse.json({ error: "Muted or not?" }, { status: 400 });
  const done = await setContextMute(asked.user.id, asked.kind, asked.id, body.muted);
  if (!done.ok) return refused(done);
  return NextResponse.json({ muted: done.muted });
}
