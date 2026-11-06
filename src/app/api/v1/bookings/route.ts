import { NextRequest, NextResponse } from "next/server";
import { apiCaller } from "@/lib/api-keys";
import { bookThroughKey } from "@/lib/key-bookings";
import { bookingsBetween, MAX_RANGE_DAYS, spanDays } from "@/lib/public-api";
import { isValidDateString } from "@/lib/time";

export const dynamic = "force-dynamic";

/** `?from=&to=` (at most 31 days) → the venue's bookings, cancelled ones included. */
export async function GET(req: NextRequest) {
  const caller = await apiCaller(req);
  if (caller instanceof NextResponse) return caller;
  const from = req.nextUrl.searchParams.get("from") ?? "";
  const to = req.nextUrl.searchParams.get("to") ?? from;
  if (!isValidDateString(from) || !isValidDateString(to) || to < from)
    return NextResponse.json({ error: "from and to (YYYY-MM-DD) are required, to not before from." }, { status: 400 });
  if (spanDays(from, to) > MAX_RANGE_DAYS) return NextResponse.json({ error: `At most ${MAX_RANGE_DAYS} days at a time.` }, { status: 400 });
  return NextResponse.json({ bookings: await bookingsBetween(caller.venueId, from, to) });
}

/**
 * `{ courtId, date, start, end, name, phone, email?, players?, participantIds?,
 * customerTakesPart?, concessionId?, placeConcessions?, promoCode?, guestOf? }` → a
 * booking, as the venue's own system makes it (write keys). `start` and `end` are minutes of
 * the business day or HH:MM (`minutes` may stand for `end`; `hours`, a list
 * of grid times, is the older form). `players` is how many places it takes
 * on a resource with places, or how many play on a court priced per player,
 * up to the most the venue lets one booking take. The court's booking policy applies as
 * to any customer. The customer is sent the usual confirmation. Unpaid; the
 * venue settles it as any other.
 *
 * `participantIds` books for people other than (or, with `customerTakesPart`,
 * as well as) the customer, each taking a place and checked on their own
 * sign-offs (lib/participant-bookings.ts; docs/integrations/external-api.md).
 * Only participants this venue already knows, whose guardian is on `phone`
 * (the booking is made with, and told to, that guardian), and whose
 * guardian's agreement to the venue's waiver is on record: a key creates no
 * participant, reaches no other venue's, and attaches nobody else's
 * eligibility.
 *
 * Asked of the number as the counter asks it (lib/limits.ts `mayBookOn`): a
 * refused number, the venue open, the house rules, the unpaid-bookings limit
 * and no-show strikes. Discounts as the booking form and the counter put them
 * on (lib/booking-discounts.ts): a concession on the venue's word, each
 * person's own, and a promo code, by the one rule and order
 * (lib/discounts.ts), best-effort with the reason (`concessionError`,
 * `promoError`, `promoErrorCode`) and what the code took off (`discount`).
 *
 * `guestOf` (the host's number) books the person as a member's or resident's
 * guest rather than an ordinary customer, as the counter does
 * (lib/guest-invites.ts): the host on the venue's list for the date, the
 * guest put on it as theirs against the host's guest allowance, which a key
 * never goes past.
 */
export async function POST(req: NextRequest) {
  const caller = await apiCaller(req, "write");
  if (caller instanceof NextResponse) return caller;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  // The same code the MCP server's create_booking runs (lib/key-bookings.ts).
  return bookThroughKey(caller, body, { log: true });
}
