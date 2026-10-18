import { NextRequest, NextResponse } from "next/server";
import { phoneRefusal } from "@/lib/phone-check";
import { refusal } from "@/lib/api";
import { getSessionUser } from "@/lib/auth";
import {
  applyPromo,
  createBookingOnAnyCourt,
  createBookingSeries,
  findBooking,
  getCourt,
  getVenue,
  payBookingFromWallet,
  payBookingWithPass,
} from "@/lib/store";
import { customerMayBook } from "@/lib/limits";
import { mayShowVenue } from "@/lib/listing";
import { rateLimit } from "@/lib/rate-limit";
import { isValidDateString } from "@/lib/time";
import { MAX_RECUR_WEEKS, Sport, SPORTS } from "@/lib/types";
import { currentLocale } from "@/lib/locale";
import { notifyBookingConfirmed, tickOutbox } from "@/lib/notify";
import { takesPaymentOnline } from "@/lib/payments";
import { chatNumber, chatRepliesOn } from "@/lib/outbox";
import { addonsFor, attachAddons, priceChoice, readChosen, type BookingAddon } from "@/lib/addons";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { courtId, venueId, sport, date, hours, name, phone, email, weeks, skipConflicts, payFromWallet, payWithPass, promoCode, addons } =
    (body ?? {}) as Record<string, unknown>;

  // Either name a court, or name a venue and sport and let us pick the
  // cheapest one that is free.
  const anyCourt = courtId === undefined || courtId === null;
  if (anyCourt) {
    if (!Number.isInteger(venueId) || (venueId as number) <= 0)
      return NextResponse.json(
        { error: "Give a courtId, or a venueId and sport to pick one for you." },
        { status: 400 }
      );
    if (typeof sport !== "string" || !SPORTS.includes(sport as Sport))
      return NextResponse.json({ error: "Unknown sport." }, { status: 400 });
  } else if (!Number.isInteger(courtId) || (courtId as number) <= 0) {
    return NextResponse.json({ error: "courtId is required." }, { status: 400 });
  }
  if (typeof date !== "string" || !isValidDateString(date))
    return NextResponse.json({ error: "Invalid date. Use YYYY-MM-DD." }, { status: 400 });
  if (!Array.isArray(hours) || hours.some((h) => !Number.isInteger(h)))
    return NextResponse.json({ error: "hours must be an array of integers." }, { status: 400 });
  if (typeof name !== "string" || name.trim().length < 2)
    return NextResponse.json({ error: "Please provide your name." }, { status: 400 });
  if (typeof phone !== "string" || !/^\+?[0-9 -]{7,20}$/.test(phone.trim()))
    return NextResponse.json({ error: "Please provide a valid phone number." }, { status: 400 });
  if (email !== undefined && email !== null && email !== "" &&
      (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))
    return NextResponse.json({ error: "Please provide a valid email address." }, { status: 400 });
  if (weeks !== undefined &&
      (!Number.isInteger(weeks) || (weeks as number) < 1 || (weeks as number) > MAX_RECUR_WEEKS))
    return NextResponse.json(
      { error: `weeks must be between 1 and ${MAX_RECUR_WEEKS}.` },
      { status: 400 }
    );

  const chosen = readChosen(addons);
  if (!chosen) return NextResponse.json({ error: "addons must be a list of { addonId, quantity }." }, { status: 400 });

  const limited = rateLimit(req, "booking");
  if (limited) return limited;

  const user = await getSessionUser(req);
  // An account books with a number the venue can reach, checked where numbers are.
  if (user) {
    const noPhone = await phoneRefusal(user.id);
    if (noPhone) return refusal(noPhone, 403);
  }

  // Not too many unpaid bookings ahead on one number, no weekly series
  // without an account, and not from a number this venue has refused.
  const venueOfBooking = anyCourt ? (venueId as number) : (await getCourt(courtId as number))?.venueId;
  if (venueOfBooking !== undefined) {
    const refused = await customerMayBook({
      venueId: venueOfBooking,
      phone,
      weeks: (weeks as number) ?? 1,
      signedIn: user !== null,
      preview: (await mayShowVenue(venueOfBooking, req)).preview,
    });
    if (refused) return refusal(refused);
  }

  // Extras are checked before anything is held, so a racket that has run out
  // is said now, while the customer can still change their mind.
  if (chosen.length > 0) {
    if (typeof payWithPass === "string" && payWithPass.trim() !== "")
      return refusal({ ok: false, error: "A pass pays for court time only. Pay for a booking with extras another way.", code: "PASS_NOT_FOR_EXTRAS" });
    const court = anyCourt ? null : await getCourt(courtId as number);
    if (venueOfBooking !== undefined && (anyCourt || court)) {
      const priced = await priceChoice(chosen, {
        venueId: venueOfBooking,
        sport: anyCourt ? (sport as Sport) : court!.sport,
        date,
        hours: hours as number[],
      });
      if (!priced.ok) return refusal(priced);
    }
  }

  const common = {
    date,
    hours: hours as number[],
    weeks: (weeks as number) ?? 1,
    name: name.trim(),
    phone: phone.trim(),
    email: typeof email === "string" && email !== "" ? email.trim() : undefined,
    userId: user?.id,
    skipConflicts: skipConflicts === true,
  };

  const result = anyCourt
    ? await createBookingOnAnyCourt({
        ...common,
        venueId: venueId as number,
        sport: sport as Sport,
      })
    : await createBookingSeries({ ...common, courtId: courtId as number });

  if (!result.ok) return refusal(result);

  // A code is claimed before anything is settled, so paying from credit or a
  // pass charges the discounted figure. Like paying, it is best-effort: a code
  // that has run out leaves the booking standing at full price with the reason.
  let promoError: string | null = null;
  let discount = 0;
  if (typeof promoCode === "string" && promoCode.trim() !== "") {
    for (const booking of result.bookings) {
      const applied = await applyPromo(booking.id, promoCode);
      if (!applied.ok) {
        if (!promoError) promoError = applied.error;
      } else {
        booking.totalPrice = applied.newTotal;
        discount += applied.discount;
      }
    }
  }

  // Extras go on after the code, which is for the court, and before paying,
  // so credit and the counter charge them with it. A week of a series whose
  // rackets have all gone out stands without extras, and says so.
  let addonError: { error: string; code?: string; vars?: Record<string, string | number> } | null = null;
  const addonLines: BookingAddon[] = [];
  if (chosen.length > 0) {
    for (const booking of result.bookings) {
      const added = await attachAddons(booking.id, chosen);
      if (!added.ok) {
        if (!addonError) addonError = { error: added.error, code: added.code, vars: added.vars };
      } else {
        booking.totalPrice = Math.round((booking.totalPrice + added.total) * 100) / 100;
        if (addonLines.length === 0) addonLines.push(...added.lines);
      }
    }
  }

  // Settling is best-effort: an empty wallet or a spent pass leaves the
  // booking standing as unpaid rather than throwing it away.
  const payErrors: string[] = [];
  if (typeof payWithPass === "string" && payWithPass.trim() !== "") {
    // The pass itself proves entitlement: it must match the booking's phone
    // number, which payBookingWithPass checks.
    for (const booking of result.bookings) {
      const paid = await payBookingWithPass(booking.id, payWithPass);
      if (!paid.ok) payErrors.push(paid.error);
      else booking.paymentStatus = "paid";
    }
  } else if (payFromWallet === true && user) {
    for (const booking of result.bookings) {
      const paid = await payBookingFromWallet(booking.id);
      if (!paid.ok) payErrors.push(paid.error);
      else booking.paymentStatus = "paid";
    }
  }

  // Queued after the money has settled, so the total in the message is the
  // total the customer will actually be asked for at the counter.
  await notifyBookingConfirmed(result.bookings, await currentLocale(), result.seriesCode);
  await tickOutbox();

  const court = (await getCourt(result.bookings[0].courtId))!;
  const venue = (await getVenue(court.venueId))!;
  return NextResponse.json(
    {
      booking: result.bookings[0],
      bookings: result.bookings,
      skipped: result.skipped,
      seriesCode: result.seriesCode,
      walletError: payErrors[0] ?? null,
      promoError,
      discount,
      addons: addonLines,
      addonError,
      // The customer can open the chat themselves and have it there for free.
      chatNumber: chatRepliesOn() ? chatNumber() : null,
      court,
      venue: { id: venue.id, name: venue.name, area: venue.area },
      payOnline: await takesPaymentOnline(venue.id),
    },
    { status: 201 }
  );
}

export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const code = params.get("code");
  const phone = params.get("phone");
  if (!code || !phone)
    return NextResponse.json({ error: "code and phone are required." }, { status: 400 });

  const limited = rateLimit(req, "bookingLookup");
  if (limited) return limited;

  const booking = await findBooking(code, phone);
  if (!booking)
    return NextResponse.json(
      { error: "Booking not found. Check the code and phone number." },
      { status: 404 }
    );

  const court = (await getCourt(booking.courtId))!;
  const venue = (await getVenue(court.venueId))!;
  return NextResponse.json({
    booking,
    court,
    venue: {
      id: venue.id,
      name: venue.name,
      area: venue.area,
      address: venue.address,
      cancelCutoffHours: venue.cancelCutoffHours,
    },
    payOnline: await takesPaymentOnline(venue.id),
    addons: (await addonsFor([booking.id])).get(booking.id) ?? [],
  });
}
