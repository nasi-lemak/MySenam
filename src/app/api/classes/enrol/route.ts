import { NextRequest, NextResponse } from "next/server";
import { classRefusal } from "@/lib/who";
import { phoneRefusal } from "@/lib/phone-check";
import { refusal } from "@/lib/api";
import { getSessionUser } from "@/lib/auth";
import { policyCheck } from "@/lib/limits";
import { overrideRefusal, policyRefusal, readOverride, type PolicyOverrideRecord } from "@/lib/policy-overrides";
import { logOverride, policyRefused } from "@/lib/counter-policy";
import { money } from "@/lib/region";
import { COUNTER_METHODS, PAID_VIA_LABELS, type Booking, type CounterMethod } from "@/lib/types";
import { signWaiver, waiverRefusal } from "@/lib/waivers";
import { mayShowVenue } from "@/lib/listing";
import { rateLimit } from "@/lib/rate-limit";
import { classTerm, enrolInTerm, enrolPeople, getClass, payBookingFromWallet, setPaymentStatus } from "@/lib/store";
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

  // A manager's override of the venue's policies, and payment taken as it is booked: the counter's (as app/api/bookings).
  const askOverride = readOverride((body ?? {}) as Record<string, unknown>);
  if (askOverride && "ok" in askOverride) return refusal(askOverride, 400);
  const { paidAtCounter } = (body ?? {}) as Record<string, unknown>;
  if (paidAtCounter !== undefined && paidAtCounter !== null && !COUNTER_METHODS.includes(paidAtCounter as CounterMethod))
    return NextResponse.json({ error: `paidAtCounter must be one of ${COUNTER_METHODS.join(", ")}.` }, { status: 400 });

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
  if (askOverride && !byStaff) return refusal(policyRefusal("R9_OVERRIDE_MANAGERS"), 403);
  if (askOverride && byStaff) {
    const no = await overrideRefusal(desk, forClass.venueId, askOverride);
    if (no) return refusal(no.refusal, no.status);
  }
  if (paidAtCounter !== undefined && paidAtCounter !== null && !byStaff) return refusal(policyRefusal("R9_PAY_NOW_STAFF"), 403);
  const payNow = byStaff && paidAtCounter !== undefined && paidAtCounter !== null ? (paidAtCounter as CounterMethod) : null;
  let policyOverride: PolicyOverrideRecord | undefined;
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
    // The venue's policies as a booking asks them, online and at the counter alike (lib/limits.ts `policyCheck`):
    // the house rules for the class's date (or every session of the term), as booking and joining its waiting
    // list ask them. An enrolment online is not held until paid, so a number past its no-shows, or a guest
    // in a flood of unpaid guest bookings, is refused online; at the counter it is paid as it is enrolled.
    const path = byStaff ? ("staff" as const) : ("customer" as const);
    const answer = await policyCheck(path, {
      venueId: forClass.venueId,
      phone,
      signedIn: user !== null,
      userId: user?.id ?? null,
      preview: (await mayShowVenue(forClass.venueId, req)).preview,
      dates: termInfo ? termInfo.sessions.map((c) => c.date) : [forClass.date],
      canPayOnline: false,
      // Places only for people the account books for: each must be a member themself (lib/entitlements.ts).
      placesForOthers: !customerTakesPart && (selection?.participants.length ?? 0) > 0,
      // At the counter, who is enrolled at a members-only or private venue: the number, or each person named.
      participants: selection?.participants ?? [],
      customerTakesPart,
      paidNow: payNow !== null,
      ...(askOverride ? { overrides: askOverride.policies } : {}),
    });
    if (answer.refusal) return policyRefused(path, answer.refusal, byStaff ? { staff: desk!, venueId: forClass.venueId } : null);
    if (byStaff && askOverride && answer.overridden.length > 0)
      policyOverride = { venueId: forClass.venueId, adminId: desk!.id, adminName: desk!.name, reason: askOverride.reason, overridden: answer.overridden };
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

  // At the counter: a manager's override kept in the activity log against each enrolment, and payment taken as
  // it is enrolled (how, as staff say), on the record as any counter payment is.
  const atCounter = async (made: Booking[]) => {
    if (!byStaff || !desk || !forClass) return;
    if (policyOverride) for (const b of made) await logOverride(desk, b.code, { name: name.trim(), phone: phone.trim() }, policyOverride);
    if (payNow)
      for (const b of made) {
        if (b.paymentStatus === "paid") continue;
        const paid = await setPaymentStatus(b.code, true, payNow, desk.role, desk);
        if (!paid.ok) continue;
        b.paymentStatus = "paid";
        await logAction(desk, {
          venueId: forClass.venueId,
          action: "payment.paid",
          bookingCode: b.code,
          detail: `${money(b.totalPrice)}, by ${PAID_VIA_LABELS[payNow]}, as it was enrolled`,
        });
      }
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
      ...(policyOverride ? { policyOverride } : {}),
    });
    if (!joined.ok) return refusal(joined);
    await recordEnrolled(joined.bookings.map((b) => b.code));
    await atCounter(joined.bookings);
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
    ...(policyOverride ? { policyOverride } : {}),
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
  await atCounter([result.booking, ...others]);

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
