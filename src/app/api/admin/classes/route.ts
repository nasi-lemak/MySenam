import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { createClassSessions, getCourt, listClasses } from "@/lib/store";
import { isValidDateString } from "@/lib/time";
import { MAX_CLASS_WEEKS } from "@/lib/types";

export const dynamic = "force-dynamic";

export function GET(req: NextRequest) {
  const admin = requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  const venueParam = req.nextUrl.searchParams.get("venueId");
  const venueId = venueParam ? Number(venueParam) : admin.venueId ?? undefined;
  if (venueId !== undefined) {
    const denied = denyVenue(admin, venueId);
    if (denied) return denied;
  }
  return NextResponse.json({
    classes: listClasses({ venueId, includeCancelled: true }),
  });
}

export async function POST(req: NextRequest) {
  const admin = requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { courtId, name, instructor, date, startHour, endHour, capacity, price, weeks } =
    (body ?? {}) as Record<string, unknown>;

  if (!Number.isInteger(courtId) || (courtId as number) <= 0)
    return NextResponse.json({ error: "courtId is required." }, { status: 400 });
  const court = getCourt(courtId as number);
  if (!court) return NextResponse.json({ error: "Court not found." }, { status: 404 });
  const denied = denyVenue(admin, court.venueId);
  if (denied) return denied;

  if (typeof name !== "string" || name.trim().length < 2)
    return NextResponse.json({ error: "Class name is required." }, { status: 400 });
  if (typeof instructor !== "string" || instructor.trim().length < 2)
    return NextResponse.json({ error: "Instructor name is required." }, { status: 400 });
  if (typeof date !== "string" || !isValidDateString(date))
    return NextResponse.json({ error: "Invalid date. Use YYYY-MM-DD." }, { status: 400 });
  for (const [label, value] of [["startHour", startHour], ["endHour", endHour]] as const) {
    if (!Number.isInteger(value))
      return NextResponse.json({ error: `${label} must be a whole hour.` }, { status: 400 });
  }
  if (!Number.isInteger(capacity) || (capacity as number) < 1)
    return NextResponse.json({ error: "Capacity must be at least 1." }, { status: 400 });
  if (!Number.isInteger(price) || (price as number) < 0)
    return NextResponse.json({ error: "Price must be RM0 or more." }, { status: 400 });
  if (weeks !== undefined &&
      (!Number.isInteger(weeks) || (weeks as number) < 1 || (weeks as number) > MAX_CLASS_WEEKS))
    return NextResponse.json(
      { error: `weeks must be between 1 and ${MAX_CLASS_WEEKS}.` },
      { status: 400 }
    );

  const result = createClassSessions({
    courtId: courtId as number,
    name: name as string,
    instructor: instructor as string,
    date,
    startHour: startHour as number,
    endHour: endHour as number,
    capacity: capacity as number,
    price: price as number,
    weeks: (weeks as number) ?? 1,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  return NextResponse.json(
    { classes: result.classes, seriesCode: result.seriesCode },
    { status: 201 }
  );
}
