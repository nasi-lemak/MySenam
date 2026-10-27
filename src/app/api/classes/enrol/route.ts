import { NextRequest, NextResponse } from "next/server";
import { classRefusal } from "@/lib/who";
import { phoneRefusal } from "@/lib/phone-check";
import { refusal } from "@/lib/api";
import { getSessionUser } from "@/lib/auth";
import { customerMayBook } from "@/lib/limits";
import { signWaiver, waiverRefusal } from "@/lib/waivers";
import { mayShowVenue } from "@/lib/listing";
import { rateLimit } from "@/lib/rate-limit";
import { classTerm, enrolInTerm, enrolPeople, getClass, payBookingFromWallet } from "@/lib/store";
import { canAccessVenue, getSessionAdmin } from "@/lib/admin-auth";
import { logAction } from "@/lib/activity";
import { isRefusal, refused, type ParticipantRefusal } from "@/lib/participants";
import { readSelection, recordBookedFor, selectionAtVenue, selectionForAccount, type Selection } from "@/lib/participant-bookings";
import { currentLocale } from "@/lib/locale";
import { notifyBookingConfirmed, notifyClassEnrolled, rememberLocale, tickOutbox } from "@/lib/notify";
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
  const { classId, name, phone, email, payFromWallet, confirmWho, addons, term, agreeWaiver } = (body ?? {}) as Record<
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

  const limited = await rateLimit(req, "booking");
  if (limited) return limited;

  const user = await getSessionUser(req);
  // An account enrols with a number the venue can reach, checked where numbers are.
  if (user) {
    const noPhone = await phoneRefusal(user.id);
    if (noPhone) return refusal(noPhone, 403);
  }
  const forClass = await getClass(classId as number);
  // Enrolled by the venue's own staff (the counter), or by the customer online.
  const desk = await getSessionAdmin(req);
  const byStaff = desk !== null && forClass !== null && canAccessVenue(desk, forClass.venueId);
  // Who takes the places (lib/participant-bookings.ts): the customer, and
  // people this account acts for (online) or the venue knows with a guardian
  // on this number (at the counter). Each their own place and enrolment.
  const asked = readSelection((body ?? {}) as Record<string, unknown>);
  const refusedPeople = (r: ParticipantRefusal) => NextResponse.json({ error: r.error, code: r.code, ...(r.vars ? { vars: r.vars } : {}) }, { status: r.status });
  if (asked && isRefusal(asked)) return refusedPeople(asked);
  let selection: Selection | null = null;
  if (asked) {
    const resolved =
      byStaff && forClass
        ? await selectionAtVenue(forClass.venueId, phone.trim(), asked.ids, asked.customerTakesPart)
        : user
          ? await selectionForAccount(user.id, asked.ids, asked.customerTakesPart)
          : refused("GUARD_NOT_FOUND", "Not one of the people you manage.", 404);
    if (isRefusal(resolved)) return refusedPeople(resolved);
    selection = resolved;
  }
  const customerTakesPart = !selection || selection.customerTakesPart;
  const people = [...(customerTakesPart ? [null] : []), ...(selection?.participants ?? [])];
  if (forClass) {
    // A women-only or men-only class: by the account, or a guest saying so; for
    // somebody else, the adult booking says so on their behalf.
    if (customerTakesPart) {
      const notFor = await classRefusal(forClass.who, user?.id ?? null, confirmWho === true);
      if (notFor) return refusal(notFor, 403);
    }
    if (selection && selection.participants.length > 0) {
      const notFor = await classRefusal(forClass.who, null, confirmWho === true);
      if (notFor) return refusal(notFor, 403);
    }
    // The whole term counts as a booking a session, as a weekly series does.
    const termInfo = term === true ? await classTerm(forClass.id) : null;
    const refused = await customerMayBook({
      venueId: forClass.venueId,
      phone,
      signedIn: user !== null,
      userId: user?.id ?? null,
      preview: (await mayShowVenue(forClass.venueId, req)).preview,
      ...(termInfo ? { dates: termInfo.sessions.map((c) => c.date) } : {}),
      // The venue's staff at its counter enrol anyone; each participant's own membership is still asked.
      atCounter: byStaff,
      // Places only for people the account books for: each must be a member themself (lib/entitlements.ts).
      placesForOthers: !customerTakesPart && (selection?.participants.length ?? 0) > 0,
    });
    if (refused) return refusal(refused);
    // The venue's waiver, agreed to once per version (lib/waivers.ts): for each person taking a place.
    for (const who of people) {
      const unsigned = await waiverRefusal(forClass.venueId, phone, agreeWaiver, who?.id ?? null);
      if (unsigned) return refusal(unsigned);
    }
    if (agreeWaiver === true) for (const who of people) await signWaiver(forClass.venueId, { phone, name, participant: who });
    // A mat or a towel that has run out is said before the place is taken.
    if (chosen.length > 0) {
      const priced = await priceChoice(chosen, {
        venueId: forClass.venueId,
        sport: forClass.sport,
        date: forClass.date,
        span: { start: forClass.startMin, end: forClass.endMin },
      });
      if (!priced.ok) return refusal(priced);
    }
  }
  // Who did it, for whom, where: each participant's history, and staff's in the activity log.
  const recordEnrolled = async (codes: string[]) => {
    if (!selection || selection.participants.length === 0 || !forClass) return;
    await recordBookedFor(selection.participants, byStaff ? { adminId: desk!.id, name: desk!.name } : { userId: user!.id, name: user!.name }, {
      venueId: forClass.venueId,
      codes,
      how: "class",
    });
    if (byStaff)
      await logAction(desk!, {
        venueId: forClass.venueId,
        action: "class.enrol_participant",
        bookingCode: codes[0] ?? null,
        detail: `Enrolled ${selection.participants.map((p) => `${p.name} (participant ${p.id})`).join(", ")} in ${forClass.name} at the counter: ${codes.join(", ")}`,
      });
  };

  // Every session left, at once: one confirmation, one bill (lib/store.ts `enrolInTerm`). Extras go on one session at a time.
  if (term === true) {
    const joined = await enrolInTerm({
      classId: classId as number,
      name: name.trim(),
      phone: phone.trim(),
      email: typeof email === "string" && email !== "" ? email.trim() : undefined,
      userId: user?.id,
      people,
      addedBy: byStaff ? { adminId: desk!.id } : { userId: user?.id ?? null },
    });
    if (!joined.ok) return refusal(joined);
    await recordEnrolled(joined.bookings.map((b) => b.code));
    let walletError: string | null = null;
    if (payFromWallet === true && user)
      for (const b of joined.bookings) {
        const paid = await payBookingFromWallet(b.id);
        if (paid.ok) b.paymentStatus = "paid";
        else walletError ??= paid.error;
      }
    const locale = await currentLocale();
    await rememberLocale(joined.bookings.map((b) => b.id), locale);
    await notifyBookingConfirmed(joined.bookings, locale, joined.seriesCode);
    await tickOutbox();
    return NextResponse.json(
      { bookings: joined.bookings, skipped: joined.skipped, seriesCode: joined.seriesCode, session: await getClass(classId as number), walletError },
      { status: 201 }
    );
  }

  const enrolled = await enrolPeople({
    classId: classId as number,
    name: name.trim(),
    phone: phone.trim(),
    email: typeof email === "string" && email !== "" ? email.trim() : undefined,
    userId: user?.id,
    people,
    addedBy: byStaff ? { adminId: desk!.id } : { userId: user?.id ?? null },
  });
  if (!enrolled.ok) return refusal(enrolled);
  await recordEnrolled(enrolled.bookings.map((b) => b.code));
  // The first enrolment answers as one always did; every one is in `bookings`.
  const result = { ok: true as const, booking: enrolled.bookings[0] };
  const others = enrolled.bookings.slice(1);

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
    for (const b of [result.booking, ...others]) {
      const paid = await payBookingFromWallet(b.id);
      if (paid.ok) b.paymentStatus = "paid";
      else walletError ??= paid.error;
    }
  }

  const session = await getClass(classId as number);
  const locale = await currentLocale();
  await rememberLocale([result.booking, ...others].map((b) => b.id), locale);
  // Each enrolment told to the customer (the guardian), naming who it is for.
  if (session) for (const b of [result.booking, ...others]) await notifyClassEnrolled(b, locale, session);
  await tickOutbox();

  return NextResponse.json({
      booking: result.booking,
      bookings: [result.booking, ...others],
      session,
      walletError,
      addons: addonLines,
      addonError,
      chatNumber: session && (await chatOfferedFor(session.venueId)) ? chatNumber() : null,
    }, { status: 201 });
}
