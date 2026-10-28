import { NextRequest, NextResponse } from "next/server";
import { apiBooking, apiCaller, apiParticipants } from "@/lib/api-keys";
import { isRefusal } from "@/lib/participants";
import { readSelection, recordBookedFor, selectionAtVenue } from "@/lib/participant-bookings";
import { waiverSigned, waiverSignedFor } from "@/lib/waivers";
import { notifyBookingConfirmed } from "@/lib/notify";
import { bookingsBetween, MAX_RANGE_DAYS, spanDays } from "@/lib/public-api";
import { createBooking, getCourt } from "@/lib/store";
import { applyAskedDiscounts } from "@/lib/booking-discounts";
import { readPlaceConcessions } from "@/lib/entitlements";
import { mayBookOn, saidOn } from "@/lib/limits";
import { asksStaffPowers } from "@/lib/policy-overrides";
import { guestHostAt, registerGuest, undoGuestRegistration, type GuestHost, type GuestRegistration } from "@/lib/guest-invites";
import type { Refusal } from "@/lib/types";
import { errorText, translator } from "@/lib/i18n";
import { isValidDateString } from "@/lib/time";
import { readTime, refusal } from "@/lib/api";
import { contactRefusal } from "@/lib/contact-fields";

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
  // A key never overrides the venue's policies, nor takes payment: refused, never ignored (lib/policy-overrides.ts).
  if (body && (asksStaffPowers(body) || body.override !== undefined))
    return NextResponse.json({ error: errorText(translator("en"), "R9_API_NO_OVERRIDE"), code: "R9_API_NO_OVERRIDE" }, { status: 400 });
  if (!body || !Number.isInteger(body.courtId)) return NextResponse.json({ error: "courtId is required." }, { status: 400 });
  const court = await getCourt(body.courtId as number);
  if (!court || court.venueId !== caller.venueId) return NextResponse.json({ error: "That court is not at this key's venue." }, { status: 404 });
  if (typeof body.date !== "string" || !isValidDateString(body.date)) return NextResponse.json({ error: "date (YYYY-MM-DD) is required." }, { status: 400 });
  const time = readTime(body);
  if (!time.ok) return NextResponse.json({ error: time.error }, { status: 400 });
  if (typeof body.name !== "string" || body.name.trim().length < 2 || typeof body.phone !== "string" || body.phone.trim().length < 7)
    return NextResponse.json({ error: "name and phone are required." }, { status: 400 });
  // Name and email checked and bounded as the booking form's are (lib/contact-fields.ts).
  const unkept = contactRefusal({ name: body.name, email: body.email });
  if (unkept) return refusal(unkept, 400);
  // How many places (or players, on a court priced per player), up to the most the venue lets one booking take: checked there.
  if (body.players !== undefined && !Number.isInteger(body.players))
    return NextResponse.json({ error: "players must be a whole number." }, { status: 400 });
  // Discounts asked for, as the booking form and the counter take them.
  if (body.concessionId !== undefined && body.concessionId !== null && (!Number.isInteger(body.concessionId) || (body.concessionId as number) <= 0))
    return NextResponse.json({ error: "concessionId must be a concession's id." }, { status: 400 });
  if (body.promoCode !== undefined && body.promoCode !== null && typeof body.promoCode !== "string")
    return NextResponse.json({ error: "promoCode must be a code." }, { status: 400 });
  const hostPhone = body.guestOf === undefined || body.guestOf === null ? null : typeof body.guestOf === "string" ? body.guestOf.trim() : "";
  if (hostPhone !== null && !/^\+?[0-9 -]{7,20}$/.test(hostPhone))
    return NextResponse.json({ error: "guestOf must be the host's phone number." }, { status: 400 });
  const placeConcessions = readPlaceConcessions(body.placeConcessions);
  if (placeConcessions === null)
    return NextResponse.json({ error: "placeConcessions must be a list of { participantId (null for the customer), concessionId }." }, { status: 400 });
  // Who takes part, where that is somebody other than the customer (refused, never guessed, otherwise).
  const asked = readSelection(body);
  if (asked && isRefusal(asked)) return NextResponse.json({ error: asked.error, code: asked.code }, { status: asked.status });
  const selection = asked ? await selectionAtVenue(caller.venueId, body.phone.trim(), asked.ids, asked.customerTakesPart) : null;
  if (selection && isRefusal(selection)) return NextResponse.json({ error: selection.error, code: selection.code }, { status: selection.status });
  // The guardian's agreement to the venue's waiver for each of them is already on record: a key cannot give it.
  if (selection)
    for (const p of selection.participants)
      if (!(await waiverSignedFor(caller.venueId, p.id)))
        return NextResponse.json({ error: `${p.name}'s guardian has not agreed to the venue's waiver for them.`, code: "WAIVER_NEEDED" }, { status: 409 });
  // So is the customer's own, where they take a place.
  if (!selection || selection.customerTakesPart)
    if (!(await waiverSigned(caller.venueId, body.phone.trim())))
      return NextResponse.json({ error: "The customer has not agreed to the venue's waiver.", code: "WAIVER_NEEDED" }, { status: 409 });
  // The venue's policies as every path asks them (lib/limits.ts `policyCheck`): the venue open, who may be booked
  // at a members-only or private venue (the number, or each person named), the house rules, the guest limit, a
  // refused number, no-show strikes and the unpaid-bookings limit. A key takes no money, so what online is held
  // until paid and the counter takes payment for is refused here, and nothing is overridden.
  // A member's or resident's guest: the host on the list for the date, the guest booked for their own place alone.
  const guestErr = (r: Refusal, status: number) => {
    const said = saidOn("api", r);
    return NextResponse.json({ error: said.error, code: said.code, ...(said.vars ? { vars: said.vars } : {}) }, { status });
  };
  let guestOf: GuestHost | null = null;
  if (hostPhone !== null) {
    if (selection) return guestErr({ ok: false, error: errorText(translator("en"), "GC8_GUEST_ALONE"), code: "GC8_GUEST_ALONE" }, 400);
    const found = await guestHostAt(caller.venueId, hostPhone, [body.date]);
    if ("ok" in found) return guestErr(found, found.code === "GC8_GUESTS_NOT_HERE" ? 400 : 409);
    guestOf = found;
  }
  const refused = await mayBookOn("api", {
    venueId: caller.venueId,
    phone: body.phone.trim(),
    dates: [body.date],
    participants: selection?.participants ?? [],
    customerTakesPart: !selection || selection.customerTakesPart,
    ...(guestOf ? { guestOf } : {}),
  });
  if (refused) {
    const said = saidOn("api", refused);
    return NextResponse.json({ error: said.error, code: said.code, ...(said.vars ? { vars: said.vars } : {}) }, { status: refused.code === "BUSY" ? 503 : 409 });
  }
  // On the list as the host's guest before the booking asks who may book here; taken back if it is not made.
  let registration: GuestRegistration | null = null;
  if (guestOf) {
    const registered = await registerGuest(guestOf, { phone: body.phone.trim(), name: body.name.trim() }, [body.date], { adminId: null, overrideAllowance: false });
    if (!registered.ok) return guestErr(registered, 409);
    registration = registered.registration;
  }
  const made = await createBooking({
    // The venue's own system answers for who it books, as its counter does (lib/sign-offs.ts).
    by: "api",
    ...(guestOf ? { guestOf: guestOf.id } : {}),
    ...(selection ? { participants: selection.participants, customerTakesPart: selection.customerTakesPart, addedBy: {} } : {}),
    courtId: court.id,
    date: body.date,
    ...time.when,
    name: body.name.trim(),
    phone: body.phone.trim(),
    email: typeof body.email === "string" && body.email.trim() ? body.email.trim() : undefined,
    ...(body.players !== undefined ? { players: body.players as number } : {}),
  });
  if (!made.ok) {
    if (registration) await undoGuestRegistration(registration);
    return NextResponse.json({ error: made.error, code: made.code, ...(made.vars ? { vars: made.vars } : {}) }, { status: 409 });
  }
  // The discounts asked for, as on every path: the same price for the same request.
  const discounts = await applyAskedDiscounts([made.booking], { concessionId: body.concessionId, placeConcessions, promoCode: body.promoCode });
  if (selection)
    await recordBookedFor(selection.participants, { adminId: null, name: `API key ${caller.keyId}` }, { venueId: caller.venueId, codes: [made.booking.code], how: "api" });
  await notifyBookingConfirmed([made.booking], "en", null);
  return NextResponse.json(
    {
      booking: { ...apiBooking({ ...made.booking, courtName: court.name, sport: court.sport }), participants: await apiParticipants(made.booking.id) },
      ...discounts,
    },
    { status: 201 }
  );
}
