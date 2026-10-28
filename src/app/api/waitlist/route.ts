import { NextRequest, NextResponse } from "next/server";
import { classRefusal } from "@/lib/who";
import { readMinute, refusal } from "@/lib/api";
import { getSessionUser } from "@/lib/auth";
import { customerMayBook } from "@/lib/limits";
import { membersOnlyRefusal } from "@/lib/entitlements";
import { takesPaymentOnline } from "@/lib/payments";
import { rateLimit } from "@/lib/rate-limit";
import { getClass, getCourt, joinClassWaitlist, joinSlotWaitlist, leaveWaitlist } from "@/lib/store";
import { isValidDateString } from "@/lib/time";
import { isMinute } from "@/lib/interval";
import { currentLocale } from "@/lib/locale";
import { isRefusal } from "@/lib/participants";
import { readSelection, selectionForAccount, type Selection } from "@/lib/participant-bookings";

export const dynamic = "force-dynamic";

/** Queue for a class that is full. */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { classId, courtId, date, name, phone, email, confirmWho } = (body ?? {}) as Record<string, unknown>;
  // The time wanted: start and end in minutes of the day or HH:MM (startHour and endHour, the older form).
  const start = readMinute((body ?? {}) as Record<string, unknown>, "start", "startHour");
  const end = readMinute((body ?? {}) as Record<string, unknown>, "end", "endHour");

  const forClass = classId !== undefined && classId !== null;
  if (forClass) {
    if (!Number.isInteger(classId) || (classId as number) <= 0)
      return NextResponse.json({ error: "classId is required." }, { status: 400 });
  } else {
    if (!Number.isInteger(courtId) || (courtId as number) <= 0)
      return NextResponse.json({ error: "classId or courtId is required." }, { status: 400 });
    if (typeof date !== "string" || !isValidDateString(date))
      return NextResponse.json({ error: "Invalid date. Use YYYY-MM-DD." }, { status: 400 });
    if (!isMinute(start) || !isMinute(end) || end <= start)
      return NextResponse.json({ error: "start and end must be minutes of the day or HH:MM, the end after the start." }, { status: 400 });
  }
  if (typeof name !== "string" || name.trim().length < 2)
    return NextResponse.json({ error: "Please provide your name." }, { status: 400 });
  if (typeof phone !== "string" || !/^\+?[0-9 -]{7,20}$/.test(phone.trim()))
    return NextResponse.json({ error: "Please provide a valid phone number." }, { status: 400 });

  const limited = await rateLimit(req, "booking");
  if (limited) return limited;

  const user = await getSessionUser(req);
  const person = {
    name: name.trim(),
    phone: phone.trim(),
    email: typeof email === "string" && email !== "" ? email.trim() : undefined,
    userId: user?.id,
    // The offer arrives when somebody else cancels, so the language has to be
    // remembered now rather than read off that request.
    locale: await currentLocale(),
  };

  // Who the entry is for (lib/participant-bookings.ts): the customer, and
  // people this account acts for. The entry keeps them, and waits for a
  // place for each; the offer is booked for them, never the customer instead.
  const asked = readSelection((body ?? {}) as Record<string, unknown>);
  if (asked && isRefusal(asked)) return NextResponse.json({ error: asked.error, code: asked.code, ...(asked.vars ? { vars: asked.vars } : {}) }, { status: asked.status });
  let people: Selection | undefined;
  if (asked) {
    const resolved = user ? await selectionForAccount(user.id, asked.ids, asked.customerTakesPart) : null;
    if (!resolved) return NextResponse.json({ error: "Not one of the people you manage.", code: "GUARD_NOT_FOUND" }, { status: 404 });
    if (isRefusal(resolved)) return NextResponse.json({ error: resolved.error, code: resolved.code }, { status: resolved.status });
    people = resolved;
  }

  // Nor does somebody a women-only or men-only class is not for.
  if (forClass) {
    const session = await getClass(classId as number);
    const forSelf = !people || people.customerTakesPart;
    const notFor = session && forSelf ? await classRefusal(session.who, user?.id ?? null, confirmWho === true) : null;
    if (notFor) return refusal(notFor, 403);
    // For somebody else, the adult says so on their behalf.
    const notForThem = session && people && people.participants.length > 0 ? await classRefusal(session.who, null, confirmWho === true) : null;
    if (notForThem) return refusal(notForThem, 403);
  }

  // Whoever could not book it cannot queue for it either: a refused number, a
  // venue not open, members only, the house rules, too many unpaid bookings.
  const session = forClass ? await getClass(classId as number) : null;
  const venueId = forClass ? session?.venueId : (await getCourt(courtId as number))?.venueId;
  if (venueId !== undefined) {
    const refused = await customerMayBook({
      venueId,
      phone: person.phone,
      signedIn: user !== null,
      userId: user?.id ?? null,
      dates: [forClass ? session!.date : (date as string)],
      // A class place is never held until paid, so it asks what enrolling asks; court time can be held (lib/limits.ts).
      canPayOnline: forClass ? false : await takesPaymentOnline(venueId),
      // Waiting for places only for people the account books for, on a class or a shared session:
      // each must be a member themself, checked when the place is offered and taken (lib/entitlements.ts).
      placesForOthers:
        !!people && !people.customerTakesPart && people.participants.length > 0 && (forClass || ((await getCourt(courtId as number))?.capacity ?? 1) > 1),
    });
    if (refused) return refusal(refused, 403);
    // Nobody waits for a members' place they could not take on its date (lib/entitlements.ts): the same
    // check the booking makes, for each person named and the customer where they take a place.
    const court = forClass ? null : await getCourt(courtId as number);
    const notMember = await membersOnlyRefusal({
      venueId,
      court: { capacity: court?.capacity ?? 1 },
      classId: forClass ? (classId as number) : null,
      participants: people?.participants ?? [],
      customer: !people || people.customerTakesPart ? { phone: person.phone, userId: user?.id ?? null, by: "customer" } : null,
      dates: [forClass ? session!.date : (date as string)],
    });
    if (notMember) return refusal(notMember, 403);
  }

  const result = forClass
    ? await joinClassWaitlist({ classId: classId as number, ...person, ...(people ? { people } : {}) })
    : await joinSlotWaitlist({
        courtId: courtId as number,
        date: date as string,
        start,
        end,
        ...person,
        ...(people ? { people } : {}),
      });
  if (!result.ok) return refusal(result);

  return NextResponse.json(
    {
      entry: result.entry,
      position: result.position,
      session: forClass ? await getClass(classId as number) : null,
    },
    { status: 201 }
  );
}

/** Give up a place in the queue. */
export async function DELETE(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { entryId, phone } = (body ?? {}) as Record<string, unknown>;
  if (!Number.isInteger(entryId) || typeof phone !== "string")
    return NextResponse.json({ error: "entryId and phone are required." }, { status: 400 });

  const limited = await rateLimit(req, "bookingLookup");
  if (limited) return limited;

  const result = await leaveWaitlist(entryId as number, phone);
  if (!result.ok) return refusal(result);
  return NextResponse.json({ ok: true });
}
