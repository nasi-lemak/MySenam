import { NextRequest, NextResponse } from "next/server";
import { readMinute } from "@/lib/api";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { createCompetition, listCompetitions } from "@/lib/competitions";
import type { Sport } from "@/lib/types";

export const dynamic = "force-dynamic";

/** `?venueId=` — a venue's competitions, for its staff. */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(req.nextUrl.searchParams.get("venueId"));
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "Which venue?" }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  return NextResponse.json({ competitions: await listCompetitions([venueId]) });
}

/**
 * A new competition, holding its courts for its days and hours at once; its
 * divisions are added as tournaments with its `competitionId`.
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  let b: Record<string, unknown>;
  try {
    b = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const venueId = Number(b.venueId);
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "Which venue?" }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const result = await createCompetition(
    {
      venueId,
      name: String(b.name ?? ""),
      sport: String(b.sport ?? "") as Sport,
      startsOn: String(b.startsOn ?? ""),
      endsOn: String(b.endsOn ?? ""),
      startMin: readMinute(b, "startMin", "startHour"),
      endMin: readMinute(b, "endMin", "endHour"),
      ...(b.matchMinutes !== undefined ? { matchMinutes: Number(b.matchMinutes) } : {}),
      courtIds: Array.isArray(b.courtIds) ? b.courtIds.map(Number) : [],
      maxDivisionsPerPlayer: b.maxDivisionsPerPlayer === null || b.maxDivisionsPerPlayer === undefined || b.maxDivisionsPerPlayer === "" ? null : Number(b.maxDivisionsPerPlayer),
      description: typeof b.description === "string" ? b.description : undefined,
    },
    admin.id
  );
  if (!result.ok) return NextResponse.json({ error: result.error, clashes: result.clashes }, { status: 400 });
  return NextResponse.json({ competition: result.value }, { status: 201 });
}
