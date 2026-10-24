import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { reportPlayer } from "@/lib/player-safety";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** `{ userId, reason, gameId?, note? }`: report somebody you have come across here to the platform's owners. */
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const limited = await rateLimit(req, "social");
  if (limited) return limited;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || !Number.isInteger(body.userId)) return NextResponse.json({ error: "Who?" }, { status: 400 });
  const done = await reportPlayer(user.id, {
    userId: body.userId as number,
    gameId: Number.isInteger(body.gameId) ? (body.gameId as number) : null,
    reason: body.reason,
    note: body.note,
  });
  if (!done.ok) return NextResponse.json({ error: done.error }, { status: done.status ?? 400 });
  return NextResponse.json({ ok: true });
}
