import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { blockPlayer, myBlocks, unblockPlayer } from "@/lib/player-safety";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** Who the signed-in player has blocked. */
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  return NextResponse.json({ blocks: await myBlocks(user.id) });
}

/** `{ userId }`: block somebody you have come across here (lib/player-safety.ts). */
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const limited = await rateLimit(req, "social");
  if (limited) return limited;
  const body = (await req.json().catch(() => null)) as { userId?: unknown } | null;
  if (!body || !Number.isInteger(body.userId)) return NextResponse.json({ error: "Who?" }, { status: 400 });
  const done = await blockPlayer(user.id, body.userId as number);
  if (!done.ok) return NextResponse.json({ error: done.error }, { status: done.status ?? 400 });
  return NextResponse.json({ blocks: await myBlocks(user.id) });
}

/** `{ userId }`: undo a block. */
export async function DELETE(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { userId?: unknown } | null;
  if (!body || !Number.isInteger(body.userId)) return NextResponse.json({ error: "Who?" }, { status: 400 });
  await unblockPlayer(user.id, body.userId as number);
  return NextResponse.json({ blocks: await myBlocks(user.id) });
}
