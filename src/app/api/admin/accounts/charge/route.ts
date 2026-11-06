import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { logFromRequest } from "@/lib/activity";
import { chargeToAccount, takeOffAccount } from "@/lib/accounts";
import { getBookingById, getCourt } from "@/lib/store";
import { money } from "@/lib/region";

export const dynamic = "force-dynamic";

/**
 * `{ bookingId, accountId }`: the desk charges a booking to a company or
 * school account; `accountId: null` takes it off again, until it is invoiced. Where the venue stops new bookings on an account
 * with an invoice too long overdue, `overrideReason` (a few words) goes past that, and is recorded in the activity log.
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
  if (body.accountId === null) {
    if (!(await takeOffAccount(court.venueId, booking.id)))
      return NextResponse.json({ error: "It is not on an account, or is invoiced already." }, { status: 409 });
    await logFromRequest(req, { venueId: court.venueId, action: "account.charged", bookingCode: booking.code, detail: `${booking.code} taken off its account` });
    return NextResponse.json({ ok: true });
  }
  if (!Number.isInteger(body.accountId)) return NextResponse.json({ error: "accountId is required." }, { status: 400 });
  const done = await chargeToAccount(court.venueId, body.accountId as number, [booking.id], {
    override: typeof body.overrideReason === "string" ? { reason: body.overrideReason } : undefined,
  });
  if (!done.ok) return NextResponse.json(done, { status: 409 });
  await logFromRequest(req, {
    venueId: court.venueId,
    action: "account.charged",
    bookingCode: booking.code,
    detail: `${booking.code} charged to account ${body.accountId}${
      done.overridden ? `, past the venue's block: ${money(done.overridden.amount)} overdue, ${done.overridden.days} days; reason: ${done.overridden.reason}` : ""
    }`,
  });
  return NextResponse.json({ ok: true });
}
