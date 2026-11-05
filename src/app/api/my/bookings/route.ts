import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { listUserBookings } from "@/lib/store";
import { refundStatusFor, takesPaymentOnline } from "@/lib/payments";
import { holdPolicy } from "@/lib/holds";
import { struckOut } from "@/lib/cancel-policy";
import { windowFor } from "@/lib/house-rules";
import { addDays, todayISO } from "@/lib/time";
import { customerCourtName, laneHidden } from "@/lib/lanes";
import { currentLocale } from "@/lib/locale";
import { openLessonMove } from "@/lib/lesson-venue-moves";

export const dynamic = "force-dynamic";

/**
 * The account's bookings (lib/store.ts `ACCOUNT_BOOKING`: its own, and those
 * made without an account under its proved address), with what My Booking
 * says of each one still to come, so the account page offers the same
 * (components/BookingPayment.tsx): whether the venue takes payment online,
 * the deposit that holds one held unpaid, and the last day it may move to.
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const listed = await listUserBookings(user.id);
  // A lane given on arrival is not named before check-in (lib/lanes.ts).
  const locale = listed.some(laneHidden) ? await currentLocale() : "en";
  const rows = listed.map((b) => ({ ...b, courtName: customerCourtName(b.courtName, b, locale) }));
  const online = new Map<number, boolean>();
  const bookings = [];
  for (const b of rows) {
    if (b.status !== "confirmed" || b.date < todayISO(b.venueTimeZone)) {
      bookings.push(b);
      continue;
    }
    if (!online.has(b.venueId)) online.set(b.venueId, await takesPaymentOnline(b.venueId));
    bookings.push({
      ...b,
      payOnline: online.get(b.venueId)!,
      // As My Booking works it out (app/api/bookings): the venue's deposit holds it, unless the number is past its strikes.
      depositPercent:
        b.holdUntil && b.paymentStatus === "unpaid" && (b.depositPaid ?? 0) === 0 && !(await struckOut(b.venueId, b.phone)).out
          ? (await holdPolicy(b.venueId)).depositPercent
          : null,
      lastDate: addDays(todayISO(b.venueTimeZone), await windowFor(b.venueId, [b.phone])),
      // A lesson the venue moved, while its customer may still cancel it with everything back (lib/lesson-venue-moves.ts).
      movedLesson: b.coachId ? await openLessonMove(b.id) : null,
    });
  }
  // Money paid online and owed back, or refunded, on any of them: for the customer to follow.
  return NextResponse.json({ bookings, refunds: await refundStatusFor(rows.map((b) => b.id)) });
}
