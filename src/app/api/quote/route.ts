import { isActivity } from "@/lib/activities";
import { NextRequest, NextResponse } from "next/server";
import { readTime, refusal } from "@/lib/api";
import { getSessionUser } from "@/lib/auth";
import { mayShowVenue } from "@/lib/listing";
import { rateLimit } from "@/lib/rate-limit";
import { courtsForAnyBooking, getCourt, quoteFor } from "@/lib/store";
import { MAX_GROUP_COURTS, type Sport } from "@/lib/types";
import { isValidDateString } from "@/lib/time";
import { MAX_NAMED, selectionForAccount } from "@/lib/participant-bookings";
import { isRefusal } from "@/lib/participants";
import { memberCover, renewPath, takesPlaces, type MemberLapse } from "@/lib/entitlements";

export const dynamic = "force-dynamic";

/**
 * `?courtId&date&start&end` (or `minutes` for `end`; minutes of the day or
 * HH:MM) `[&players][&also=2,3]` → what that booking would cost now, before
 * it is made. `venueId&sport` in place of `courtId` prices the court a
 * booking on any court would get: the cheapest free for that time. `also`
 * prices other courts for the same time, to book with it (`others`). The answer:
 * `total`, the court time and any setup or cleanup `fees` apart, the minutes
 * billed, and each part's rate (`lines`). Member rates for a signed-in
 * member, unless `forOthers=1`: a booking only for people the member books
 * for is at the public rate (docs/features/pricing.md#memberships-and-member-rates).
 * `participantIds=1,2[&customerTakesPart=1]` (people the signed-in account
 * acts for) prices it as the booking naming them will be: each person's own
 * membership, or a family one naming them, by the scope of its benefit.
 * `allowed` says whether the court's booking rules take that time;
 * when not, `error` says why. Whether it is free is found by booking it.
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const date = q.get("date") ?? "";
  if (!isValidDateString(date)) return NextResponse.json({ error: "Invalid date. Use YYYY-MM-DD." }, { status: 400 });
  const raw = Object.fromEntries(
    (["start", "end", "minutes"] as const)
      .filter((k) => q.get(k) !== null)
      .map((k) => [k, /^\d+$/.test(q.get(k)!) ? Number(q.get(k)) : q.get(k)])
  );
  const time = readTime(raw);
  if (!time.ok || time.when.start === undefined) return NextResponse.json({ error: "Give start, and end or minutes." }, { status: 400 });
  const limited = await rateLimit(req, "quote");
  if (limited) return limited;

  // The court named, or the one "any court" would be given.
  let courtId = Number(q.get("courtId"));
  if (q.get("courtId") === null) {
    const venueId = Number(q.get("venueId"));
    const sport = q.get("sport") as Sport;
    if (!Number.isInteger(venueId) || venueId <= 0 || !(await isActivity(sport)))
      return NextResponse.json({ error: "Give a courtId, or a venueId and sport." }, { status: 400 });
    if (!(await mayShowVenue(venueId, req)).show) return NextResponse.json({ error: "Venue not found." }, { status: 404 });
    const free = await courtsForAnyBooking({ venueId, sport, date, ...time.when });
    if (free.length === 0) return refusal({ ok: false, error: "No court is free for that whole time. Please pick another time.", code: "NO_COURT_FREE" });
    courtId = free[0].id;
  }
  if (!Number.isInteger(courtId) || courtId <= 0) return NextResponse.json({ error: "courtId is required." }, { status: 400 });
  const court = await getCourt(courtId);
  if (!court || !(await mayShowVenue(court.venueId, req)).show) return NextResponse.json({ error: "Court not found." }, { status: 404 });
  const user = await getSessionUser(req);
  const players = q.get("players") !== null ? Number(q.get("players")) : undefined;
  // On a court that offers several activities, which one (its main one if not said).
  const activity = q.get("sport") ? (q.get("sport") as Sport) : undefined;
  // A membership prices only a booking its holder takes part in.
  const memberPhone = q.get("forOthers") === "1" ? null : (user?.phone ?? null);
  // The people the booking would name, from those this account acts for: priced as the booking will be,
  // each membership by its scope (a member's own place at the member's price; lib/entitlements.ts).
  const ids = (q.get("participantIds") ?? "").split(",").filter((s) => /^\d+$/.test(s)).map(Number);
  const customerTakesPart = q.get("customerTakesPart") === "1";
  const chosen = user && ids.length > 0 ? await selectionForAccount(user.id, ids.slice(0, MAX_NAMED), customerTakesPart) : null;
  if (chosen && isRefusal(chosen)) return NextResponse.json({ error: chosen.error, code: chosen.code }, { status: chosen.status });
  const people = chosen ? { participants: chosen.participants, customerTakesPart: chosen.customerTakesPart } : undefined;
  const priced = await quoteFor({
    courtId,
    date,
    ...time.when,
    phone: people ? (user?.phone ?? null) : memberPhone,
    userId: user?.id ?? null,
    by: "customer",
    players,
    ...(activity ? { sport: activity } : {}),
    ...(people ? { people } : {}),
  });
  if (!priced.ok) return refusal(priced, 400);

  // Other courts at the same venue, for the same time.
  // Each `id`, or `id:places` for that many places on a shared resource (a kind of kit of its own).
  const also = (q.get("also") ?? "")
    .split(",")
    .map((item) => item.split(":").map(Number))
    .filter(([id, n]) => Number.isInteger(id) && id > 0 && id !== courtId && (n === undefined || (Number.isInteger(n) && n > 0)))
    .slice(0, MAX_GROUP_COURTS);
  const others: { courtId: number; total: number; allowed: boolean }[] = [];
  for (const [id, places] of also) {
    const other = await getCourt(id);
    if (!other || other.venueId !== court.venueId) continue;
    const quote = await quoteFor({
      courtId: id,
      date,
      start: priced.span.start,
      end: priced.span.end,
      phone: memberPhone,
      userId: user?.id ?? null,
      by: "customer",
      players: places ?? players,
      ...(activity ? { sport: activity } : {}),
    });
    if (quote.ok) others.push({ courtId: id, total: quote.quote.total, allowed: quote.allowed });
  }

  // A place on a members' session (a members-only venue's shared session): whether each person taking
  // one is covered on this date, not today, with why not and where to renew (lib/entitlements.ts).
  // The booking asks the same; this says it before booking.
  let members: { participantId: number | null; name: string; covered: boolean; lapse?: MemberLapse; renew: string }[] | undefined;
  if (user && takesPlaces(court)) {
    const { accessSettings } = await import("@/lib/access");
    if ((await accessSettings(court.venueId)).access === "members") {
      const persons = [
        ...(!people || people.customerTakesPart ? [{ participantId: null, name: user.name }] : []),
        ...(people?.participants ?? []).map((p) => ({ participantId: p.id as number | null, name: p.name })),
      ];
      members = [];
      for (const who of persons) {
        const cover = await memberCover(court.venueId, who, who.participantId === null ? { phone: user.phone, userId: user.id, by: "customer" } : null, date);
        members.push({
          participantId: who.participantId,
          name: who.name,
          covered: cover.covered,
          ...(cover.lapse ? { lapse: cover.lapse } : {}),
          renew: cover.covered ? "" : await renewPath(court.venueId, who.participantId !== null),
        });
      }
    }
  }

  return NextResponse.json({
    ...(members ? { members } : {}),
    courtId,
    date,
    start: priced.span.start,
    end: priced.span.end,
    total: priced.quote.total,
    court: priced.quote.court,
    fees: priced.quote.fees,
    billedMinutes: priced.quote.billedMinutes,
    lines: priced.quote.lines,
    allowed: priced.allowed,
    ...(priced.allowed ? {} : { error: priced.refusal.error, code: priced.refusal.code, vars: priced.refusal.vars }),
    others,
  });
}
