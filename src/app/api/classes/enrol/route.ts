import { NextRequest, NextResponse } from "next/server";
import { classRefusal } from "@/lib/who";
import { phoneRefusal } from "@/lib/phone-check";
import { refusal } from "@/lib/api";
import { getSessionUser } from "@/lib/auth";
import { customerMayBook } from "@/lib/limits";
import { mayShowVenue } from "@/lib/listing";
import { rateLimit } from "@/lib/rate-limit";
import { enrolInClass, getClass, payBookingFromWallet } from "@/lib/store";
import { currentLocale } from "@/lib/locale";
import { notifyClassEnrolled, tickOutbox } from "@/lib/notify";
import { chatNumber } from "@/lib/outbox";
import { chatOfferedFor } from "@/lib/whatsapp-credit";
import { attachAddons, priceChoice, readChosen, type BookingAddon } from "@/lib/addons";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { classId, name, phone, email, payFromWallet, confirmWho, addons } = (body ?? {}) as Record<
    string,
    unknown
  >;

  if (!Number.isInteger(classId) || (classId as number) <= 0)
    return NextResponse.json({ error: "classId is required." }, { status: 400 });
  if (typeof name !== "string" || name.trim().length < 2)
    return NextResponse.json({ error: "Please provide your name." }, { status: 400 });
  if (typeof phone !== "string" || !/^\+?[0-9 -]{7,20}$/.test(phone.trim()))
    return NextResponse.json({ error: "Please provide a valid phone number." }, { status: 400 });
  if (email !== undefined && email !== null && email !== "" &&
      (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))
    return NextResponse.json({ error: "Please provide a valid email address." }, { status: 400 });

  const chosen = readChosen(addons);
  if (!chosen) return NextResponse.json({ error: "addons must be a list of { addonId, quantity }." }, { status: 400 });

  const limited = rateLimit(req, "booking");
  if (limited) return limited;

  const user = await getSessionUser(req);
  // An account enrols with a number the venue can reach, checked where numbers are.
  if (user) {
    const noPhone = await phoneRefusal(user.id);
    if (noPhone) return refusal(noPhone, 403);
  }
  const forClass = await getClass(classId as number);
  if (forClass) {
    // A women-only or men-only class: by the account, or a guest saying so.
    const notFor = await classRefusal(forClass.who, user?.id ?? null, confirmWho === true);
    if (notFor) return refusal(notFor, 403);
    const refused = await customerMayBook({
      venueId: forClass.venueId,
      phone,
      signedIn: user !== null,
      preview: (await mayShowVenue(forClass.venueId, req)).preview,
    });
    if (refused) return refusal(refused);
    // A mat or a towel that has run out is said before the place is taken.
    if (chosen.length > 0) {
      const priced = await priceChoice(chosen, {
        venueId: forClass.venueId,
        sport: forClass.sport,
        date: forClass.date,
        hours: Array.from({ length: forClass.endHour - forClass.startHour }, (_, i) => forClass.startHour + i),
      });
      if (!priced.ok) return refusal(priced);
    }
  }
  const result = await enrolInClass({
    classId: classId as number,
    name: name.trim(),
    phone: phone.trim(),
    email: typeof email === "string" && email !== "" ? email.trim() : undefined,
    userId: user?.id,
  });
  if (!result.ok) return refusal(result);

  // On the enrolment's price, before it is paid from credit.
  let addonError: { error: string; code?: string; vars?: Record<string, string | number> } | null = null;
  let addonLines: BookingAddon[] = [];
  if (chosen.length > 0) {
    const added = await attachAddons(result.booking.id, chosen);
    if (added.ok) {
      addonLines = added.lines;
      result.booking.totalPrice = Math.round((result.booking.totalPrice + added.total) * 100) / 100;
    } else addonError = { error: added.error, code: added.code, vars: added.vars };
  }

  let walletError: string | null = null;
  if (payFromWallet === true && user) {
    const paid = await payBookingFromWallet(result.booking.id);
    if (paid.ok) result.booking.paymentStatus = "paid";
    else walletError = paid.error;
  }

  const session = await getClass(classId as number);
  if (session)
    await notifyClassEnrolled(result.booking, await currentLocale(), session);
  await tickOutbox();

  return NextResponse.json({
      booking: result.booking,
      session,
      walletError,
      addons: addonLines,
      addonError,
      chatNumber: session && (await chatOfferedFor(session.venueId)) ? chatNumber() : null,
    }, { status: 201 });
}
