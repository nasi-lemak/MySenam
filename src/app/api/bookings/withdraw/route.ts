import { NextRequest, NextResponse } from "next/server";
import { refusal } from "@/lib/api";
import { getSessionUser } from "@/lib/auth";
import { currentLocale } from "@/lib/locale";
import { alertVenueWithdrawn, tickOutbox } from "@/lib/notify";
import { refundCancelled } from "@/lib/payments";
import { notifyWithdrawn, readWithdrawWhat, withdrawOptions, withdrawPlace, type WithdrawBy } from "@/lib/place-withdrawals";
import { rateLimit } from "@/lib/rate-limit";
import { findBooking } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * Taking one person off a booking, the others staying booked
 * (lib/place-withdrawals.ts; docs/features/booking.md#taking-one-person-off-a-booking),
 * by the booking's code and phone number, as cancelling is.
 *
 * GET `?code&phone` → `{ options }`: each person on it (and the places nobody
 * is named on), whether they can be taken off now, and what it would do to
 * the money; or why not.
 */
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const phone = req.nextUrl.searchParams.get("phone");
  if (!code || !phone) return NextResponse.json({ error: "code and phone are required." }, { status: 400 });
  const limited = await rateLimit(req, "bookingLookup");
  if (limited) return limited;
  const booking = await findBooking(code, phone);
  if (!booking) return NextResponse.json({ error: "Booking not found. Check the code and phone number." }, { status: 404 });
  const user = await getSessionUser(req);
  const by: WithdrawBy = { kind: "customer", userId: user?.id ?? null, name: user?.name ?? booking.name };
  return NextResponse.json({ options: await withdrawOptions(booking, by) }, { headers: { "Cache-Control": "no-store" } });
}

/**
 * `{ code, phone, participantId | customer: true | unnamed: n }`: take that
 * person (or so many unnamed places) off, on the venue's cancellation terms.
 * The answer says what it did: `{ booking, withdrawal, refunds }`.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const { code, phone } = body;
  if (typeof code !== "string" || typeof phone !== "string") return NextResponse.json({ error: "code and phone are required." }, { status: 400 });
  const what = readWithdrawWhat(body);
  if (!what) return NextResponse.json({ error: "Say who comes off: participantId, customer, or unnamed places." }, { status: 400 });
  const limited = await rateLimit(req, "bookingLookup");
  if (limited) return limited;
  const booking = await findBooking(code, phone);
  if (!booking) return NextResponse.json({ error: "Booking not found. Check the code and phone number." }, { status: 404 });
  const user = await getSessionUser(req);
  const done = await withdrawPlace(booking.id, what, { kind: "customer", userId: user?.id ?? null, name: user?.name ?? booking.name });
  if (!done.ok) return refusal(done);
  // Money paid online goes back as the venue chose, before the customer is told.
  const refunds = await refundCancelled([booking.id]);
  await notifyWithdrawn(done.booking, done.withdrawal, await currentLocale());
  await alertVenueWithdrawn(done.booking, done.withdrawal.id);
  await tickOutbox();
  return NextResponse.json({ booking: done.booking, withdrawal: done.withdrawal, refunds });
}
