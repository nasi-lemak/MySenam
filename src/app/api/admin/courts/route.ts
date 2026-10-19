import { NextRequest, NextResponse } from "next/server";
import { denyVenue, isOwner, requireAdmin } from "@/lib/admin-auth";
import { ALERT_EVERY, courtCount, crossed, VENUE_CAPS } from "@/lib/limits";
import { tellOwners } from "@/lib/owner-alerts";
import { createCourt, getVenue } from "@/lib/store";
import { MAX_CAPACITY, MAX_DEPOSIT, Sport, SPORTS } from "@/lib/types";
import { logAction } from "@/lib/activity";

export const dynamic = "force-dynamic";

const MAX_RATE = 1000;

export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { venueId, name, sport, offPeakRate, peakRate, capacity, deposit } = (body ?? {}) as Record<
    string,
    unknown
  >;

  if (!Number.isInteger(venueId) || (venueId as number) <= 0)
    return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId as number);
  if (denied) return denied;
  if (typeof name !== "string" || name.trim().length < 2)
    return NextResponse.json({ error: "Court name is required." }, { status: 400 });
  if (typeof sport !== "string" || !SPORTS.includes(sport as Sport))
    return NextResponse.json({ error: "Unknown sport." }, { status: 400 });
  for (const [label, rate] of [["offPeakRate", offPeakRate], ["peakRate", peakRate]] as const) {
    if (!Number.isInteger(rate) || (rate as number) < 0 || (rate as number) > MAX_RATE)
      return NextResponse.json({ error: `${label} must be RM0–${MAX_RATE}. RM0 makes it free.` }, { status: 400 });
  }

  if (capacity !== undefined &&
      (!Number.isInteger(capacity) || (capacity as number) < 1 || (capacity as number) > MAX_CAPACITY))
    return NextResponse.json(
      { error: `Capacity must be 1–${MAX_CAPACITY}.` },
      { status: 400 }
    );

  if (deposit !== undefined &&
      (!Number.isInteger(deposit) || (deposit as number) < 0 || (deposit as number) > MAX_DEPOSIT))
    return NextResponse.json({ error: `A deposit must be RM0–${MAX_DEPOSIT}.` }, { status: 400 });

  // A venue's own staff can add so many; past that, the platform owner does.
  const before = await courtCount(venueId as number);
  if (!isOwner(admin) && before >= VENUE_CAPS.courts)
    return NextResponse.json(
      { error: `A venue can add up to ${VENUE_CAPS.courts} courts itself. Ask the platform to add more.` },
      { status: 409 }
    );

  const result = await createCourt({
    venueId: venueId as number,
    name: name.trim(),
    sport: sport as Sport,
    offPeakRate: offPeakRate as number,
    peakRate: peakRate as number,
    capacity: (capacity as number) ?? 1,
    deposit: (deposit as number) ?? 0,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  if (!isOwner(admin) && crossed(before, before + 1, ALERT_EVERY.courts)) {
    const venue = await getVenue(venueId as number);
    await tellOwners(
      `${venue?.name ?? "A venue"} now has ${before + 1} courts`,
      `${admin.email} has added courts to ${venue?.name ?? `venue ${venueId}`}; it now has ${before + 1}.`
    );
  }
  await logAction(admin, {
    venueId: venueId as number,
    action: "court.created",
    detail: `${result.court.name}, RM${result.court.offPeakRate} off-peak / RM${result.court.peakRate} peak`,
  });
  return NextResponse.json({ court: result.court }, { status: 201 });
}
