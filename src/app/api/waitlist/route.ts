import { NextRequest, NextResponse } from "next/server";
import { classRefusal } from "@/lib/who";
import { refusal } from "@/lib/api";
import { getSessionUser } from "@/lib/auth";
import { isBlocked, phoneBlocked, venueNotOpen } from "@/lib/limits";
import { venueIsOpen } from "@/lib/listing";
import { accessRefusal } from "@/lib/access";
import { rateLimit } from "@/lib/rate-limit";
import { getClass, getCourt, joinClassWaitlist, joinSlotWaitlist, leaveWaitlist } from "@/lib/store";
import { isValidDateString } from "@/lib/time";
import { currentLocale } from "@/lib/locale";

export const dynamic = "force-dynamic";

/** Queue for a class that is full. */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { classId, courtId, date, startHour, endHour, name, phone, email, confirmWho } = (body ??
    {}) as Record<string, unknown>;

  const forClass = classId !== undefined && classId !== null;
  if (forClass) {
    if (!Number.isInteger(classId) || (classId as number) <= 0)
      return NextResponse.json({ error: "classId is required." }, { status: 400 });
  } else {
    if (!Number.isInteger(courtId) || (courtId as number) <= 0)
      return NextResponse.json({ error: "classId or courtId is required." }, { status: 400 });
    if (typeof date !== "string" || !isValidDateString(date))
      return NextResponse.json({ error: "Invalid date. Use YYYY-MM-DD." }, { status: 400 });
    if (!Number.isInteger(startHour) || !Number.isInteger(endHour))
      return NextResponse.json(
        { error: "startHour and endHour must be whole hours." },
        { status: 400 }
      );
  }
  if (typeof name !== "string" || name.trim().length < 2)
    return NextResponse.json({ error: "Please provide your name." }, { status: 400 });
  if (typeof phone !== "string" || !/^\+?[0-9 -]{7,20}$/.test(phone.trim()))
    return NextResponse.json({ error: "Please provide a valid phone number." }, { status: 400 });

  const limited = rateLimit(req, "booking");
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

  // Nor does somebody a women-only or men-only class is not for.
  if (forClass) {
    const session = await getClass(classId as number);
    const notFor = session ? await classRefusal(session.who, user?.id ?? null, confirmWho === true) : null;
    if (notFor) return refusal(notFor, 403);
  }

  // A number the venue has refused does not queue for it either.
  const venueId = forClass
    ? (await getClass(classId as number))?.venueId
    : (await getCourt(courtId as number))?.venueId;
  if (venueId !== undefined && (await isBlocked(venueId, person.phone)))
    return refusal(phoneBlocked());
  if (venueId !== undefined && !(await venueIsOpen(venueId))) return refusal(venueNotOpen());
  // Members only, or private: nobody else queues for it either.
  if (venueId !== undefined) {
    const notHere = await accessRefusal(venueId, user?.id ?? null);
    if (notHere) return refusal(notHere, 403);
  }

  const result = forClass
    ? await joinClassWaitlist({ classId: classId as number, ...person })
    : await joinSlotWaitlist({
        courtId: courtId as number,
        date: date as string,
        startHour: startHour as number,
        endHour: endHour as number,
        ...person,
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

  const limited = rateLimit(req, "bookingLookup");
  if (limited) return limited;

  const result = await leaveWaitlist(entryId as number, phone);
  if (!result.ok) return refusal(result);
  return NextResponse.json({ ok: true });
}
