import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { refundCancelled } from "@/lib/payments";
import { refusal } from "@/lib/api";
import { adminCancelBooking, closeVenueDay, listVenueClosures, reopenVenueDay } from "@/lib/store";
import { getDb } from "@/lib/db";
import { cancelClassAndTell, notifyVenueCancelled, tickOutbox } from "@/lib/notify";
import { isValidDateString, todayISO } from "@/lib/time";

export const dynamic = "force-dynamic";

/** Resolve the venue in the path, checking this admin may touch it. */
async function scope(
  req: NextRequest,
  params: Promise<{ id: string }>
): Promise<number | NextResponse> {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const { id } = await params;
  const venueId = Number(id);
  if (!Number.isInteger(venueId) || venueId <= 0)
    return NextResponse.json({ error: "Invalid venue id." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  return venueId;
}

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const venueId = await scope(req, params);
  if (venueId instanceof NextResponse) return venueId;
  return NextResponse.json({ closures: await listVenueClosures(venueId, todayISO()) });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const venueId = await scope(req, params);
  if (venueId instanceof NextResponse) return venueId;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const input = (body ?? {}) as Record<string, unknown>;
  const date = input.date;
  if (typeof date !== "string" || !isValidDateString(date))
    return NextResponse.json({ error: "A valid date is required." }, { status: 400 });
  const reason = typeof input.reason === "string" ? input.reason : undefined;

  // Closing over bookings: not without saying so, and then the customers are
  // told — an unexpected closure is exactly what must not go unheard.
  const db = getDb();
  const bookings = (await db
    .prepare(
      `SELECT b.code FROM bookings b JOIN courts c ON c.id = b.court_id
        WHERE c.venue_id = ? AND b.date = ? AND b.status = 'confirmed' AND b.class_id IS NULL ORDER BY b.start_min`
    )
    .all(venueId, date)) as { code: string }[];
  const classes = (await db
    .prepare(
      `SELECT cl.id FROM classes cl JOIN courts c ON c.id = cl.court_id
        WHERE c.venue_id = ? AND cl.date = ? AND cl.status = 'scheduled'`
    )
    .all(venueId, date)) as { id: number }[];
  if ((bookings.length > 0 || classes.length > 0) && input.cancelAffected !== true)
    return NextResponse.json(
      {
        error: `${date} has ${bookings.length} booking${bookings.length === 1 ? "" : "s"} and ${classes.length} class${classes.length === 1 ? "" : "es"}. Cancel them and tell the customers, or move them first.`,
        bookings: bookings.length,
        classes: classes.length,
      },
      { status: 409 }
    );
  let cancelled = 0;
  for (const cl of classes) if ((await cancelClassAndTell(cl.id)).ok) cancelled++;
  for (const b of bookings) {
    const done = await adminCancelBooking(b.code);
    if (!done.ok) continue;
    cancelled++;
    await refundCancelled([done.booking.id], { byVenue: true });
    await notifyVenueCancelled(done.booking);
  }
  if (cancelled > 0) await tickOutbox();

  const result = await closeVenueDay(venueId, date, reason);
  if (!result.ok) return refusal(result, 400);
  return NextResponse.json({ closure: result.closure, cancelled }, { status: 201 });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const venueId = await scope(req, params);
  if (venueId instanceof NextResponse) return venueId;

  const date = req.nextUrl.searchParams.get("date") ?? "";
  if (!isValidDateString(date))
    return NextResponse.json({ error: "A valid date is required." }, { status: 400 });
  if (!(await reopenVenueDay(venueId, date)).ok)
    return NextResponse.json({ error: "That day is not closed." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
