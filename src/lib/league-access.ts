import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin, type Admin } from "./admin-auth";
import { leagueById } from "./leagues";
import { readJsonObject } from "./api";

/** The league, if this admin runs its venue; else the response to send. */
export async function staffLeague(req: NextRequest, rawId: string): Promise<{ admin: Admin; id: number } | NextResponse> {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const league = await leagueById(Number(rawId));
  if (!league) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const denied = denyVenue(admin, league.venueId);
  if (denied) return denied;
  return { admin, id: league.id };
}

/** The JSON body, or the response to send (lib/api.ts `readJsonObject`). */
export async function jsonBody(req: NextRequest): Promise<Record<string, unknown> | NextResponse> {
  return readJsonObject(req);
}
