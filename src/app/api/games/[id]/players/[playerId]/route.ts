import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { decide, type PlayerAction } from "@/lib/games";
import { jsonObject } from "@/lib/api";

export const dynamic = "force-dynamic";

const ACTIONS: PlayerAction[] = ["accept", "decline", "remove", "no_show"];

/** `{ action: "accept" | "decline" | "remove" | "no_show" }` — the host about one player. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; playerId: string }> }) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const playerId = Number((await params).playerId);
  let body: Record<string, unknown>;
  try {
    body = (await jsonObject(req)) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!Number.isInteger(playerId) || !ACTIONS.includes(body.action as PlayerAction))
    return NextResponse.json({ error: "Which player, and what?" }, { status: 400 });
  const result = await decide(user.id, playerId, body.action as PlayerAction);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status ?? 409 });
  return NextResponse.json({ game: result.game });
}
