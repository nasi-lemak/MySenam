import { NextRequest, NextResponse } from "next/server";
import { asStaff } from "@/lib/acting-staff";
import { logAction } from "@/lib/activity";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { refusal } from "@/lib/api";
import { tickOutbox } from "@/lib/notify";
import { refundCancelled } from "@/lib/payments";
import { bookingLocale, notifyWithdrawn, readWithdrawWhat, withdrawalLogDetail, withdrawOptions, withdrawPlace } from "@/lib/place-withdrawals";
import { findBookingByCode, getVenueIdForBookingCode } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * Staff taking one person off a booking at the counter (lib/place-withdrawals.ts):
 * up to the end of the booking, in full, on the record (the activity log, and
 * the participant's history).
 *
 * GET `?code` → `{ options }`: who is on it, and whether each can be taken off.
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const code = req.nextUrl.searchParams.get("code") ?? "";
  const venueId = code ? await getVenueIdForBookingCode(code) : null;
  if (venueId === null) return NextResponse.json({ error: "Booking not found." }, { status: 404 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const booking = (await findBookingByCode(code))!;
  return NextResponse.json({ options: await withdrawOptions(booking, { kind: "staff", adminId: admin.id, name: admin.name }) }, { headers: { "Cache-Control": "no-store" } });
}

/** `{ code, participantId | customer: true | unnamed: n, reason? }`: take them off; the others stay booked. */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.code !== "string" || body.code.trim() === "") return NextResponse.json({ error: "code is required." }, { status: 400 });
  const what = readWithdrawWhat(body);
  if (!what) return NextResponse.json({ error: "Say who comes off: participantId, customer, or unnamed places." }, { status: 400 });
  const venueId = await getVenueIdForBookingCode(body.code);
  if (venueId === null) return NextResponse.json({ error: "Booking not found." }, { status: 404 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const booking = (await findBookingByCode(body.code))!;
  const reason = typeof body.reason === "string" ? body.reason : null;
  // As the member of staff, so the credit note it writes says who gave the money back (lib/acting-staff.ts): their own cash-up counts it.
  const done = await asStaff(admin, () => withdrawPlace(booking.id, what, { kind: "staff", adminId: admin.id, name: admin.name }, reason));
  if (!done.ok) return refusal(done);
  // Paid online: it goes back now, as when staff cancel a booking.
  const refunds = await refundCancelled([booking.id], { byVenue: true });
  const w = done.withdrawal;
  await logAction(admin, { venueId, action: "booking.place_withdrawn", bookingCode: booking.code, detail: withdrawalLogDetail(booking.code, w, reason) });
  // The customer (the guardian) is told who is off, in the language they booked in.
  await notifyWithdrawn(done.booking, w, await bookingLocale(booking.id));
  await tickOutbox();
  return NextResponse.json({ booking: done.booking, withdrawal: w, refunds });
}
