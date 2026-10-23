import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { courtAccess, getCourt, setCourtFeatures, updateCourt } from "@/lib/store";
import { setCourtActivities, setCourtNoun } from "@/lib/resources";
import { RESOURCE_NOUNS } from "@/lib/activity-catalogue";
import { isSurface, type CourtFeatures } from "@/lib/facilities";
import { MAX_ACCESS_CODE, MAX_CAPACITY, MAX_DEPOSIT, MIN_ACCESS_CODE } from "@/lib/types";
import { logAction } from "@/lib/activity";
import { money, isAmount } from "@/lib/region";

export const dynamic = "force-dynamic";

const MAX_RATE = 1000;

/** One court, with the door code staff are allowed to see for it. */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  const { id } = await params;
  const courtId = Number(id);
  if (!Number.isInteger(courtId) || courtId <= 0)
    return NextResponse.json({ error: "Invalid court id." }, { status: 400 });

  const court = await getCourt(courtId);
  if (!court) return NextResponse.json({ error: "Court not found." }, { status: 404 });
  const denied = denyVenue(admin, court.venueId);
  if (denied) return denied;

  return NextResponse.json(
    { court, access: await courtAccess(courtId) },
    { headers: { "Cache-Control": "no-store" } }
  );
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  const { id } = await params;
  const courtId = Number(id);
  if (!Number.isInteger(courtId) || courtId <= 0)
    return NextResponse.json({ error: "Invalid court id." }, { status: 400 });

  const court = await getCourt(courtId);
  if (!court) return NextResponse.json({ error: "Court not found." }, { status: 404 });
  const denied = denyVenue(admin, court.venueId);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const {
    name,
    offPeakRate,
    peakRate,
    capacity,
    memberOffPeakRate,
    memberPeakRate,
    deposit,
    unmanned,
    accessCode,
    perPlayer,
    maxPlayers,
  } = (body ?? {}) as Record<string, unknown>;

  const changes: {
    name?: string;
    offPeakRate?: number;
    peakRate?: number;
    memberOffPeakRate?: number | null;
    memberPeakRate?: number | null;
    capacity?: number;
    deposit?: number;
    unmanned?: boolean;
    accessCode?: string | null;
    perPlayer?: boolean;
    maxPlayers?: number | null;
  } = {};
  if (perPlayer !== undefined) {
    if (typeof perPlayer !== "boolean") return NextResponse.json({ error: "perPlayer must be true or false." }, { status: 400 });
    changes.perPlayer = perPlayer;
  }
  if (maxPlayers !== undefined) {
    if (maxPlayers !== null && typeof maxPlayers !== "number") return NextResponse.json({ error: "maxPlayers must be a number, or null." }, { status: 400 });
    changes.maxPlayers = maxPlayers as number | null;
  }
  if (name !== undefined) {
    if (typeof name !== "string" || name.trim().length < 2)
      return NextResponse.json({ error: "Court name is too short." }, { status: 400 });
    changes.name = name;
  }
  for (const [key, rate] of [["offPeakRate", offPeakRate], ["peakRate", peakRate]] as const) {
    if (rate !== undefined) {
      if (!isAmount(rate, 0, MAX_RATE))
        return NextResponse.json({ error: `${key} must be ${money(0)}–${MAX_RATE}. ${money(0)} makes it free.` }, { status: 400 });
      changes[key] = rate as number;
    }
  }
  // null clears a member rate, putting members back on the public price.
  for (const [key, rate] of [
    ["memberOffPeakRate", memberOffPeakRate],
    ["memberPeakRate", memberPeakRate],
  ] as const) {
    if (rate === undefined) continue;
    if (rate === null) {
      changes[key] = null;
      continue;
    }
    if (!isAmount(rate, 0, MAX_RATE))
      return NextResponse.json({ error: `${key} must be ${money(0)}–${MAX_RATE}, or blank.` }, { status: 400 });
    changes[key] = rate as number;
  }

  if (capacity !== undefined) {
    if (!Number.isInteger(capacity) || (capacity as number) < 1 || (capacity as number) > MAX_CAPACITY)
      return NextResponse.json(
        { error: `Capacity must be 1–${MAX_CAPACITY}.` },
        { status: 400 }
      );
    changes.capacity = capacity as number;
  }

  if (deposit !== undefined) {
    if (!isAmount(deposit, 0, MAX_DEPOSIT))
      return NextResponse.json({ error: `A deposit must be ${money(0)}–${MAX_DEPOSIT}.` }, { status: 400 });
    changes.deposit = deposit as number;
  }

  if (unmanned !== undefined) {
    if (typeof unmanned !== "boolean")
      return NextResponse.json({ error: "unmanned must be true or false." }, { status: 400 });
    changes.unmanned = unmanned;
  }

  // null clears the code, which also closes the door on unmanned use.
  if (accessCode !== undefined) {
    if (accessCode !== null && typeof accessCode !== "string")
      return NextResponse.json({ error: "accessCode must be text, or null." }, { status: 400 });
    if (typeof accessCode === "string" && accessCode.trim() !== "") {
      const trimmed = accessCode.trim();
      if (trimmed.length < MIN_ACCESS_CODE || trimmed.length > MAX_ACCESS_CODE)
        return NextResponse.json(
          { error: `A door code must be ${MIN_ACCESS_CODE}–${MAX_ACCESS_CODE} characters.` },
          { status: 400 }
        );
    }
    changes.accessCode = accessCode as string | null;
  }

  // What the court is like, for players comparing venues.
  const input = (body ?? {}) as Record<string, unknown>;
  const features: Partial<CourtFeatures> = {};
  if (input.setting !== undefined) {
    if (input.setting !== null && input.setting !== "indoor" && input.setting !== "outdoor")
      return NextResponse.json({ error: "Indoor, outdoor, or not said." }, { status: 400 });
    features.setting = input.setting;
  }
  for (const flag of ["aircon", "floodlit"] as const) {
    if (input[flag] === undefined) continue;
    if (typeof input[flag] !== "boolean") return NextResponse.json({ error: `${flag} must be true or false.` }, { status: 400 });
    features[flag] = input[flag];
  }
  if (input.surface !== undefined) {
    if (input.surface !== null && !isSurface(input.surface))
      return NextResponse.json({ error: "Choose a surface from the list." }, { status: 400 });
    features.surface = input.surface;
  }

  // What it can be booked for besides its main activity, each at its own rates or the court's (lib/resources.ts).
  let other = false;
  if (input.activities !== undefined) {
    if (!Array.isArray(input.activities)) return NextResponse.json({ error: "activities is a list." }, { status: 400 });
    const set = await setCourtActivities(courtId, input.activities as { sport: string; offPeakRate?: number | null; peakRate?: number | null }[]);
    if (!set.ok) return NextResponse.json({ error: set.error }, { status: set.error === "Unknown sport." ? 400 : 409 });
    await logAction(admin, {
      venueId: court.venueId,
      action: "court.changed",
      detail: `${court.name}: also booked for ${set.court.activities.filter((x) => x.sport !== court.sport).map((x) => x.sport).join(", ") || "nothing else"}`,
    });
    other = true;
  }
  // What one of it is called ("lane", "bay"); null: what its activity's are.
  if (input.noun !== undefined) {
    if (input.noun !== null && (typeof input.noun !== "string" || !(RESOURCE_NOUNS as readonly string[]).includes(input.noun)))
      return NextResponse.json({ error: "Choose what it is called from the list." }, { status: 400 });
    await setCourtNoun(courtId, input.noun as string | null);
    other = true;
  }

  if (Object.keys(changes).length === 0 && Object.keys(features).length === 0 && other)
    return NextResponse.json({ court: await getCourt(courtId), access: await courtAccess(courtId) }, { headers: { "Cache-Control": "no-store" } });
  if (Object.keys(changes).length === 0 && Object.keys(features).length === 0)
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 });
  if (Object.keys(changes).length === 0) {
    const updated = await setCourtFeatures(courtId, features);
    return NextResponse.json({ court: updated, access: await courtAccess(courtId) }, { headers: { "Cache-Control": "no-store" } });
  }

  const result = await updateCourt(courtId, changes);
  if (!result.ok)
    return NextResponse.json(
      { error: result.error },
      { status: result.error === "Court not found." ? 404 : 409 }
    );
  // What changed, as it was and as it is: prices above all.
  await logAction(admin, {
    venueId: court.venueId,
    action: "court.changed",
    detail: `${court.name}: ${Object.entries(changes)
      .map(([k, v]) => `${k} ${String((court as unknown as Record<string, unknown>)[k] ?? "—")} → ${String(v ?? "—")}`)
      .join(", ")}`,
  });
  // Only once the rest has been accepted, so a refused change changes nothing.
  const saved = Object.keys(features).length > 0 ? ((await setCourtFeatures(courtId, features)) ?? result.court) : result.court;
  return NextResponse.json(
    { court: saved, access: await courtAccess(courtId) },
    { headers: { "Cache-Control": "no-store" } }
  );
}
