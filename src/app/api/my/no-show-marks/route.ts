import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { jsonObject } from "@/lib/api";
import { answerNoShow, myNoShowMarks } from "@/lib/no-show-marks";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** The signed-in player's no-show marks that count against them or wait for a review (lib/no-show-marks.ts). */
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  return NextResponse.json({ marks: await myNoShowMarks(user.id) });
}

/**
 * `{ playerId, answer }`: the player says a mark against them is wrong. Until a manager has looked at it, it does not count. One
 * answer to a mark; a few at a time; none after several that a reviewer did not accept.
 */
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const limited = await rateLimit(req, "social");
  if (limited) return limited;
  let body: Record<string, unknown>;
  try {
    body = (await jsonObject(req)) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!Number.isInteger(body.playerId)) return NextResponse.json({ error: "Which mark?" }, { status: 400 });
  const done = await answerNoShow(user.id, body.playerId as number, body.answer);
  if (!done.ok) return NextResponse.json({ error: done.error, code: done.code }, { status: done.status ?? 409 });
  return NextResponse.json({ marks: await myNoShowMarks(user.id) });
}
