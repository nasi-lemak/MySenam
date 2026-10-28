import { isActivity } from "@/lib/activities";
import { NextRequest, NextResponse } from "next/server";
import { concessionById } from "@/lib/concessions";
import { applyAskedDiscounts } from "@/lib/booking-discounts";
import { readPlaceConcessions } from "@/lib/entitlements";
import { phoneRefusal } from "@/lib/phone-check";
import { readTime, refusal } from "@/lib/api";
import { getSessionUser } from "@/lib/auth";
import { canAccessVenue, getSessionAdmin } from "@/lib/admin-auth";
import { logAction } from "@/lib/activity";
import { breachMessage } from "@/lib/booking-rules";
import {
  createBookingOnAnyCourt,
  createBookingSeries,
  createGroupBooking,
  findBooking,
  getCourt,
  getPass,
  getVenue,
  payBookingFromWallet,
  payBookingWithPasses,
  policyForCourt,
  requestedSpan,
} from "@/lib/store";
import { attachCoach, coachById, coachWorks, discardBooking, type Coach } from "@/lib/coaching";
import { assignLessonCoach, coachChoice, coachDifferences, lessonRefusal, lessonSports } from "@/lib/lesson-coaches";
import { customerMayBook, guestSurge } from "@/lib/limits";
import { holdNewBookings, holdPolicy, releaseExpiredHolds } from "@/lib/holds";
import { cancelPolicy, cancelPolicyFor, struckOut } from "@/lib/cancel-policy";
import { cutoffFor } from "@/lib/sport-rules";
import { mayShowVenue } from "@/lib/listing";
import { rateLimit } from "@/lib/rate-limit";
import { addDays, isValidDateString, todayISO } from "@/lib/time";
import { formatLength, formatMinute } from "@/lib/interval";
import { windowFor } from "@/lib/house-rules";
import { doorFor, MAX_SERIES_WEEKS, Sport } from "@/lib/types";
import { currentLocale } from "@/lib/locale";
import { notifyBookingConfirmed, rememberLocale, tickOutbox } from "@/lib/notify";
import { refundStatusFor, takesPaymentOnline } from "@/lib/payments";
import { chatNumber } from "@/lib/outbox";
import { chatOfferedFor } from "@/lib/whatsapp-credit";
import { addonsFor, attachAddons, priceChoice, readChosen, type BookingAddon } from "@/lib/addons";
import { receiptPath } from "@/lib/receipts";
import { reviewable, reviewPath } from "@/lib/reviews";
import { recordConsent } from "@/lib/marketing";
import { accountsForUser, chargeToAccount } from "@/lib/accounts";
import { signWaiver, waiverRefusal } from "@/lib/waivers";
import { isRefusal, refused, type ParticipantRefusal } from "@/lib/participants";
import { readSelection, recordBookedFor, selectionAtVenue, selectionForAccount, type Named, type Selection } from "@/lib/participant-bookings";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  // Holds nobody paid for are let go first, so their slots can be booked now.
  await releaseExpiredHolds();
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  const { courtId, venueId, sport, date, name, phone, email, weeks, skipConflicts, payFromWallet, payWithPass, promoCode, addons, coachId, assignCoach, marketing, moreCourts, concessionId, players, chargeTo, agreeWaiver, override, placeConcessions, payWithPasses } =
    (body ?? {}) as Record<string, unknown>;
  // One person's own concession on their place, and one person's own pass for each place (lib/entitlements.ts).
  const perPlace = readPlaceConcessions(placeConcessions);
  if (perPlace === null)
    return NextResponse.json({ error: "placeConcessions must be a list of { participantId (null for yourself), concessionId }." }, { status: 400 });
  if (payWithPasses !== undefined && payWithPasses !== null && (!Array.isArray(payWithPasses) || payWithPasses.length > 13 || !payWithPasses.every((c) => typeof c === "string")))
    return NextResponse.json({ error: "payWithPasses must be a list of pass codes." }, { status: 400 });
  const passCodes = [...(Array.isArray(payWithPasses) ? (payWithPasses as string[]) : []), ...(typeof payWithPass === "string" ? [payWithPass] : [])].filter((c) => c.trim() !== "");

  // Either name a court, or name a venue and sport and let us pick the
  // cheapest one that is free.
  const anyCourt = courtId === undefined || courtId === null;
  if (anyCourt) {
    if (!Number.isInteger(venueId) || (venueId as number) <= 0)
      return NextResponse.json(
        { error: "Give a courtId, or a venueId and sport to pick one for you." },
        { status: 400 }
      );
    if (typeof sport !== "string" || !(await isActivity(sport)))
      return NextResponse.json({ error: "Unknown sport." }, { status: 400 });
  } else if (!Number.isInteger(courtId) || (courtId as number) <= 0) {
    return NextResponse.json({ error: "courtId is required." }, { status: 400 });
  } else if (sport !== undefined && sport !== null && typeof sport !== "string") {
    // On a named court, which of its activities: its main one if not said.
    return NextResponse.json({ error: "Unknown sport." }, { status: 400 });
  }
  if (typeof date !== "string" || !isValidDateString(date))
    return NextResponse.json({ error: "Invalid date. Use YYYY-MM-DD." }, { status: 400 });
  // Exact minutes (start and end, or start and a length), or the older list of grid columns.
  const time = readTime((body ?? {}) as Record<string, unknown>);
  if (!time.ok) return NextResponse.json({ error: time.error }, { status: 400 });
  const when = time.when;
  if (typeof name !== "string" || name.trim().length < 2)
    return NextResponse.json({ error: "Please provide your name." }, { status: 400 });
  if (typeof phone !== "string" || !/^\+?[0-9 -]{7,20}$/.test(phone.trim()))
    return NextResponse.json({ error: "Please provide a valid phone number." }, { status: 400 });
  if (email !== undefined && email !== null && email !== "" &&
      (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))
    return NextResponse.json({ error: "Please provide a valid email address." }, { status: 400 });
  if (weeks !== undefined &&
      (!Number.isInteger(weeks) || (weeks as number) < 1 || (weeks as number) > MAX_SERIES_WEEKS))
    return NextResponse.json(
      { error: `weeks must be between 1 and ${MAX_SERIES_WEEKS}.` },
      { status: 400 }
    );

  const chosen = readChosen(addons);
  if (!chosen) return NextResponse.json({ error: "addons must be a list of { addonId, quantity }." }, { status: 400 });
  // Other courts booked with this one, at the same time, as one (lib/store.ts `createGroupBooking`).
  // Each a court id, or { courtId, places?, participantIds?, customerTakesPart? }: a number of places on a
  // shared resource (a kind of kit of its own), and who takes part on that one (lib/participant-bookings.ts).
  type More = { courtId: number; places?: number; participantIds?: unknown; customerTakesPart?: unknown };
  const isMore = (c: unknown): c is More =>
    typeof c === "object" && c !== null && Number.isInteger((c as More).courtId) && (c as More).courtId > 0 &&
    ((c as More).places === undefined || (Number.isInteger((c as More).places) && (c as More).places! > 0));
  if (moreCourts !== undefined && moreCourts !== null && (!Array.isArray(moreCourts) || !moreCourts.every((c) => (Number.isInteger(c) && c > 0) || isMore(c))))
    return NextResponse.json({ error: "moreCourts must be a list of court ids, or of { courtId, places }." }, { status: 400 });
  const moreList = (Array.isArray(moreCourts) ? moreCourts : []) as (number | More)[];
  const group = moreList.length > 0 ? [courtId as number, ...moreList.map((c) => (typeof c === "number" ? c : c.courtId))] : null;
  const placesByCourt = Object.fromEntries(
    moreList.filter((c): c is More & { places: number } => typeof c !== "number" && c.places !== undefined).map((c) => [c.courtId, c.places])
  );
  if (group && (anyCourt || ((weeks as number) ?? 1) > 1 || (coachId !== undefined && coachId !== null) || assignCoach === true || chosen.length > 0))
    return refusal({ ok: false, error: "A booking of several courts is for one date, without extras or a coach.", code: "GROUP_ONE_COURT_ONLY" });

  const limited = await rateLimit(req, "booking");
  if (limited) return limited;

  // Staff may book outside a court's booking policy (its starts, lengths,
  // hours, notice and window), never over anything that holds the court.
  // Managers only, at their own venue, and each time it is recorded.
  let staff: Awaited<ReturnType<typeof getSessionAdmin>> = null;
  if (override === true) {
    staff = await getSessionAdmin(req);
    const venueToOverride = anyCourt ? (venueId as number) : (await getCourt(courtId as number))?.venueId;
    if (!staff || staff.role === "desk" || venueToOverride === undefined || !canAccessVenue(staff, venueToOverride))
      return refusal({ ok: false, error: "Only a manager of this venue may book outside its booking rules.", code: "OVERRIDE_NOT_ALLOWED" }, 403);
  }
  // Booked by the venue's own staff (the counter), who see who is in front of
  // them, or by the customer online: sign-offs are checked accordingly (lib/sign-offs.ts).
  const desk = staff ?? (await getSessionAdmin(req));
  const venueBooked = anyCourt ? (venueId as number) : (await getCourt(courtId as number))?.venueId;
  const byStaff = desk !== null && venueBooked !== undefined && canAccessVenue(desk, venueBooked);

  const user = await getSessionUser(req);
  // An account books with a number the venue can reach, checked where numbers are.
  if (user) {
    const noPhone = await phoneRefusal(user.id);
    if (noPhone) return refusal(noPhone, 403);
  }

  // Who takes part, where that is somebody other than (or as well as) the
  // customer (lib/participant-bookings.ts): online, only people this account
  // acts for now; at the counter, people the venue knows with a guardian on
  // the booking's number (staff record somebody new first, with the
  // guardian's declaration). Each is then checked on their own eligibility.
  // On several courts, each court's own people (`moreCourts`).
  const refusedPeople = (r: ParticipantRefusal) =>
    NextResponse.json({ error: r.error, code: r.code, ...(r.vars ? { vars: r.vars } : {}) }, { status: r.status });
  const resolve = async (ids: number[], takesPart: boolean): Promise<Selection | ParticipantRefusal> =>
    byStaff && venueBooked !== undefined
      ? selectionAtVenue(venueBooked, phone.trim(), ids, takesPart)
      : user
        ? selectionForAccount(user.id, ids, takesPart)
        : refused("GUARD_NOT_FOUND", "Not one of the people you manage.", 404);
  const asked = readSelection((body ?? {}) as Record<string, unknown>);
  if (asked && isRefusal(asked)) return refusedPeople(asked);
  let selection: Selection | null = null;
  if (asked) {
    const resolved = await resolve(asked.ids, asked.customerTakesPart);
    if (isRefusal(resolved)) return refusedPeople(resolved);
    selection = resolved;
  }
  // Courts of a group, each with its own people (none named: the customer's party, a count of places).
  const assign: Record<number, Selection> = {};
  if (group) {
    if (selection) assign[courtId as number] = selection;
    for (const c of moreList) {
      if (typeof c === "number") continue;
      const more = readSelection(c as Record<string, unknown>);
      if (more && isRefusal(more)) return refusedPeople(more);
      if (!more) continue;
      const resolved = await resolve(more.ids, more.customerTakesPart);
      if (isRefusal(resolved)) return refusedPeople(resolved);
      assign[c.courtId] = resolved;
    }
  }
  const named: Named[] = group ? Object.values(assign).flatMap((a) => a.participants) : (selection?.participants ?? []);
  // Does the customer take a place anywhere: alone, alongside the people named, or as a court of the group nobody is named on.
  const customerTakesPart = group
    ? group.some((id) => !assign[id] || assign[id].customerTakesPart)
    : !selection || selection.customerTakesPart;

  // Charged to a company or school account (lib/accounts.ts): only by somebody
  // signed in whose proved number the account lists.
  let account: { id: number; name: string } | null = null;
  if (chargeTo !== undefined && chargeTo !== null) {
    const venueOfAccount = anyCourt ? (venueId as number) : (await getCourt(courtId as number))?.venueId;
    account = user && Number.isInteger(chargeTo) && venueOfAccount !== undefined
      ? (await accountsForUser(venueOfAccount, user.id)).find((a) => a.id === chargeTo) ?? null
      : null;
    if (!account) return refusal({ ok: false, error: "That account cannot be charged here.", code: "ACCOUNT_NOT_HERE" }, 403);
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
      userId: user?.id ?? null,
      // Each court of a group counts as a booking, as each week of a series does.
      dates:
        typeof date === "string" && isValidDateString(date)
          ? group
            ? group.map(() => date)
            : Array.from({ length: Math.min(Math.max(1, Number(weeks) || 1), 52) }, (_, i) => addDays(date, i * 7))
          : undefined,
      preview: (await mayShowVenue(venueOfBooking, req)).preview,
      canPayOnline: await takesPaymentOnline(venueOfBooking),
      // The venue's staff at its counter book anyone, as the venue's own rules say; each participant's membership is still asked.
      atCounter: byStaff,
      // Places on a shared session for people the account books for, not itself: each their own member (lib/entitlements.ts).
      placesForOthers: !customerTakesPart && named.length > 0 && !anyCourt && !group && ((await getCourt(courtId as number))?.capacity ?? 1) > 1,
    });
    if (refused) return refusal(refused);
    // The venue's waiver, agreed to once per version (lib/waivers.ts): for everybody taking part, each their own.
    for (const who of [...(customerTakesPart ? [null] : []), ...named.map((p) => p.id)]) {
      const unsigned = await waiverRefusal(venueOfBooking, phone, agreeWaiver, who);
      if (unsigned) return refusal(unsigned);
    }
  }

  // A lesson: a coach of this sport, here, working then (lib/coaching.ts),
  // weekly too for a signed-in customer, as a court is. Whether they are free
  // is settled week by week when they are put on it.
  let coach: Coach | null = null;
  // Or the venue assigns the coach (lib/lesson-coaches.ts), where it says so: a lesson for the sport and time, and a
  // coach of the sport who is free then is put on it once it is booked. A customer there books no coach by name.
  const venueAssigns = assignCoach === true;
  let assignOnly: number | undefined;
  if (venueAssigns || (coachId !== undefined && coachId !== null)) {
    const choice = venueOfBooking !== undefined ? await coachChoice(venueOfBooking) : "customer";
    if (venueAssigns) {
      if (coachId !== undefined && coachId !== null) return NextResponse.json({ error: "Give a coachId or assignCoach, not both." }, { status: 400 });
      if (choice !== "venue") return refusal(lessonRefusal("LESSON_CHOOSE_COACH"));
      const lessonSport = anyCourt ? (sport as Sport) : (await getCourt(courtId as number))?.sport;
      if (!lessonSport || venueOfBooking === undefined || !(await lessonSports(venueOfBooking)).includes(lessonSport)) return refusal(lessonRefusal("LESSON_NO_COACH"));
      // A lesson pack pays only its own coach's lessons: paid with one, its coach is the one.
      for (const c of passCodes) {
        const pack = await getPass(c);
        if (pack?.coachId && pack.venueId === venueOfBooking) assignOnly = pack.coachId;
      }
    } else if (choice === "venue" && !byStaff) return refusal(lessonRefusal("LESSON_VENUE_ASSIGNS"));
  }
  if (coachId !== undefined && coachId !== null) {
    if (!Number.isInteger(coachId)) return NextResponse.json({ error: "coachId must be a number." }, { status: 400 });
    coach = await coachById(coachId as number);
    const lessonSport = anyCourt ? (sport as Sport) : (await getCourt(courtId as number))?.sport;
    if (!coach || !coach.active || coach.venueId !== venueOfBooking || !lessonSport || !coach.sports.includes(lessonSport))
      return refusal({ ok: false, error: "That coach does not give lessons in this sport here.", code: "COACH_NOT_FOUND" });
    const lesson = await requestedSpan(anyCourt ? { venueId: venueOfBooking!, sport: lessonSport } : { courtId: courtId as number }, when);
    if (!lesson.ok) return refusal(lesson);
    if (!coachWorks(coach, date, lesson.span))
      return refusal({
        ok: false,
        error: `${coach.name} does not take lessons at that time. Pick one of the times shown.`,
        code: "COACH_NOT_WORKING",
        vars: { name: coach.name },
      });
  }

  // Extras are checked before anything is held, so a racket that has run out
  // is said now, while the customer can still change their mind.
  if (chosen.length > 0) {
    if (passCodes.length > 0)
      return refusal({ ok: false, error: "A pass pays for court time only. Pay for a booking with extras another way.", code: "PASS_NOT_FOR_EXTRAS" });
    const court = anyCourt ? null : await getCourt(courtId as number);
    if (venueOfBooking !== undefined && (anyCourt || court)) {
      const asked = await requestedSpan(anyCourt ? { venueId: venueOfBooking, sport: sport as Sport } : { courtId: court!.id }, when);
      if (!asked.ok) return refusal(asked);
      const priced = await priceChoice(chosen, {
        venueId: venueOfBooking,
        sport: anyCourt || typeof sport === "string" ? (sport as Sport) : court!.sport,
        date,
        span: asked.span,
      });
      if (!priced.ok) return refusal(priced);
    }
  }

  const common = {
    date,
    ...when,
    ...(staff ? { staff: { override: true } } : {}),
    by: byStaff ? ("staff" as const) : ("customer" as const),
    weeks: (weeks as number) ?? 1,
    name: name.trim(),
    phone: phone.trim(),
    email: typeof email === "string" && email !== "" ? email.trim() : undefined,
    userId: user?.id,
    skipConflicts: skipConflicts === true,
    // How many play, where the court is priced per player, or how many places on a shared one (checked there).
    ...(players !== undefined ? { players: Number(players) } : {}),
    // The activity, on a court that offers several (checked there).
    ...(typeof sport === "string" && sport !== "" ? { sport: sport as Sport } : {}),
    // Who put the people named on it: the member of staff at the counter, or the account.
    addedBy: byStaff && desk ? { adminId: desk.id } : { userId: user?.id ?? null },
  };
  const forPeople = selection && selection.participants.length > 0 ? { participants: selection.participants, customerTakesPart: selection.customerTakesPart } : {};

  const result = anyCourt
    ? await createBookingOnAnyCourt({
        ...common,
        ...forPeople,
        venueId: venueId as number,
        sport: sport as Sport,
      })
    : group
      ? await createGroupBooking({ ...common, courtIds: group, placesByCourt, ...(Object.keys(assign).length > 0 ? { assign } : {}) })
      : await createBookingSeries({ ...common, ...forPeople, courtId: courtId as number });

  if (!result.ok) return refusal(result);

  // Outside the court's rules, on a manager's say: on the record.
  if (staff && result.overrides && result.overrides.length > 0) {
    const first = result.bookings[0];
    const rules = await policyForCourt(first.courtId);
    for (const booking of result.bookings)
      await logAction(staff, {
        venueId: (await getCourt(booking.courtId))?.venueId ?? null,
        action: "booking.override",
        bookingCode: booking.code,
        detail: `${booking.date} ${formatMinute(booking.startMin)}, ${formatLength(booking.endMin - booking.startMin)}: past ${result.overrides
          .map((b) => (rules ? breachMessage(rules, b) : b))
          .join("; ")}`,
      });
  }

  // The coach goes on before anything is paid, so the fee is in every total
  // that follows. Taken meanwhile by somebody else: the court goes too.
  if (coach) {
    const kept: typeof result.bookings = [];
    for (const booking of result.bookings) {
      const attached = await attachCoach(booking.id, coach);
      if (!attached.ok) {
        // A week the coach is already taken: skipped like a taken court, if the customer said so.
        if (result.bookings.length > 1 && skipConflicts === true) {
          await discardBooking(booking.id);
          result.skipped.push({ date: booking.date, reason: `${coach.name} is not free` });
          continue;
        }
        for (const b of result.bookings) await discardBooking(b.id);
        return refusal(attached);
      }
      booking.totalPrice = Math.round((booking.totalPrice + attached.fee) * 100) / 100;
      booking.coachId = coach.id;
      booking.coachFee = attached.fee;
      kept.push(booking);
    }
    if (kept.length === 0) return refusal({ ok: false, error: `${coach.name} has just been booked for that time. Pick another.`, code: "COACH_TAKEN", vars: { name: coach.name } });
    result.bookings.splice(0, result.bookings.length, ...kept);
  }
  // The venue's choice of coach, week by week, the first week's coach kept where they are free (lib/lesson-coaches.ts).
  let lessonCoach: { id: number; name: string } | null = coach ? { id: coach.id, name: coach.name } : null;
  if (venueAssigns) {
    const kept: typeof result.bookings = [];
    for (const booking of result.bookings) {
      const put = await assignLessonCoach(booking.id, assignOnly !== undefined ? { only: assignOnly } : lessonCoach ? { prefer: lessonCoach.id } : {});
      if (!put.ok) {
        if (result.bookings.length > 1 && skipConflicts === true) {
          await discardBooking(booking.id);
          result.skipped.push({ date: booking.date, reason: "no coach is free" });
          continue;
        }
        for (const b of result.bookings) await discardBooking(b.id);
        return refusal(put);
      }
      lessonCoach ??= { id: put.coach.id, name: put.coach.name };
      booking.totalPrice = Math.round((booking.totalPrice + put.fee) * 100) / 100;
      booking.coachId = put.coach.id;
      booking.coachFee = put.fee;
      kept.push(booking);
    }
    if (kept.length === 0) return refusal(lessonRefusal("LESSON_NO_COACH"));
    result.bookings.splice(0, result.bookings.length, ...kept);
  }

  // The discounts asked for, in the one order (a concession, each person's own, then a code),
  // best-effort, as every path puts them on (lib/booking-discounts.ts).
  const { concessionError, promoError, promoErrorCode, discount } = await applyAskedDiscounts(result.bookings, { concessionId, placeConcessions: perPlace, promoCode });

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

  // On an account, it is paid on the account's invoice: nothing to settle now.
  // Past the account's limit, nothing is booked.
  if (account) {
    const charged = await chargeToAccount(venueOfBooking!, account.id, result.bookings.map((b) => b.id));
    if (!charged.ok) {
      for (const b of result.bookings) await discardBooking(b.id);
      return refusal(charged);
    }
    for (const b of result.bookings) b.accountId = account.id;
  }

  // Settling is best-effort: an empty wallet or a spent pass leaves the
  // booking standing as unpaid rather than throwing it away.
  const payErrors: string[] = [];
  if (account) {
    // Paid on the invoice.
  } else if (passCodes.length > 0) {
    // The pass itself proves entitlement: it must match the booking's phone
    // number, which payBookingWithPasses checks. One person's pass pays that
    // person's place, so a booking for several is paid by one such pass each.
    for (const booking of result.bookings) {
      const paid = await payBookingWithPasses(booking.id, passCodes, { skipAbsent: group !== null });
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

  const court = (await getCourt(result.bookings[0].courtId))!;
  const venue = (await getVenue(court.venueId))!;
  if (agreeWaiver === true) {
    // Agreed by the customer for themself where they take part, and on behalf of each person named.
    if (customerTakesPart) await signWaiver(venue.id, { phone, name: name as string, bookingId: result.bookings[0].id });
    for (const p of named) await signWaiver(venue.id, { phone, name: name as string, bookingId: result.bookings[0].id, participant: p });
  }
  // Who did it, for whom, where: in each participant's history, and staff's in the activity log.
  if (named.length > 0) {
    const codes = result.bookings.map((b) => b.code);
    await recordBookedFor(named, byStaff && desk ? { adminId: desk.id, name: desk.name } : { userId: user!.id, name: user!.name }, {
      venueId: venue.id,
      codes,
      how: byStaff ? "counter" : "online",
    });
    if (byStaff && desk)
      for (const booking of result.bookings)
        await logAction(desk, {
          venueId: venue.id,
          action: "booking.for_participant",
          bookingCode: booking.code,
          detail: `Booked at the counter for ${(booking.participantName ?? named.map((p) => p.name).join(", "))} (participant${named.length > 1 ? "s" : ""} ${named.map((p) => p.id).join(", ")}), with ${(name as string).trim()} on ${(phone as string).trim()}`,
        });
  }

  // A venue asking for payment online to hold a booking: what is still
  // unpaid is held for a few minutes, and confirmed once it is paid.
  // So is one from a number with too many no-shows here (lib/cancel-policy.ts).
  const policy = await holdPolicy(venue.id);
  // So is a guest's while the venue is being flooded with unpaid guest bookings (lib/limits.ts).
  const mustPay =
    ((await struckOut(venue.id, phone)).out || (!user && (await guestSurge(venue.id)))) && (await takesPaymentOnline(venue.id));
  const holdUntil = !account && (policy.active || mustPay)
    ? await holdNewBookings(
        result.bookings.filter((b) => b.paymentStatus === "unpaid").map((b) => b.id),
        policy.minutes
      )
    : null;
  if (holdUntil) for (const b of result.bookings) if (b.paymentStatus === "unpaid" && b.totalPrice > 0) b.holdUntil = holdUntil;

  // Queued after the money has settled, so the total in the message is the
  // total the customer will actually be asked for at the counter. A held
  // booking is told about once it is paid (lib/payments.ts).
  const locale = await currentLocale();
  await rememberLocale(result.bookings.map((b) => b.id), locale);
  // Only when the box was ticked: news from this venue (lib/marketing.ts).
  if (marketing === true && typeof email === "string" && email.trim())
    await recordConsent({
      venueId: venue.id,
      email,
      name: name as string,
      userId: user?.id ?? null,
      locale,
      source: "booking",
      // Anybody can type an address: only the account's own is taken at its word.
      confirmed: !!user && user.email.trim().toLowerCase() === email.trim().toLowerCase(),
    });
  if (!holdUntil) await notifyBookingConfirmed(result.bookings, locale, result.seriesCode);
  await tickOutbox();
  return NextResponse.json(
    {
      booking: result.bookings[0],
      bookings: result.bookings,
      skipped: result.skipped,
      seriesCode: result.seriesCode,
      walletError: payErrors[0] ?? null,
      // Pay online by then, or the booking is let go.
      holdUntil,
      // Or just this share of it, the rest at the counter: the venue's choice, not for a number past its strikes.
      depositPercent: holdUntil && policy.active && !(await struckOut(venue.id, phone)).out ? policy.depositPercent : null,
      promoError,
      promoErrorCode,
      discount,
      concessionError,
      // What to bring for the concession price that went on.
      concession: result.bookings.some((b) => b.concessionName) && Number.isInteger(concessionId) ? await concessionById(concessionId as number) : null,
      addons: addonLines,
      addonError,
      // The customer can open the chat themselves and have it there for free.
      chatNumber: (await chatOfferedFor(venue.id)) ? chatNumber() : null,
      court,
      // Courts booked together: each one's name, for the confirmation's list.
      ...(group ? { courtNames: Object.fromEntries(await Promise.all(group.map(async (id) => [id, (await getCourt(id))?.name ?? ""]))) } : {}),
      venue: { id: venue.id, name: venue.name, area: venue.area, timeZone: venue.timeZone },
      // A lesson: its coach, named or assigned by the venue, for the confirmation.
      lessonCoach,
      payOnline: !account && (await takesPaymentOnline(venue.id)),
      // Charged to this account, on its monthly invoice.
      account: account ? { name: account.name } : null,
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

  const limited = await rateLimit(req, "bookingLookup");
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
      // This sport's own, where the venue gave it rules of its own (lib/sport-rules.ts).
      cancelCutoffHours: await cutoffFor(venue.id, booking.sport, venue.cancelCutoffHours),
      timeZone: venue.timeZone,
      lateCancelKeep: (await cancelPolicyFor(venue.id, booking.sport)).lateKeep,
      strikeLimit: (await cancelPolicy(venue.id)).strikeLimit,
      // As far as it can be moved: the venue's window, a member's where this number is one.
      lastDate: addDays(todayISO(venue.timeZone), await windowFor(venue.id, [booking.phone])),
    },
    payOnline: await takesPaymentOnline(venue.id),
    // On an unmanned resource: whether the door code or the counter lets them in, by the booking's whole time.
    door: court.unmanned ? doorFor(venue, Math.round(booking.startHour * 60), Math.round(booking.endHour * 60)) : null,
    // A deposit to hold it, while it is held and none is paid yet.
    depositPercent:
      booking.holdUntil && (booking.depositPaid ?? 0) === 0 && !(await struckOut(venue.id, booking.phone)).out
        ? (await holdPolicy(venue.id)).depositPercent
        : null,
    addons: (await addonsFor([booking.id])).get(booking.id) ?? [],
    // Its receipt (a tax invoice where the venue charges SST or GST), once paid.
    receiptUrl: booking.paymentStatus === "paid" && booking.totalPrice > 0 ? receiptPath(booking.code) : null,
    // Once played: where to rate the visit.
    reviewUrl: (await reviewable(booking.code)).ok ? reviewPath(booking.code) : null,
    // Paid online and owed back, or refunded: by when, as the venue promised.
    refunds: await refundStatusFor([booking.id]),
    // A dearer coach's difference on a paid lesson: owed (to pay online where the venue takes it, or at the counter),
    // being paid, or paid and how, with its own receipt (lib/lesson-coaches.ts).
    coachDifferences: booking.coachId
      ? (await coachDifferences({ bookingId: booking.id }))
          .filter((d) => d.state !== "cleared")
          .map((d) => ({ changeId: d.changeId, amount: d.amount, coach: d.toCoach, state: d.state, via: d.via, receiptUrl: d.receipt ? receiptPath(d.receipt) : null }))
      : [],
  });
}
