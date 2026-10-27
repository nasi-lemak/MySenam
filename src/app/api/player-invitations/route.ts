import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { acceptPlayerInvitation } from "@/lib/player-invitations";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * `{ token }`, signed in: accept an emailed invitation to an open game or a
 * community group. Every reason it cannot be used, including the rules on
 * who may be invited not allowing it, is the same
 * `404 PLAYER_INVITATION_INVALID`.
 */
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const limited = await rateLimit(req, "playerAccept");
  if (limited) return limited;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const result = await acceptPlayerInvitation(user, body?.token);
  if (!result.ok) return NextResponse.json({ error: result.error, code: result.code, vars: result.vars }, { status: result.status ?? 409 });
  return NextResponse.json(result.kind === "game" ? { kind: "game", gameId: result.gameId, status: result.status } : { kind: "group", groupId: result.groupId, name: result.name });
}
