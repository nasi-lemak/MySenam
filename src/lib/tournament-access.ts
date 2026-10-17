import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin, type Admin } from "./admin-auth";
import { tournamentById } from "./tournaments";

/** The tournament, if this admin runs its venue; else the response to send. */
export async function staffTournament(req: NextRequest, rawId: string): Promise<{ admin: Admin; id: number } | NextResponse> {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const t = await tournamentById(Number(rawId));
  if (!t) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const denied = denyVenue(admin, t.venueId);
  if (denied) return denied;
  return { admin, id: t.id };
}

