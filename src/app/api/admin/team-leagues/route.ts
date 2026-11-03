import { NextRequest, NextResponse } from "next/server";
import { logAction } from "@/lib/activity";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { readJsonObject, refusal } from "@/lib/api";
import { getDb } from "@/lib/db";
import { TEMPLATES } from "@/lib/competition-templates";
import { createTeamLeague, listTeamLeagues } from "@/lib/team-leagues";

export const dynamic = "force-dynamic";

/** `?venueId=` — a venue's leagues of teams, with the head-to-head templates one can be scored by and the venue's courts. */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(req.nextUrl.searchParams.get("venueId"));
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "Which venue?" }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const courts = (await getDb()
    .prepare(
      `SELECT c.id, c.name, (SELECT string_agg(ca.sport, ',') FROM court_activities ca WHERE ca.court_id = c.id) AS sports
         FROM courts c WHERE c.venue_id = ? ORDER BY c.id`
    )
    .all(venueId)) as { id: number; name: string; sports: string | null }[];
  return NextResponse.json({
    leagues: await listTeamLeagues([venueId]),
    templates: TEMPLATES.filter((t) => !t.rules.performance).map((t) => ({ key: t.key, label: t.label, sports: t.sports, rubbers: t.rubbers ?? ["team"], matchMinutes: t.matchMinutes })),
    courts: courts.map((c) => ({ id: c.id, name: c.name, sports: c.sports ? c.sports.split(",") : [] })),
  });
}

/** A new league of teams, forming (a manager's): `{ venueId, name, sport, courtIds, startsOn, endsOn, ... }` (lib/team-leagues.ts). */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const b = await readJsonObject(req);
  if (b instanceof NextResponse) return b;
  const venueId = Number(b.venueId);
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "Which venue?" }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const made = await createTeamLeague({ ...b, venueId, name: b.name, sport: b.sport, startsOn: b.startsOn, endsOn: b.endsOn, courtIds: b.courtIds }, admin.id);
  if (!made.ok) return refusal(made, made.status ?? 400);
  await logAction(admin, {
    venueId,
    action: "team_league.created",
    detail: `${made.value.name}: ${made.value.legs === 2 ? "home and away" : "once each"}, ${made.value.startsOn} to ${made.value.endsOn}`,
  });
  return NextResponse.json({ league: made.value }, { status: 201 });
}
