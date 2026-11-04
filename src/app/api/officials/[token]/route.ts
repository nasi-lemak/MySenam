import { NextRequest, NextResponse } from "next/server";
import { officialByToken, officialResult } from "@/lib/match-reports";
import { rateLimit } from "@/lib/rate-limit";
import { tournamentDetail, type ResultInput } from "@/lib/tournaments";
import { jsonObject } from "@/lib/api";
import { logAction } from "@/lib/activity";
import { dayBoard, officialDay } from "@/lib/tournament-day";
import { officialPerformances, officialPerformanceView, requestCorrection, withdrawCorrection } from "@/lib/official-performances";

export const dynamic = "force-dynamic";

/** The tournament an official's link is for, with its matches: no account needed, the link is the key. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const limited = await rateLimit(req, "official");
  if (limited) return limited;
  // Also the days after a climbing event has finished: its results and a correction request, and nothing else (`link.phase`).
  const who = await officialByToken((await params).token, { afterFinish: true });
  if (!who) return NextResponse.json({ error: "This link no longer works. Ask the venue for a new one." }, { status: 404 });
  // A climbing event: which rounds are open, the official's recent entries and their correction requests.
  const performance = await officialPerformanceView((await params).token);
  return NextResponse.json({
    official: who.official,
    link: { phase: who.phase, until: who.until },
    tournament: await tournamentDetail(who.tournamentId),
    day: await dayBoard(who.tournamentId),
    ...(performance ? { performance } : {}),
  });
}

/**
 * `{ matchId, winner, score?, walkover?, retired? }` — a result, entered as staff would, under the official's name; or
 * `{ matchId, action: "call" | "start" | "release" }` — call the match's players where it is held once its time has come,
 * mark it started, or take the call back (bringing a match forward or sending it elsewhere is a manager's), each in
 * the activity log under the official's name. For a climbing (counted) event: `{ matchId, performances: [{ entryId, counts?, status?, note? }] }`
 * enters (or re-enters) the counts of a round still open, the same save as the dashboard's (`counts`: `[{ unit, attempts, zone?, top? }]` for
 * boulders, `[{ unit: 1, attempts, hold, plus? }]` for a height), with `preview: true` what it would change, nothing changed; a finalised round
 * (409 `OFC_ROUND_FINAL`) is changed by `{ action: "correction_request", matchId, reason, performances }`, which a manager reviews, and
 * `{ action: "correction_withdraw", requestId }` takes one back. A link works for its own event only; for anything else it is refused.
 * For `OFFICIAL_AFTER_FINISH_DAYS` days after a climbing event has finished the link still shows the results (GET, `link.phase: "finished"`)
 * and takes `correction_request` and `correction_withdraw`; entering counts is then 409 `OFC_EVENT_FINISHED`, and a result, a call, start or
 * release is refused as for any link of a finished event.
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
  if (body.action === "correction_request" || body.action === "correction_withdraw" || Array.isArray(body.performances)) {
    const token = (await params).token;
    if (body.action === "correction_request") {
      const made = await requestCorrection(token, Number(body.matchId), body.reason, body.performances);
      if (!made.ok) return NextResponse.json({ error: made.error, code: made.code }, { status: 409 });
      return NextResponse.json({ request: made.value, performance: await officialPerformanceView(token) });
    }
    if (body.action === "correction_withdraw") {
      const gone = await withdrawCorrection(token, Number(body.requestId));
      if (!gone.ok) return NextResponse.json({ error: gone.error, code: gone.code }, { status: 409 });
      return NextResponse.json({ performance: await officialPerformanceView(token) });
    }
    const confirm = body.confirm && typeof body.confirm === "object" && typeof (body.confirm as Record<string, unknown>).token === "string" ? { token: (body.confirm as { token: string }).token } : undefined;
    const done = await officialPerformances(token, Number(body.matchId), body.performances, { preview: body.preview === true, confirm });
    if (!done.ok) return NextResponse.json({ error: done.error, code: done.code }, { status: 409 });
    if ("preview" in done) return NextResponse.json({ preview: done.value });
    return NextResponse.json({ tournament: done.value, performance: await officialPerformanceView(token) });
  }
  // A link enters results and asks for corrections: nothing else is an action it can take.
  if (body.action !== undefined) return NextResponse.json({ error: "Unknown action." }, { status: 400 });
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
