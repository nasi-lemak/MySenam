import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { recommendPlayers } from "@/lib/matchmaking";

export const dynamic = "force-dynamic";

/**
 * For a game's host: players who opted in to being found and might suit it,
 * with a first name, a level, a distance band and the reasons — never where
 * they live or how to reach them (`?offset=&limit=`).
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const gameId = Number((await params).id);
  if (!Number.isInteger(gameId) || gameId <= 0) return NextResponse.json({ error: "Invalid game." }, { status: 400 });
  const q = req.nextUrl.searchParams;
  const result = await recommendPlayers(user.id, gameId, { offset: Number(q.get("offset")) || 0, limit: Number(q.get("limit")) || 20 });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ players: result.players });
}
