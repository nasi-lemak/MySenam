import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { createCourt } from "@/lib/store";
import { Sport, SPORTS } from "@/lib/types";

export const dynamic = "force-dynamic";

const MAX_RATE = 1000;

export async function POST(req: NextRequest) {
  const admin = requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { venueId, name, sport, offPeakRate, peakRate } = (body ?? {}) as Record<string, unknown>;

  if (!Number.isInteger(venueId) || (venueId as number) <= 0)
    return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId as number);
  if (denied) return denied;
  if (typeof name !== "string" || name.trim().length < 2)
    return NextResponse.json({ error: "Court name is required." }, { status: 400 });
  if (typeof sport !== "string" || !SPORTS.includes(sport as Sport))
    return NextResponse.json({ error: "Unknown sport." }, { status: 400 });
  for (const [label, rate] of [["offPeakRate", offPeakRate], ["peakRate", peakRate]] as const) {
    if (!Number.isInteger(rate) || (rate as number) < 1 || (rate as number) > MAX_RATE)
      return NextResponse.json({ error: `${label} must be RM1–${MAX_RATE}.` }, { status: 400 });
  }

  const result = createCourt({
    venueId: venueId as number,
    name: name.trim(),
    sport: sport as Sport,
    offPeakRate: offPeakRate as number,
    peakRate: peakRate as number,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  return NextResponse.json({ court: result.court }, { status: 201 });
}
