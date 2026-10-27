import { NextRequest, NextResponse } from "next/server";
import { logAction } from "@/lib/activity";
import { counterEntrant, isEntrantRefusal } from "@/lib/competition-entrants";
import { enterAs, tournamentById, tournamentDetail } from "@/lib/tournaments";
import { staffTournament } from "@/lib/tournament-access";

export const dynamic = "force-dynamic";

/**
 * Staff enter somebody at the counter (front desk or a manager, as a counter
 * booking): `{ phone, name }` on staff's word, or `{ phone, participantId }`
 * for a participant the venue knows whose live guardian is on that number;
 * then what any entry says — `partnerName?`, `partnerGender?`, `gender?` (the
 * entrant's, declared, in a women's, men's or mixed event), `teamName?`,
 * `roster?`, `entryMark?`, `birthDate?`, `partnerBirthDate?`,
 * `rosterEligible?`, `guardianName?`, `guardianConsent?`. The same checks as a
 * player entering themself (lib/tournaments.ts `enterAs`); in the activity log.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const found = await staffTournament(req, (await params).id);
  if (found instanceof NextResponse) return found;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("not an object");
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const t = (await tournamentById(found.id))!;
  const entrant = await counterEntrant(t.venueId, found.admin, body);
  if (isEntrantRefusal(entrant)) return NextResponse.json({ error: entrant.error, code: entrant.code, ...(entrant.vars ? { vars: entrant.vars } : {}) }, { status: entrant.status ?? 409 });
  const str = (v: unknown) => (typeof v === "string" ? v : undefined);
  const result = await enterAs(entrant, t.id, {
    partnerName: str(body.partnerName),
    partnerGender: str(body.partnerGender),
    gender: str(body.gender),
    teamName: str(body.teamName),
    roster: Array.isArray(body.roster) ? body.roster : undefined,
    entryMark: str(body.entryMark),
    birthDate: str(body.birthDate),
    partnerBirthDate: str(body.partnerBirthDate),
    rosterEligible: body.rosterEligible === true,
    guardianName: str(body.guardianName),
    guardianConsent: body.guardianConsent === true,
  });
  if (!result.ok) return NextResponse.json({ error: result.error, code: result.code, ...(result.vars ? { vars: result.vars } : {}) }, { status: 409 });
  await logAction(found.admin, {
    venueId: t.venueId,
    action: "tournament.entered_at_counter",
    detail: `${t.name}: ${result.value.name}${result.value.status === "waitlisted" ? " (waiting list)" : ""}`,
  });
  return NextResponse.json({ entry: result.value, tournament: await tournamentDetail(t.id, { forStaff: true }) }, { status: 201 });
}
