import { isActivity } from "@/lib/activities";
import { NextRequest, NextResponse } from "next/server";
import { denyVenue, isOwner, requireAdmin } from "@/lib/admin-auth";
import { ALERT_EVERY, courtCount, crossed, VENUE_CAPS } from "@/lib/limits";
import { tellOwners } from "@/lib/owner-alerts";
import { getVenue } from "@/lib/store";
import { createResources, MAX_BATCH } from "@/lib/resources";
import { MAX_CAPACITY, MAX_DEPOSIT, Sport } from "@/lib/types";
import { logAction } from "@/lib/activity";
import { money, isAmount } from "@/lib/region";

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
  const { venueId, name, sport, offPeakRate, peakRate, capacity, deposit, count, noun, perPlayer, maxPlayers, also, setting } = (body ?? {}) as Record<
    string,
    unknown
  >;
  // Several at once from an activity's template ("8 lanes"): `count`, named after `noun`.
  const many = count !== undefined && count !== null;

  if (!Number.isInteger(venueId) || (venueId as number) <= 0)
    return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId as number);
  if (denied) return denied;
  if (!many && (typeof name !== "string" || name.trim().length < 2))
    return NextResponse.json({ error: "Court name is required." }, { status: 400 });
  if (many && (!Number.isInteger(count) || (count as number) < 1 || (count as number) > MAX_BATCH))
    return NextResponse.json({ error: `Make 1 to ${MAX_BATCH} at a time.` }, { status: 400 });
  if (noun !== undefined && noun !== null && typeof noun !== "string") return NextResponse.json({ error: "Unknown noun." }, { status: 400 });
  if (also !== undefined && also !== null && !Array.isArray(also)) return NextResponse.json({ error: "also is a list of activities." }, { status: 400 });
  if (typeof sport !== "string" || !(await isActivity(sport)))
    return NextResponse.json({ error: "Unknown sport." }, { status: 400 });
  for (const [label, rate] of [["offPeakRate", offPeakRate], ["peakRate", peakRate]] as const) {
    if (!isAmount(rate, 0, MAX_RATE))
      return NextResponse.json({ error: `${label} must be ${money(0)}–${MAX_RATE}. ${money(0)} makes it free.` }, { status: 400 });
  }

  if (capacity !== undefined &&
      (!Number.isInteger(capacity) || (capacity as number) < 1 || (capacity as number) > MAX_CAPACITY))
    return NextResponse.json(
      { error: `Capacity must be 1–${MAX_CAPACITY}.` },
      { status: 400 }
    );

  if (deposit !== undefined &&
      !isAmount(deposit, 0, MAX_DEPOSIT))
    return NextResponse.json({ error: `A deposit must be ${money(0)}–${MAX_DEPOSIT}.` }, { status: 400 });

  // A venue's own staff can add so many; past that, the platform owner does.
  const before = await courtCount(venueId as number);
  const adding = many ? (count as number) : 1;
  if (!isOwner(admin) && before + adding > VENUE_CAPS.courts)
    return NextResponse.json(
      { error: `A venue can add up to ${VENUE_CAPS.courts} courts itself. Ask the platform to add more.` },
      { status: 409 }
    );

  const result = await createResources({
    venueId: venueId as number,
    sport: sport as Sport,
    ...(many ? { count: count as number } : { name: (name as string).trim() }),
    ...(typeof noun === "string" ? { noun } : {}),
    offPeakRate: offPeakRate as number,
    peakRate: peakRate as number,
    capacity: (capacity as number) ?? 1,
    deposit: (deposit as number) ?? 0,
    perPlayer: perPlayer === true,
    maxPlayers: Number.isInteger(maxPlayers) ? (maxPlayers as number) : null,
    ...(setting !== undefined ? { setting: setting as "indoor" | "outdoor" | null } : {}),
    also: Array.isArray(also) ? (also as { sport: Sport; offPeakRate?: number | null; peakRate?: number | null }[]) : [],
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.error === "Unknown sport." ? 400 : 409 });
  const after = before + result.courts.length;
  if (!isOwner(admin) && crossed(before, after, ALERT_EVERY.courts)) {
    const venue = await getVenue(venueId as number);
    await tellOwners(
      `${venue?.name ?? "A venue"} now has ${after} courts`,
      `${admin.email} has added courts to ${venue?.name ?? `venue ${venueId}`}; it now has ${after}.`
    );
  }
  for (const court of result.courts)
    await logAction(admin, {
      venueId: venueId as number,
      action: "court.created",
      detail: `${court.name}, ${money(court.offPeakRate)} off-peak / ${money(court.peakRate)} peak`,
    });
  return NextResponse.json({ court: result.courts[0], courts: result.courts }, { status: 201 });
}
