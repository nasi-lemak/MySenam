import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { closeGroup, groupView, inviteGroupToGame, inviteToGroup, joinGroup, leaveGroup } from "@/lib/groups";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** One group as you may see it: a private one only to its members and those invited; the roster to members. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "Invalid group." }, { status: 400 });
  const user = await getSessionUser(req);
  const group = await groupView(id, user?.id ?? null);
  if (!group) return NextResponse.json({ error: "That group is not there any more." }, { status: 404 });
  return NextResponse.json({ group, signedIn: user !== null });
}

/**
 * `{ action }`: "join" (ask, or take up an invitation), "leave"; for its
 * organiser, "invite" (`email`) and "close"; for a member hosting a game,
 * "inviteToGame" (`gameId`): everybody in the group invited to it.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "Invalid group." }, { status: 400 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  if (body.action === "invite" || body.action === "inviteToGame" || body.action === "join") {
    const limited = await rateLimit(req, "social");
    if (limited) return limited;
  }
  if (body.action === "inviteToGame") {
    if (!Number.isInteger(body.gameId)) return NextResponse.json({ error: "Which game?" }, { status: 400 });
    const sent = await inviteGroupToGame(user.id, id, body.gameId as number);
    if (!sent.ok) return NextResponse.json({ error: sent.error }, { status: sent.status ?? 409 });
    return NextResponse.json(sent);
  }
  const result =
    body.action === "join"
      ? await joinGroup(user.id, id)
      : body.action === "leave"
        ? await leaveGroup(user.id, id)
        : body.action === "close"
          ? await closeGroup(user.id, id)
          : body.action === "invite" && typeof body.email === "string"
            ? await inviteToGroup(user.id, id, body.email)
            : null;
  if (!result) return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status ?? 409 });
  return NextResponse.json({ group: result.group });
}
