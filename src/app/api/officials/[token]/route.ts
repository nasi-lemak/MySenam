import { NextRequest, NextResponse } from "next/server";
import { officialByToken, officialResult } from "@/lib/match-reports";
import { rateLimit } from "@/lib/rate-limit";
import { tournamentDetail, type ResultInput } from "@/lib/tournaments";
import { jsonObject } from "@/lib/api";

export const dynamic = "force-dynamic";

/** The tournament an official's link is for, with its matches: no account needed, the link is the key. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const limited = await rateLimit(req, "official");
  if (limited) return limited;
  const who = await officialByToken((await params).token);
  if (!who) return NextResponse.json({ error: "This link no longer works. Ask the venue for a new one." }, { status: 404 });
  return NextResponse.json({ official: who.official, tournament: await tournamentDetail(who.tournamentId) });
}

/** `{ matchId, winner, score?, walkover?, retired? }` — a result, entered as staff would, under the official's name. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const limited = await rateLimit(req, "official");
  if (limited) return limited;
  let body: Record<string, unknown>;
  try {
    body = (await jsonObject(req)) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
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
