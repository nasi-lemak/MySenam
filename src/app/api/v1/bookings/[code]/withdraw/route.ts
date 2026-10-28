import { NextRequest, NextResponse } from "next/server";
import { logAction } from "@/lib/activity";
import { refusal } from "@/lib/api";
import { apiCaller } from "@/lib/api-keys";
import { tickOutbox } from "@/lib/notify";
import { refundCancelled } from "@/lib/payments";
import { bookingLocale, notifyWithdrawn, readWithdrawWhat, withdrawalLogDetail, withdrawOptions, withdrawPlace, type WithdrawBy } from "@/lib/place-withdrawals";
import { bookingForVenue } from "@/lib/public-api";
import { findBookingByCode } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * Taking one person off one of the venue's bookings through its API key, as
 * its counter does (lib/place-withdrawals.ts;
 * docs/features/booking.md#taking-one-person-off-a-booking): the same
 * refusals, the counter's terms (up to the end of the booking, in full), the
 * same money (off what is owed, or back the way it was paid, online money
 * sent back now), the customer told, and the activity log naming the key.
 * Only bookings at the key's venue; another venue's answer 404 as unknown.
 *
 * GET → `{ options }`: who is on it, whether each can be taken off now, and what it would do.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const caller = await apiCaller(req);
  if (caller instanceof NextResponse) return caller;
  const code = (await params).code;
  if (!(await bookingForVenue(caller.venueId, code))) return NextResponse.json({ error: "Booking not found." }, { status: 404 });
  const booking = (await findBookingByCode(code))!;
  const by: WithdrawBy = { kind: "api", keyId: caller.keyId, name: `API key ${caller.keyId}` };
  return NextResponse.json({ options: await withdrawOptions(booking, by) }, { headers: { "Cache-Control": "no-store" } });
}

/** Printable ASCII, as clients make them (a UUID, usually). */
const REQUEST_KEY = /^[\x21-\x7e]{1,255}$/;

/**
 * `{ placeId | participantId | customer: true | unnamed: n, reason? }` (write
 * keys), with an optional `Idempotency-Key` header: the same key sent again
 * answers with the withdrawal it made (`replayed: true`) and takes nobody else
 * off; used for a different request, 422.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const caller = await apiCaller(req, "write");
  if (caller instanceof NextResponse) return caller;
  const code = (await params).code;
  const requestKey = req.headers.get("idempotency-key");
  if (requestKey !== null && !REQUEST_KEY.test(requestKey))
    return NextResponse.json({ error: "Idempotency-Key must be 1 to 255 printable characters." }, { status: 400 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const what = body ? readWithdrawWhat(body) : null;
  if (!body || !what) return NextResponse.json({ error: "Say who comes off: placeId, participantId, customer, or unnamed places." }, { status: 400 });
  if (!(await bookingForVenue(caller.venueId, code))) return NextResponse.json({ error: "Booking not found." }, { status: 404 });
  const booking = (await findBookingByCode(code))!;
  const reason = typeof body.reason === "string" ? body.reason : null;
  const by: WithdrawBy = { kind: "api", keyId: caller.keyId, name: `API key ${caller.keyId}` };
  const done = await withdrawPlace(booking.id, what, by, reason, requestKey);
  if (!done.ok) return done.code ? refusal(done) : NextResponse.json({ error: done.error }, { status: 422 });
  const venueBooking = await bookingForVenue(caller.venueId, code);
  // Done before under this key: what it answered then, nothing sent or told again.
  if (done.replayed) return NextResponse.json({ booking: venueBooking, withdrawal: done.withdrawal, replayed: true });
  // Paid online: it goes back now, as when the venue cancels a booking.
  const refunds = await refundCancelled([booking.id], { byVenue: true });
  const w = done.withdrawal;
  await logAction(
    { id: null, name: by.name },
    { venueId: caller.venueId, action: "booking.place_withdrawn", bookingCode: booking.code, detail: withdrawalLogDetail(booking.code, w, reason) }
  );
  // The customer (the guardian) is told who is off, in the language they booked in.
  await notifyWithdrawn(done.booking, w, await bookingLocale(booking.id));
  await tickOutbox();
  return NextResponse.json({ booking: venueBooking, withdrawal: w, refunds });
}
