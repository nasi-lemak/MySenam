import { NextRequest, NextResponse } from "next/server";
import { logAction } from "@/lib/activity";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { refusal } from "@/lib/api";
import { placesOf, soldByPlace } from "@/lib/entitlements";
import { notifyPaid } from "@/lib/notify";
import { bookedCourt, findBookingByCode, getVenueIdForBookingCode, payBookingWithPasses, usablePassesForHolder } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * Paying a booking at the counter with passes, one for the booking as a whole
 * or one person's own pass for each place (ADR 0025; lib/pass-rules.ts
 * `planPassSpends`, the plan the booking engine pays by).
 *
 * GET `?code` → `{ booking, places, passes, soldByPlace, minutes }`: who is on
 * the booking, and the passes its number holds here that can be spent now
 * (its own and those held for the people it acts for), for the counter to say
 * which pays for whom before anything is spent.
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
  const court = await bookedCourt(booking);
  const places = (await placesOf(booking.id)).map((p) => ({ ...p, name: p.customer ? (p.name ?? booking.name) : p.name }));
  return NextResponse.json(
    {
      booking: { code: booking.code, name: booking.name, players: booking.players ?? 1, paymentStatus: booking.paymentStatus, totalPrice: booking.totalPrice },
      places,
      passes: (await usablePassesForHolder(venueId, booking.phone)).filter((p) => p.sport === null || p.sport === booking.sport),
      soldByPlace: court ? soldByPlace(court) : false,
      minutes: booking.endMin - booking.startMin,
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

/**
 * `{ code, passCodes }`: pay it with these passes, all or nothing. Refused
 * with the reason (`ENT_PASS_*`, a balance too low, already paid) and nothing
 * spent; each spend names the place it paid for, so a cancellation, or one
 * person taken off, gives back exactly that.
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.code !== "string" || body.code.trim() === "") return NextResponse.json({ error: "code is required." }, { status: 400 });
  const codes = body.passCodes;
  if (!Array.isArray(codes) || codes.length === 0 || codes.length > 13 || !codes.every((c) => typeof c === "string" && c.trim() !== ""))
    return NextResponse.json({ error: "passCodes must be a list of pass codes." }, { status: 400 });
  const venueId = await getVenueIdForBookingCode(body.code);
  if (venueId === null) return NextResponse.json({ error: "Booking not found." }, { status: 404 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const booking = (await findBookingByCode(body.code))!;
  const paid = await payBookingWithPasses(booking.id, codes as string[]);
  if (!paid.ok) return refusal(paid);
  await logAction(admin, {
    venueId,
    action: "payment.paid",
    bookingCode: booking.code,
    detail: `With ${codes.length === 1 ? "a pass" : `${codes.length} passes`} (${(codes as string[]).map((c) => c.trim().toUpperCase()).join(", ")})`,
  });
  const after = (await findBookingByCode(booking.code))!;
  await notifyPaid([after], "counter");
  return NextResponse.json({ booking: after });
}
