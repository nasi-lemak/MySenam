import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { addHoliday, fillHolidays, removeHoliday, upcomingHolidays } from "@/lib/peak";
import { logFromRequest } from "@/lib/activity";

export const dynamic = "force-dynamic";

async function venueOf(req: NextRequest, raw: unknown) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(raw);
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  return denyVenue(admin, venueId) ?? venueId;
}

/**
 * `{ venueId, date, name }`: price that date like the weekend. Or
 * `{ venueId, fill: true, state }`: every public holiday to come, in Malaysia
 * the state's own too (lib/holiday-calendar.ts).
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const venueId = await venueOf(req, body.venueId);
  if (venueId instanceof NextResponse) return venueId;
  if (body.fill === true) {
    const filled = await fillHolidays(venueId, body.state ?? "");
    if (!filled.ok) return NextResponse.json(filled, { status: 400 });
    await logFromRequest(req, {
      venueId,
      action: "settings.changed",
      detail: `Public holidays filled in${typeof body.state === "string" && body.state ? ` for ${body.state}` : ""}: ${filled.added} added`,
    });
    return NextResponse.json({ added: filled.added, holidays: await upcomingHolidays(venueId) });
  }
  const result = await addHoliday(venueId, { date: body.date, name: body.name });
  if (!result.ok) return NextResponse.json(result, { status: 400 });
  await logFromRequest(req, { venueId, action: "settings.changed", detail: `Holiday priced as peak: ${result.holiday.name}, ${result.holiday.date}` });
  return NextResponse.json({ holidays: await upcomingHolidays(venueId) });
}

/** `?venueId&date`: back to an ordinary day. */
export async function DELETE(req: NextRequest) {
  const venueId = await venueOf(req, req.nextUrl.searchParams.get("venueId"));
  if (venueId instanceof NextResponse) return venueId;
  const date = req.nextUrl.searchParams.get("date") ?? "";
  if (!(await removeHoliday(venueId, date))) return NextResponse.json({ error: "No such holiday." }, { status: 404 });
  await logFromRequest(req, { venueId, action: "settings.changed", detail: `Holiday removed: ${date}` });
  return NextResponse.json({ holidays: await upcomingHolidays(venueId) });
}
