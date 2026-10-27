import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { logFromRequest } from "@/lib/activity";
import { checkConcession } from "@/lib/concessions";
import { getBookingById, getCourt } from "@/lib/store";
import { money } from "@/lib/region";
import { placeBenefitsFor } from "@/lib/entitlements";

export const dynamic = "force-dynamic";

/**
 * `{ bookingId, outcome: "seen" | "refused", remember?, via?, placeBenefitId? }`: the desk has
 * looked at the proof for a concession price. Seen, it is remembered for the
 * time chosen (the fact only); not shown, the full price is charged.
 * `placeBenefitId` checks one person's concession on their own place: their
 * proof, remembered for them, and only their place charged in full.
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
    // One person's concession on their own place (`placeBenefitId`, from the booking's `placeBenefits`).
    placeBenefitId: body.placeBenefitId,
  });
  if (!done.ok) return NextResponse.json(done, { status: 409 });
  const which = Number.isInteger(body.placeBenefitId)
    ? (await placeBenefitsFor(booking.id, { all: true })).find((p) => p.id === body.placeBenefitId)
    : undefined;
  const what = which ? `${which.concessionName ?? "concession"} for ${which.name ?? "one place"}` : booking.concessionName;
  await logFromRequest(req, {
    venueId: court.venueId,
    action: "booking.concession",
    bookingCode: booking.code,
    detail:
      body.outcome === "seen"
        ? `${booking.code}: ${what} proof seen`
        : `${booking.code}: no ${what} proof, full price (${money(done.charged)} more)`,
  });
  return NextResponse.json({ booking: done.booking, charged: done.charged });
}
