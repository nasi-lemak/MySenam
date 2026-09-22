import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { blockSlots, getCourt, unblockSlots } from "@/lib/store";
import { isValidDateString } from "@/lib/time";

export const dynamic = "force-dynamic";

async function parseBody(req: NextRequest) {
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const { courtId, date, hours, reason } = body ?? {};
    if (!Number.isInteger(courtId) || (courtId as number) <= 0) return null;
    if (typeof date !== "string" || !isValidDateString(date)) return null;
    if (!Array.isArray(hours) || hours.length === 0 || hours.some((h) => !Number.isInteger(h)))
      return null;
    return {
      courtId: courtId as number,
      date,
      hours: hours as number[],
      reason: typeof reason === "string" && reason.trim() !== "" ? reason.trim() : undefined,
    };
  } catch {
    return null;
  }
}

/** Shared validation + venue scoping for both verbs. */
async function resolve(req: NextRequest) {
  const admin = requireAdmin(req);
  if (admin instanceof NextResponse) return { error: admin };

  const input = await parseBody(req);
  if (!input)
    return {
      error: NextResponse.json(
        { error: "courtId, date and hours[] are required." },
        { status: 400 }
      ),
    };

  const court = getCourt(input.courtId);
  if (!court)
    return { error: NextResponse.json({ error: "Court not found." }, { status: 404 }) };
  const denied = denyVenue(admin, court.venueId);
  if (denied) return { error: denied };

  return { input };
}

export async function POST(req: NextRequest) {
  const { error, input } = await resolve(req);
  if (error) return error;
  const result = blockSlots(input.courtId, input.date, input.hours, input.reason);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  return NextResponse.json({ changed: result.changed });
}

export async function DELETE(req: NextRequest) {
  const { error, input } = await resolve(req);
  if (error) return error;
  const result = unblockSlots(input.courtId, input.date, input.hours);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  return NextResponse.json({ changed: result.changed });
}
