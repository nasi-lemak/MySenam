import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { decide, gameById, type PlayerAction } from "@/lib/games";
import { withdrawNoShow } from "@/lib/no-show-marks";
import { jsonObject } from "@/lib/api";

export const dynamic = "force-dynamic";

const ACTIONS: (PlayerAction | "take_back_no_show")[] = ["accept", "decline", "remove", "no_show", "take_back_no_show"];

/**
 * `{ action: "accept" | "decline" | "remove" | "no_show" | "take_back_no_show" }` — the host about one player. A no-show needs a
 * `reason` (the player is told it, and may answer it: lib/no-show-marks.ts, ADR 0072); `take_back_no_show` takes back a mark the host
 * made, unless a reviewer has let it stand.
 */
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
  if (body.action === "take_back_no_show") {
    const taken = await withdrawNoShow(user.id, playerId);
    if (!taken.ok) return NextResponse.json({ error: taken.error, code: taken.code }, { status: taken.status ?? 409 });
    return NextResponse.json({ game: await gameById(Number((await params).id)) });
  }
  const result = await decide(user.id, playerId, body.action as PlayerAction, { reason: body.reason });
  if (!result.ok) return NextResponse.json({ error: result.error, code: result.code }, { status: result.status ?? 409 });
  return NextResponse.json({ game: result.game });
}
