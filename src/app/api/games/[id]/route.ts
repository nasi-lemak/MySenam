import { NextRequest, NextResponse } from "next/server";
import { phoneRefusal } from "@/lib/phone-check";
import { refusal } from "@/lib/api";
import { getSessionUser } from "@/lib/auth";
import { askToJoin, closeGame, leaveGame } from "@/lib/games";
import { startSharePayment } from "@/lib/payments";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * `{ action }` on one game, by the signed-in player: "join" (ask, or join
 * outright where the host lets everybody in), "leave", "pay" (your share,
 * online, to the venue — answers with where to pay), or, for its host, "close".
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in to join a game." }, { status: 401 });
  const gameId = Number((await params).id);
  if (!Number.isInteger(gameId) || gameId <= 0) return NextResponse.json({ error: "Invalid game." }, { status: 400 });
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (body.action === "pay") {
    const limited = await rateLimit(req, "payment");
    if (limited) return limited;
    const paying = await startSharePayment(user, gameId);
    if (!paying.ok) return NextResponse.json({ error: paying.error }, { status: paying.status });
    return NextResponse.json({ url: paying.url, amount: paying.amount });
  }
  if (body.action === "join") {
    const limited = await rateLimit(req, "booking");
    if (limited) return limited;
    const noPhone = await phoneRefusal(user.id);
    if (noPhone) return refusal(noPhone, 403);
  }
  const result =
    body.action === "join"
      ? await askToJoin(user, gameId)
      : body.action === "leave"
        ? await leaveGame(user.id, gameId)
        : body.action === "close"
          ? await closeGame(user.id, gameId)
          : null;
  if (!result) return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  if (!result.ok) return NextResponse.json({ error: result.error, code: result.code }, { status: result.status ?? 409 });
  return NextResponse.json({ game: result.game });
}
