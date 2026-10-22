import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { logFromRequest } from "@/lib/activity";
import { checkConcession } from "@/lib/concessions";
import { getBookingById, getCourt } from "@/lib/store";
import { money } from "@/lib/region";

export const dynamic = "force-dynamic";

/**
 * `{ bookingId, outcome: "seen" | "refused", remember?, via? }`: the desk has
 * looked at the proof for a concession price. Seen, it is remembered for the
 * time chosen (the fact only); not shown, the full price is charged.
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || !Number.isInteger(body.bookingId)) return NextResponse.json({ error: "bookingId is required." }, { status: 400 });
  const booking = await getBookingById(body.bookingId as number);
  const court = booking ? await getCourt(booking.courtId) : null;
  if (!booking || !court) return NextResponse.json({ error: "Booking not found." }, { status: 404 });
  const denied = denyVenue(admin, court.venueId);
  if (denied) return denied;
  const done = await checkConcession({
    bookingId: booking.id,
    venueIds: null,
    adminId: admin.id,
    outcome: body.outcome,
    remember: body.remember,
    via: body.via,
  });
  if (!done.ok) return NextResponse.json(done, { status: 409 });
  await logFromRequest(req, {
    venueId: court.venueId,
    action: "booking.concession",
    bookingCode: booking.code,
    detail:
      body.outcome === "seen"
        ? `${booking.code}: ${booking.concessionName} proof seen`
        : `${booking.code}: no ${booking.concessionName} proof, full price (${money(done.charged)} more)`,
  });
  return NextResponse.json({ booking: done.booking, charged: done.charged });
}
