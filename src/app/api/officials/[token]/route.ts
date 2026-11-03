import { NextRequest, NextResponse } from "next/server";
import { officialByToken, officialResult } from "@/lib/match-reports";
import { rateLimit } from "@/lib/rate-limit";
import { tournamentDetail, type ResultInput } from "@/lib/tournaments";
import { jsonObject } from "@/lib/api";
import { logAction } from "@/lib/activity";
import { dayBoard, officialDay } from "@/lib/tournament-day";

export const dynamic = "force-dynamic";

/** The tournament an official's link is for, with its matches: no account needed, the link is the key. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const limited = await rateLimit(req, "official");
  if (limited) return limited;
  const who = await officialByToken((await params).token);
  if (!who) return NextResponse.json({ error: "This link no longer works. Ask the venue for a new one." }, { status: 404 });
  return NextResponse.json({ official: who.official, tournament: await tournamentDetail(who.tournamentId), day: await dayBoard(who.tournamentId) });
}

/**
 * `{ matchId, winner, score?, walkover?, retired? }` — a result, entered as staff would, under the official's name; or
 * `{ matchId, action: "call" | "start" | "release" }` — call the match's players where it is held once its time has come,
 * mark it started, or take the call back (bringing a match forward or sending it elsewhere is a manager's), each in
 * the activity log under the official's name.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const limited = await rateLimit(req, "official");
  if (limited) return limited;
  let body: Record<string, unknown>;
  try {
    body = (await jsonObject(req)) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (body.action === "call" || body.action === "start" || body.action === "release") {
    const done = await officialDay((await params).token, body.action, Number(body.matchId));
    if (!done.ok) return NextResponse.json({ error: done.error, ...(done.code ? { code: done.code } : {}), ...(done.vars ? { vars: done.vars } : {}) }, { status: 409 });
    await logAction(
      { id: null, name: `Official: ${done.value.officialName}` },
      {
        venueId: done.value.venueId,
        action: body.action === "call" ? "tournament.match_called" : body.action === "start" ? "tournament.match_started" : "tournament.call_released",
        detail: `${done.value.tournamentName}: match ${Number(body.matchId)}`,
      }
    );
    return NextResponse.json({ day: done.value.board });
  }
  const input: ResultInput = {
    winner: body.winner === null ? null : Number(body.winner),
    score: typeof body.score === "string" ? body.score : undefined,
    walkover: body.walkover === true,
    retired: body.retired === true,
  };
  const done = await officialResult((await params).token, Number(body.matchId), input);
  if (!done.ok) return NextResponse.json({ error: done.error, code: done.code }, { status: 409 });
  return NextResponse.json({ tournament: done.value });
}
