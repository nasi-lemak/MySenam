import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { blockSlots, getCourt, unblockSlots } from "@/lib/store";
import { isValidDateString } from "@/lib/time";
import { readTime } from "@/lib/api";

export const dynamic = "force-dynamic";

async function parseBody(req: NextRequest) {
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const { courtId, date, reason, places } = body ?? {};
    if (!Number.isInteger(courtId) || (courtId as number) <= 0) return null;
    if (typeof date !== "string" || !isValidDateString(date)) return null;
    // Exact minutes (start and end), or the staff schedule's columns (hours).
    const time = readTime(body ?? {});
    if (!time.ok) return null;
    return {
      courtId: courtId as number,
      date,
      when: time.when,
      reason: typeof reason === "string" && reason.trim() !== "" ? reason.trim() : undefined,
      // Absent means the whole resource; a number takes that many places out.
      places: Number.isInteger(places) ? (places as number) : undefined,
    };
  } catch {
    return null;
  }
}

/** Shared validation + venue scoping for both verbs. */
async function resolve(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return { error: admin };

  const input = await parseBody(req);
  if (!input)
    return {
      error: NextResponse.json(
        { error: "courtId, date, and start and end (minutes of the day or HH:MM) or hours[] are required." },
        { status: 400 }
      ),
    };

  const court = await getCourt(input.courtId);
  if (!court)
    return { error: NextResponse.json({ error: "Court not found." }, { status: 404 }) };
  const denied = denyVenue(admin, court.venueId);
  if (denied) return { error: denied };

  return { input };
}

export async function POST(req: NextRequest) {
  const { error, input } = await resolve(req);
  if (error) return error;
  const result = await blockSlots(input.courtId, input.date, input.when, input.reason, input.places);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  return NextResponse.json({ changed: result.changed });
}

export async function DELETE(req: NextRequest) {
  const { error, input } = await resolve(req);
  if (error) return error;
  const result = await unblockSlots(input.courtId, input.date, input.when);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  return NextResponse.json({ changed: result.changed });
}
