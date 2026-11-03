import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin, type Admin } from "./admin-auth";
import { teamLeagueById } from "./team-leagues";

/** The team league, if this admin runs its venue; else the response to send (as lib/league-access.ts does for a box league). */
export async function staffTeamLeague(req: NextRequest, rawId: string): Promise<{ admin: Admin; id: number; name: string; venueId: number } | NextResponse> {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const league = await teamLeagueById(Number(rawId));
  if (!league) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const denied = denyVenue(admin, league.venueId);
  if (denied) return denied;
  return { admin, id: league.id, name: league.name, venueId: league.venueId };
}
