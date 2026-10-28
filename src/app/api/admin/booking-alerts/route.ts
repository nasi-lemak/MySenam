import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { bookingAlerts, setBookingAlerts } from "@/lib/notify";
import { logFromRequest } from "@/lib/activity";

export const dynamic = "force-dynamic";

async function venueOf(req: NextRequest, raw: unknown) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(raw);
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  return denyVenue(admin, venueId) ?? venueId;
}

/** `?venueId` → where the venue hears about bookings made online. */
export async function GET(req: NextRequest) {
  const venueId = await venueOf(req, req.nextUrl.searchParams.get("venueId"));
  if (venueId instanceof NextResponse) return venueId;
  return NextResponse.json({ alerts: await bookingAlerts(venueId) });
}

/** `{ venueId, email, phone, locale? }`: either blank to stop that one; `locale` the staff language they are written in (null for the install's first), left out to keep it. */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const venueId = await venueOf(req, body.venueId);
  if (venueId instanceof NextResponse) return venueId;
  const result = await setBookingAlerts(venueId, { email: body.email, phone: body.phone, locale: body.locale });
  if (!result.ok) return NextResponse.json(result, { status: 400 });
  await logFromRequest(req, {
    venueId,
    action: "settings.changed",
    detail: `New-booking alerts: ${[result.alerts.email, result.alerts.phone].filter(Boolean).join(", ") || "off"}${result.alerts.locale ? ` (${result.alerts.locale})` : ""}`,
  });
  return NextResponse.json({ alerts: result.alerts });
}
