import { logAction } from "./activity";
import { readMinute } from "./api";
import { contactRefusal } from "./contact-fields";
import { membersOnlyRefusal } from "./entitlements";
import { isLocale } from "./i18n";
import { formatMinute, isMinute } from "./interval";
import { policyCheck, saidOn } from "./limits";
import { isRefusal } from "./participants";
import { readSelection, selectionAtVenue, type Selection } from "./participant-bookings";
import { getClass, getCourt, joinClassWaitlist, joinSlotWaitlist, removeVenueWaitlistEntry, type WaitlistMaker } from "./store";
import { isValidDateString } from "./time";
import type { WaitlistEntry } from "./types";
import { waiverSignedFor } from "./waivers";
import { classRefusal } from "./who";

/**
 * The waiting list at the counter and through the venue's API key
 * (docs/features/booking.md#at-the-counter-and-through-the-api): the venue
 * queues somebody who rang or walked up, on its word for their name and
 * number, as its counter books them. The same rules as joining online
 * (app/api/waitlist): the venue's policies (lib/limits.ts `policyCheck`, on
 * the counter's or the API's path: who may be booked here, a refused number,
 * the house rules, the unpaid-bookings limit), a members' place each
 * participant's own (lib/entitlements.ts), a
 * women-only or men-only class said for, the court's booking rules and
 * sign-offs, and nobody queued twice (lib/store.ts). Participants are only
 * those the venue knows with a live guardian on the entry's number
 * (lib/participant-bookings.ts `selectionAtVenue`), checked again when the
 * place is offered and when it is claimed. The offer goes to that number and
 * email by the usual channels (lib/notify.ts `notifyPendingOffers`).
 *
 * Both callers are the venue: its staff (the desk or a manager, at a venue
 * they work at) or its own system through a write key. Neither reaches
 * another venue's courts, classes, entries or participants.
 */

export type VenueJoinResult =
  | { ok: true; entry: WaitlistEntry; position: number }
  | { ok: false; error: string; code?: string; vars?: Record<string, string | number>; status: number };

const bad = (error: string, status = 400, code?: string, vars?: Record<string, string | number>): Extract<VenueJoinResult, { ok: false }> => ({
  ok: false,
  error,
  status,
  ...(code ? { code } : {}),
  ...(vars ? { vars } : {}),
});

/** Who did it, for the activity log: the member of staff, or the key by its number. */
const actorOf = (maker: WaitlistMaker) => ({ id: maker.channel === "staff" ? maker.adminId : null, name: maker.name });
const how = (maker: WaitlistMaker) => (maker.channel === "staff" ? "at the counter" : "through the API");

/**
 * Queue somebody for court or facility time (`courtId`, `date`, `start`,
 * `end`) or a class place (`classId`) at `venueId`, as `maker`.
 * `participantIds` and `customerTakesPart` as a counter booking takes them;
 * `confirmWho` where a class is for women or men only and staff say the
 * person is; `locale` the language the offer is sent in (English if not said).
 */
export async function joinAtVenue(
  venueId: number,
  maker: WaitlistMaker,
  body: Record<string, unknown>,
  opts: { preview?: boolean } = {}
): Promise<VenueJoinResult> {
  const { classId, courtId, date, name, phone, email, confirmWho, locale } = body;
  const forClass = classId !== undefined && classId !== null;
  const start = readMinute(body, "start");
  const end = readMinute(body, "end");
  if (forClass) {
    if (!Number.isInteger(classId) || (classId as number) <= 0) return bad("classId is required.");
  } else {
    if (!Number.isInteger(courtId) || (courtId as number) <= 0) return bad("classId or courtId is required.");
    if (typeof date !== "string" || !isValidDateString(date)) return bad("Invalid date. Use YYYY-MM-DD.");
    if (!isMinute(start) || !isMinute(end) || end <= start) return bad("start and end must be minutes of the day or HH:MM, the end after the start.");
  }
  if (typeof name !== "string" || name.trim().length < 2) return bad("Please provide your name.");
  if (typeof phone !== "string" || !/^\+?[0-9 -]{7,20}$/.test(phone.trim())) return bad("Please provide a valid phone number.");
  if (email !== undefined && email !== null && email !== "" && (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)))
    return bad("Please provide a valid email address.");
  // Each bounded, as every path that books keeps them (lib/contact-fields.ts).
  const unkept = contactRefusal({ name, email });
  if (unkept) return bad(unkept.error, 400, unkept.code, unkept.vars);
  if (locale !== undefined && locale !== null && (typeof locale !== "string" || !isLocale(locale))) return bad("locale must be en, ms, zh or ta.");
  if (confirmWho !== undefined && confirmWho !== null && typeof confirmWho !== "boolean") return bad("confirmWho must be true or false.");

  // The class or the court, at this venue: another venue's is not there at all.
  const session = forClass ? await getClass(classId as number) : null;
  const court = forClass ? (session ? await getCourt(session.courtId) : null) : await getCourt(courtId as number);
  if (forClass ? !session || session.venueId !== venueId : !court || court.venueId !== venueId)
    return bad(forClass ? "That class is not at this venue." : "That court is not at this venue.", 404);
  const day = forClass ? session!.date : (date as string);

  // Who for: participants this venue knows, each with a live guardian on this number, as a counter booking.
  const asked = readSelection(body);
  if (asked && isRefusal(asked)) return bad(asked.error, asked.status, asked.code, asked.vars);
  let people: Selection | undefined;
  if (asked) {
    const resolved = await selectionAtVenue(venueId, phone.trim(), asked.ids, asked.customerTakesPart);
    if (isRefusal(resolved)) return bad(resolved.error, resolved.status, resolved.code, resolved.vars);
    people = resolved;
  }
  const named = people?.participants ?? [];
  // The venue's system cannot give a guardian's agreement to the waiver, as for a booking through the API.
  if (maker.channel === "api")
    for (const p of named)
      if (!(await waiverSignedFor(venueId, p.id))) return bad(`${p.name}'s guardian has not agreed to the venue's waiver for them.`, 409, "WAIVER_NEEDED");

  // A women-only or men-only class: staff (or the venue's system) say so for whoever it is.
  if (session) {
    const notFor = await classRefusal(session.who, null, confirmWho === true);
    if (notFor) return bad(notFor.error, 403, notFor.code, notFor.vars);
  }

  // Whoever could not book it cannot queue for it either: the venue's policies on the path the entry is made
  // (lib/limits.ts `policyCheck`): who may be booked at a members-only or private venue (the number, or each
  // person named), a refused number, a venue not open, the house rules, too many unpaid bookings. The place is
  // claimed later through the offer's link, so it is paid as a claim is: no-show strikes and the guest limit
  // refuse only where the claimed court time could not be held until paid online (a class place never is).
  const takesPart = !people || people.customerTakesPart;
  const refused = (
    await policyCheck(maker.channel, {
      venueId,
      phone: phone.trim(),
      dates: [day],
      ...(opts.preview ? { preview: true } : {}),
      settle: "online",
      ...(forClass ? { canPayOnline: false } : {}),
      participants: named,
      customerTakesPart: takesPart,
      placesForOthers: !takesPart && named.length > 0 && (forClass || (court?.capacity ?? 1) > 1),
    })
  ).refusal;
  if (refused) {
    // Said for staff or the venue's system; paying as it is booked is no answer for a queue, so those two as the customer is told.
    const said = refused.code === "STRIKES_COUNTER" || refused.code === "GUEST_SURGE" ? refused : saidOn(maker.channel, refused);
    return bad(said.error, 403, said.code, said.vars);
  }
  // Nobody waits for a members' place they could not take on its date: each participant's own, and the
  // customer's where they take one, by the number staff or the venue's system give (lib/entitlements.ts).
  const notMember = await membersOnlyRefusal({
    venueId,
    court: { capacity: court?.capacity ?? 1 },
    classId: forClass ? (classId as number) : null,
    participants: named,
    customer: takesPart ? { phone: phone.trim(), userId: null, by: maker.channel } : null,
    dates: [day],
  });
  if (notMember) return bad(notMember.error, 403, notMember.code, notMember.vars);

  const person = {
    name: name.trim(),
    phone: phone.trim(),
    email: typeof email === "string" && email !== "" ? email.trim() : undefined,
    locale: typeof locale === "string" ? locale : "en",
    madeBy: maker,
    ...(people ? { people } : {}),
  };
  const result = forClass
    ? await joinClassWaitlist({ classId: classId as number, ...person })
    : await joinSlotWaitlist({ courtId: courtId as number, date: date as string, start, end, ...person });
  if (!result.ok) return bad(result.error, result.code === "BUSY" ? 503 : 409, result.code, result.vars);

  const what = forClass ? `${session!.name} · ${session!.date}` : `${court!.name} · ${date as string} ${formatMinute(start)}–${formatMinute(end)}`;
  await logAction(actorOf(maker), {
    venueId,
    action: "waitlist.added",
    detail: `Put ${person.name}${named.length > 0 ? ` (for ${named.map((p) => `${p.name}, participant ${p.id}`).join("; ")})` : ""} on the waiting list for ${what} ${how(maker)}: entry ${result.entry.id}, number ${result.position} in the queue`,
  });
  return { ok: true, entry: result.entry, position: result.position };
}

/** Take an entry the venue made off its list, on the record. */
export async function removeAtVenue(
  venueId: number,
  maker: WaitlistMaker,
  entryId: unknown
): Promise<{ ok: true; entry: WaitlistEntry } | Extract<VenueJoinResult, { ok: false }>> {
  if (!Number.isInteger(entryId) || (entryId as number) <= 0) return bad("entryId is required.");
  const done = await removeVenueWaitlistEntry(entryId as number, venueId);
  if (!done.ok) return bad(done.error, done.code === "WAITLIST_NOT_FOUND" ? 404 : 409, done.code, done.vars);
  await logAction(actorOf(maker), {
    venueId,
    action: "waitlist.removed",
    detail: `Took ${done.entry.name}${done.entry.participantNames?.length ? ` (for ${done.entry.participantNames.join(", ")})` : ""} off the waiting list for ${done.entry.label ?? `entry ${done.entry.id}`} ${how(maker)}: entry ${done.entry.id}`,
  });
  return { ok: true, entry: done.entry };
}
