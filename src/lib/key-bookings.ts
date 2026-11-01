import { NextResponse } from "next/server";
import { apiBooking, apiParticipants, type ApiCaller } from "./api-keys";
import { isRefusal } from "./participants";
import { readSelection, recordBookedFor, selectionAtVenue } from "./participant-bookings";
import { waiverSigned, waiverSignedFor } from "./waivers";
import { notifyBookingConfirmed, notifyVenueCancelled } from "./notify";
import { bookingForVenue } from "./public-api";
import { createBooking, findBookingByCode, getCourt, quoteFor } from "./store";
import { applyAskedDiscounts } from "./booking-discounts";
import { readPlaceConcessions } from "./entitlements";
import { mayBookOn, saidOn } from "./limits";
import { asksStaffPowers } from "./policy-overrides";
import { guestHostAt, registerGuest, undoGuestRegistration, type GuestHost, type GuestRegistration } from "./guest-invites";
import type { Booking, Refusal } from "./types";
import { errorText, translator } from "./i18n";
import { isValidDateString } from "./time";
import { readTime, refusal } from "./api";
import { contactRefusal } from "./contact-fields";
import { counterPaymentOn, venueCancel } from "./counter-refunds";
import { refundCancelled } from "./payments";
import { money } from "./region";

/**
 * Booking and cancelling through a venue's own API key: the one code
 * `POST /api/v1/bookings`, `POST /api/v1/bookings/<code>/cancel` and the MCP
 * server's `create_booking` and `cancel_booking` (lib/mcp) share
 * (docs/integrations/external-api.md, docs/integrations/mcp.md). Each answers
 * as the route does: the response itself, the same status, refusal and body.
 *
 * `preview: true` runs every check that does not change anything and answers
 * 200 with `{ preview }`: what the booking would cost now and what the
 * customer would be told, or what cancelling would do. Nothing is booked,
 * cancelled, registered or sent. What only making the booking can tell (the
 * time still free, the court's booking rules on that time) is said by the real
 * call; a preview is advisory, as a quote is.
 */

/** What the customer is told when a booking is made through a key, in the API's words. */
export const BOOKED_CUSTOMER_TOLD = "The customer is sent the venue's usual booking confirmation, by the messages the venue uses.";
/** What the customer is told, and what happens to money, when a booking is cancelled through a key. */
export const CANCELLED_CUSTOMER_TOLD = "The customer is told the venue cancelled the booking.";

/**
 * `{ courtId, date, start, end, name, phone, … }` (see the route) → a booking,
 * as the venue's own system makes it; with `preview`, what it would be.
 */
export async function bookThroughKey(
  caller: ApiCaller,
  body: Record<string, unknown> | null,
  // `actor`: who the participants' records name as booking them, where that is a member of staff acting through an
  // AI assistant they signed in from (lib/mcp/oauth.ts) rather than the key itself.
  opts: { preview?: boolean; actor?: { adminId: number | null; name: string } } = {}
): Promise<NextResponse> {
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
  if (opts.preview) {
    // What it would cost now, priced as the booking will be (lib/store.ts `quoteFor`): nothing kept, nobody told.
    const priced = await quoteFor({
      courtId: court.id,
      date: body.date,
      ...time.when,
      phone: body.phone.trim(),
      userId: null,
      by: "api",
      ...(body.players !== undefined ? { players: body.players as number } : {}),
      ...(selection ? { people: { participants: selection.participants, customerTakesPart: selection.customerTakesPart } } : {}),
    });
    if (!priced.ok) return refusal(priced, 409);
    if (!priced.allowed) return refusal(priced.refusal, 409);
    return NextResponse.json({
      preview: {
        courtId: court.id,
        courtName: court.name,
        sport: court.sport,
        date: body.date,
        startMin: priced.span.start,
        endMin: priced.span.end,
        totalPrice: priced.quote.total,
        fees: priced.quote.fees,
        paymentStatus: "unpaid",
        ...(guestOf ? { guestOfHost: true } : {}),
        ...(body.concessionId || body.promoCode || placeConcessions.length > 0 ? { discountsAsked: true } : {}),
        customerTold: BOOKED_CUSTOMER_TOLD,
      },
    });
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
    await recordBookedFor(selection.participants, opts.actor ?? { adminId: null, name: `API key ${caller.keyId}` }, { venueId: caller.venueId, codes: [made.booking.code], how: "api" });
  await notifyBookingConfirmed([made.booking], "en", null);
  return NextResponse.json(
    {
      booking: { ...apiBooking({ ...made.booking, courtName: court.name, sport: court.sport }), participants: await apiParticipants(made.booking.id) },
      ...discounts,
    },
    { status: 201 }
  );
}

/**
 * Cancel one of the venue's bookings, as its staff would. The customer is
 * told. A counter payment on it is owed back, for the desk to hand back or
 * give as credit (lib/counter-refunds.ts `venueCancel`). With `preview`: the
 * booking and what cancelling it would do.
 */
export async function cancelThroughKey(caller: ApiCaller, code: string, opts: { preview?: boolean } = {}): Promise<NextResponse> {
  const found = await bookingForVenue(caller.venueId, code);
  if (!found) return NextResponse.json({ error: "Booking not found." }, { status: 404 });
  if (opts.preview) {
    const b = (await findBookingByCode(code)) as Booking;
    const counter = b.status === "cancelled" ? null : await counterPaymentOn(b.id);
    return NextResponse.json({
      preview: {
        booking: found,
        alreadyCancelled: b.status === "cancelled",
        consequence:
          b.status === "cancelled"
            ? "It is already cancelled; nothing would change."
            : [
                "The booking is cancelled in full and its time is offered again.",
                "Money paid online, with credit or with a pass goes back as when staff cancel.",
                counter !== null ? `A counter payment of ${money(counter)} on it is written down as owed back, for the desk to hand back or give as credit.` : null,
              ]
                .filter(Boolean)
                .join(" "),
        customerTold: b.status === "cancelled" ? null : CANCELLED_CUSTOMER_TOLD,
      },
    });
  }
  const done = await venueCancel(code, "api");
  if (!done.ok) return NextResponse.json({ error: done.error, code: done.code }, { status: 409 });
  await refundCancelled([done.booking.id], { byVenue: true });
  await notifyVenueCancelled(done.booking);
  return NextResponse.json({ booking: await bookingForVenue(caller.venueId, code) });
}
