import { NextRequest, NextResponse } from "next/server";
import { refusal } from "@/lib/api";
import { getSessionUser } from "@/lib/auth";
import { currentLocale } from "@/lib/locale";
import { tickOutbox } from "@/lib/notify";
import { refundCancelled } from "@/lib/payments";
import { notifyWithdrawn, readWithdrawWhat, withdrawOptions, withdrawPlace } from "@/lib/place-withdrawals";
import { accountHasBooking, getBookingById } from "@/lib/store";

export const dynamic = "force-dynamic";

/** The account's own booking, or null. */
async function ownBooking(userId: number, bookingId: unknown) {
  if (!Number.isInteger(bookingId)) return null;
  // Made by it, or as a guest under the address it has proved (lib/store.ts `ACCOUNT_BOOKING`).
  return (await accountHasBooking(userId, bookingId as number)) ? getBookingById(bookingId as number) : null;
}

/**
 * Taking one person off one of the account's bookings
 * (lib/place-withdrawals.ts). GET `?bookingId` → `{ options }`: who is on it,
 * whether each can be taken off now and what it would do, or why not.
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const booking = await ownBooking(user.id, Number(req.nextUrl.searchParams.get("bookingId")));
  if (!booking) return NextResponse.json({ error: "Booking not found." }, { status: 404 });
  return NextResponse.json({ options: await withdrawOptions(booking, { kind: "customer", userId: user.id, name: user.name }) }, { headers: { "Cache-Control": "no-store" } });
}

/** `{ bookingId, participantId | customer: true | unnamed: n }`: take them off, on the venue's cancellation terms. */
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const what = readWithdrawWhat(body);
  if (!what) return NextResponse.json({ error: "Say who comes off: participantId, customer, or unnamed places." }, { status: 400 });
  const booking = await ownBooking(user.id, body.bookingId);
  if (!booking) return NextResponse.json({ error: "Booking not found." }, { status: 404 });
  const done = await withdrawPlace(booking.id, what, { kind: "customer", userId: user.id, name: user.name });
  if (!done.ok) return refusal(done);
  // Money paid online goes back as the venue chose, before the customer is told.
  const refunds = await refundCancelled([booking.id]);
  await notifyWithdrawn(done.booking, done.withdrawal, await currentLocale());
  await tickOutbox();
  return NextResponse.json({ booking: done.booking, withdrawal: done.withdrawal, refunds });
}
