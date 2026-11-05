import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { myThreads } from "@/lib/messages";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * The signed-in player's messages: their setting, and the contexts they can write in or read, with unread counts, newest first
 * (docs/features/player-messages.md). Nothing is listed while messaging is off. Not a directory: only contexts the person is in.
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const limited = await rateLimit(req, "messageRead");
  if (limited) return limited;
  return NextResponse.json(await myThreads(user.id), { headers: { "Cache-Control": "no-store" } });
}
