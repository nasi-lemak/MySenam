import { NextRequest, NextResponse } from "next/server";
import { phoneRefusal } from "@/lib/phone-check";
import { refusal } from "@/lib/api";
import { getSessionUser } from "@/lib/auth";
import { mayShowVenue } from "@/lib/listing";
import { startEntryPayment } from "@/lib/payments";
import { rateLimit } from "@/lib/rate-limit";
import { enter, myEntry, tournamentById, tournamentDetail, withdraw } from "@/lib/tournaments";
import { answerReport, openReports, reportResult } from "@/lib/match-reports";

export const dynamic = "force-dynamic";

async function visible(req: NextRequest, id: number) {
  const t = await tournamentById(id);
  if (!t || t.status === "cancelled") return null;
  return (await mayShowVenue(t.venueId, req)).show ? t : null;
}

/** The draw, the groups, the bracket and the times; and, signed in, your entry and the results waiting on your matches. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const t = await visible(req, Number((await params).id));
  if (!t) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const user = await getSessionUser(req);
  const detail = (await tournamentDetail(t.id))!;
  const mine = user ? await myEntry(user.id, t.id) : null;
  // Reports on the player's own matches only: who reported, and what.
  const myMatches = new Set(mine ? detail.matches.filter((m) => m.a === mine.id || m.b === mine.id).map((m) => m.id) : []);
  const reports = mine && t.resultsBy === "players" ? (await openReports(t.id)).filter((r) => myMatches.has(r.matchId)).map((r) => ({ ...r, disputeNote: undefined })) : [];
  return NextResponse.json({ tournament: detail, mine, signedIn: user !== null, reports });
}

/**
 * `{ action: "enter", partnerName?, partnerGender?, teamName?, roster?, entryMark? }` (a team's name and roster of
 * names; a performance event's entry time or mark), `{ action: "withdraw" }` (before the draw), or `{ action: "pay" }`.
 * Where players enter results: `{ action: "report", matchId, winner, score?, walkover? }` (`winner: null` for a draw),
 * `{ action: "confirm", matchId }` or `{ action: "dispute", matchId, note }` by the other side.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in to enter." }, { status: 401 });
  const t = await visible(req, Number((await params).id));
  if (!t) return NextResponse.json({ error: "Not found." }, { status: 404 });
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (body.action === "report") {
    const done = await reportResult(user.id, Number(body.matchId), {
      winner: body.winner === null ? null : Number(body.winner),
      score: typeof body.score === "string" ? body.score : undefined,
      walkover: body.walkover === true,
    });
    if (!done.ok) return NextResponse.json({ error: done.error }, { status: 409 });
    return NextResponse.json({ report: done.value });
  }
  if (body.action === "confirm" || body.action === "dispute") {
    const done = await answerReport(user.id, Number(body.matchId), body.action === "confirm" ? { confirm: true } : { dispute: String(body.note ?? "") });
    if (!done.ok) return NextResponse.json({ error: done.error }, { status: 409 });
    return NextResponse.json({ ok: true });
  }
  if (body.action === "pay") {
    const limited = await rateLimit(req, "payment");
    if (limited) return limited;
    const paying = await startEntryPayment(user, t.id);
    if (!paying.ok) return NextResponse.json({ error: paying.error }, { status: paying.status });
    return NextResponse.json({ url: paying.url });
  }
  if (body.action === "enter") {
    const limited = await rateLimit(req, "booking");
    if (limited) return limited;
    const noPhone = await phoneRefusal(user.id);
    if (noPhone) return refusal(noPhone, 403);
    const result = await enter(user, t.id, {
      partnerName: typeof body.partnerName === "string" ? body.partnerName : undefined,
      partnerGender: typeof body.partnerGender === "string" ? body.partnerGender : undefined,
      teamName: typeof body.teamName === "string" ? body.teamName : undefined,
      roster: Array.isArray(body.roster) ? body.roster : undefined,
      entryMark: typeof body.entryMark === "string" ? body.entryMark : undefined,
      birthDate: typeof body.birthDate === "string" ? body.birthDate : undefined,
      partnerBirthDate: typeof body.partnerBirthDate === "string" ? body.partnerBirthDate : undefined,
      rosterEligible: body.rosterEligible === true,
      guardianName: typeof body.guardianName === "string" ? body.guardianName : undefined,
      guardianConsent: body.guardianConsent === true,
    });
    if (!result.ok) return NextResponse.json({ error: result.error, code: result.code }, { status: result.code ? 403 : 409 });
    return NextResponse.json({ mine: result.value }, { status: 201 });
  }
  if (body.action === "withdraw") {
    const mine = await myEntry(user.id, t.id);
    if (!mine) return NextResponse.json({ error: "You have not entered." }, { status: 404 });
    if (t.status === "drawn") return NextResponse.json({ error: "The draw is made: ask the venue to withdraw you." }, { status: 409 });
    const result = await withdraw(mine.id);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
    return NextResponse.json({ mine: null });
  }
  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}
