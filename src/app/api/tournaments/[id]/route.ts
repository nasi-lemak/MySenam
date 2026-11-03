import { NextRequest, NextResponse } from "next/server";
import { phoneRefusal } from "@/lib/phone-check";
import { refusal } from "@/lib/api";
import { getSessionUser } from "@/lib/auth";
import { mayShowVenue } from "@/lib/listing";
import { startEntryPayment } from "@/lib/payments";
import { rateLimit } from "@/lib/rate-limit";
import { enter, enterAs, managedEntries, myEntry, tournamentById, tournamentDetail, withdraw } from "@/lib/tournaments";
import { answerReport, openReports, reportResult } from "@/lib/match-reports";
import { guardianEntrant, isEntrantRefusal } from "@/lib/competition-entrants";
import { listManaged } from "@/lib/managed-people";
import { namedForThePublic } from "@/lib/public-names";

export const dynamic = "force-dynamic";

async function visible(req: NextRequest, id: number) {
  const t = await tournamentById(id);
  if (!t || t.status === "cancelled") return null;
  return (await mayShowVenue(t.venueId, req)).show ? t : null;
}

/**
 * The draw, the groups, the bracket and the times; and, signed in, your entry, the entries you made for people you
 * act for (`managed`), those people (`people`, to enter one), and the results waiting on those matches.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const t = await visible(req, Number((await params).id));
  if (!t) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const user = await getSessionUser(req);
  // A counted event (bouldering) names a declared minor by first name and initial (lib/public-names.ts).
  const detail = await namedForThePublic((await tournamentDetail(t.id))!);
  const mine = user ? await myEntry(user.id, t.id) : null;
  const managed = user ? await managedEntries(user.id, t.id) : [];
  const people = user ? (await listManaged(user.id)).map((p) => ({ id: p.id, name: p.displayName })) : [];
  // Reports on the player's own matches (and those of the people they entered) only: who reported, and what.
  const ours = new Set([...(mine ? [mine.id] : []), ...managed.map((e) => e.id)]);
  const myMatches = new Set(detail.matches.filter((m) => (m.a !== null && ours.has(m.a)) || (m.b !== null && ours.has(m.b))).map((m) => m.id));
  const reports = ours.size > 0 && t.resultsBy === "players" ? (await openReports(t.id)).filter((r) => myMatches.has(r.matchId)).map((r) => ({ ...r, disputeNote: undefined })) : [];
  return NextResponse.json({ tournament: detail, mine, managed, people, signedIn: user !== null, reports });
}

/**
 * `{ action: "enter", partnerName?, partnerGender?, teamName?, roster?, entryMark? }` (a team's name and roster of
 * names, or `teamId` and `rosterMemberIds`: a persistent team its captain enters, the roster picked from its members;
 * a performance event's entry time or mark); with `participantId`, somebody the account acts for is entered
 * (their declared `gender` where the event is women's, men's or mixed). `{ action: "withdraw", entryId? }` (before
 * the draw), or `{ action: "pay", entryId? }` — the account's own entry, or one it made for somebody it acts for.
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
    const paying = await startEntryPayment(user, t.id, Number.isInteger(body.entryId) ? (body.entryId as number) : undefined);
    if (!paying.ok) return NextResponse.json({ error: paying.error }, { status: paying.status });
    return NextResponse.json({ url: paying.url });
  }
  if (body.action === "enter") {
    const limited = await rateLimit(req, "booking");
    if (limited) return limited;
    const noPhone = await phoneRefusal(user.id);
    if (noPhone) return refusal(noPhone, 403);
    // Somebody this account acts for, entered by it: the participant is the entrant (lib/competition-entrants.ts).
    const forSomebody = body.participantId !== undefined && body.participantId !== null;
    const entrant = forSomebody ? await guardianEntrant(user, body.participantId) : null;
    if (isEntrantRefusal(entrant)) return NextResponse.json({ error: entrant.error, code: entrant.code }, { status: entrant.status ?? 403 });
    const input = {
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
      gender: typeof body.gender === "string" ? body.gender : undefined,
      // A team the account captains, with the roster picked from its members (lib/teams.ts).
      teamId: Number.isInteger(body.teamId) ? (body.teamId as number) : undefined,
      rosterMemberIds: Array.isArray(body.rosterMemberIds) ? (body.rosterMemberIds as number[]) : undefined,
    };
    const result = entrant ? await enterAs(entrant, t.id, input) : await enter(user, t.id, input);
    if (!result.ok)
      return NextResponse.json({ error: result.error, code: result.code, ...(result.vars ? { vars: result.vars } : {}) }, { status: result.code ? 403 : 409 });
    return NextResponse.json(entrant ? { entry: result.value } : { mine: result.value }, { status: 201 });
  }
  if (body.action === "withdraw") {
    // The account's own entry, or one it made for somebody it still acts for.
    const mine = Number.isInteger(body.entryId)
      ? [await myEntry(user.id, t.id), ...(await managedEntries(user.id, t.id))].find((e) => e?.id === body.entryId) ?? null
      : await myEntry(user.id, t.id);
    if (!mine) return NextResponse.json({ error: "You have not entered." }, { status: 404 });
    if (t.status === "drawn") return NextResponse.json({ error: "The draw is made: ask the venue to withdraw you." }, { status: 409 });
    const result = await withdraw(mine.id);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
    return NextResponse.json({ mine: null });
  }
  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}
