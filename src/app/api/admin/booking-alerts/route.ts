import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { bookingAlerts, changeAlerts, setBookingAlerts, setChangeAlerts } from "@/lib/notify";
import { logFromRequest } from "@/lib/activity";
import { jsonObject } from "@/lib/api";

export const dynamic = "force-dynamic";

async function venueOf(req: NextRequest, raw: unknown) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(raw);
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  return denyVenue(admin, venueId) ?? venueId;
}

/**
 * `?venueId` → where the venue hears about bookings made online (`alerts`),
 * and whether it also hears about customers' online cancellations and
 * changes, and how far ahead (`changes`).
 */
export async function GET(req: NextRequest) {
  const venueId = await venueOf(req, req.nextUrl.searchParams.get("venueId"));
  if (venueId instanceof NextResponse) return venueId;
  return NextResponse.json({ alerts: await bookingAlerts(venueId), changes: await changeAlerts(venueId) });
}

/**
 * `{ venueId, email, phone, locale?, cancellations?, changes?, withinHours? }`:
 * email or phone blank to stop that one; `locale` the staff language they are
 * written in (null for the install's first); `cancellations` and `changes`
 * (true or false) for customers' online cancellations and changes,
 * `withinHours` 24, 48 or 168, or null for any booking however far ahead.
 * Left out, each of the last four stays as it is.
 */
export async function POST(req: NextRequest) {
  const body = await jsonObject(req).catch(() => null);
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const venueId = await venueOf(req, body.venueId);
  if (venueId instanceof NextResponse) return venueId;
  const changing = body.cancellations !== undefined || body.changes !== undefined || body.withinHours !== undefined;
  // Checked before anything is saved, so a refusal leaves both as they were.
  if (body.withinHours !== undefined && body.withinHours !== null && ![24, 48, 168].includes(Number(body.withinHours)))
    return NextResponse.json({ error: "Hear about changes to bookings within a day, two days, a week, or any time ahead." }, { status: 400 });
  const result = await setBookingAlerts(venueId, { email: body.email, phone: body.phone, locale: body.locale });
  if (!result.ok) return NextResponse.json(result, { status: 400 });
  const changes = changing
    ? await setChangeAlerts(venueId, { cancellations: body.cancellations, changes: body.changes, withinHours: body.withinHours })
    : { ok: true as const, changes: await changeAlerts(venueId) };
  if (!changes.ok) return NextResponse.json(changes, { status: 400 });
  const c = changes.changes;
  await logFromRequest(req, {
    venueId,
    action: "settings.changed",
    detail: `New-booking alerts: ${[result.alerts.email, result.alerts.phone].filter(Boolean).join(", ") || "off"}${result.alerts.locale ? ` (${result.alerts.locale})` : ""}${
      changing
        ? `; online cancellations ${c.cancellations ? "on" : "off"}, changes ${c.changes ? "on" : "off"}, ${c.withinHours === null ? "any time ahead" : `within ${c.withinHours} hours`}`
        : ""
    }`,
  });
  return NextResponse.json({ alerts: result.alerts, changes: c });
}
