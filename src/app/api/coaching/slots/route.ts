import { NextRequest, NextResponse } from "next/server";
import { coachById, lessonStarts } from "@/lib/coaching";
import { aheadFor } from "@/lib/house-rules";
import { coachChoice, lessonRates, lessonSports, venueLessonStarts } from "@/lib/lesson-coaches";
import { mayShowVenue } from "@/lib/listing";
import { getSessionUser } from "@/lib/auth";
import { getVenueClosure, policyForSport, venueHours } from "@/lib/store";
import { shows, storefrontForRequest } from "@/lib/storefront";
import { addDays, isValidDateString, todayISO } from "@/lib/time";
import type { Sport } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * `?coachId&date&sport?` → where a lesson with that coach can start that day
 * (`starts`: minute of the day and the longest it may run from there), and
 * what the sport's courts allow (`policy`): lengths, step and default.
 *
 * `?venueId&sport&date`, at a venue that assigns the coach
 * (lib/lesson-coaches.ts): where a lesson of the sport can start with
 * whichever of its coaches is free, and the range of their fees (`rates`).
 */
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const date = p.get("date") ?? "";
  if (!p.get("coachId") && p.get("venueId")) {
    const venueId = Number(p.get("venueId"));
    if (!Number.isInteger(venueId) || !shows(await storefrontForRequest(req), venueId) || !(await mayShowVenue(venueId, req)).show || (await coachChoice(venueId)) !== "venue")
      return NextResponse.json({ error: "Coach not found." }, { status: 404 });
    if (!isValidDateString(date)) return NextResponse.json({ error: "Invalid date. Use YYYY-MM-DD." }, { status: 400 });
    const sports = await lessonSports(venueId);
    const sport = (sports.find((s) => s === p.get("sport")) ?? sports[0]) as Sport | undefined;
    if (!sport) return NextResponse.json({ error: "Coach not found." }, { status: 404 });
    const hours = await venueHours(venueId, date);
    const policy = await policyForSport(venueId, sport);
    const user = await getSessionUser(req);
    const last = addDays(todayISO(hours.zone), await aheadFor(venueId, user?.id ?? null));
    const rates = await lessonRates(venueId, sport);
    if (date > last || (await getVenueClosure(venueId, date))) return NextResponse.json({ date, sport, policy, rates, starts: [] });
    return NextResponse.json({ date, sport, policy, rates, starts: await venueLessonStarts(venueId, date, sport) });
  }
  const coach = await coachById(Number(p.get("coachId")));
  if (!coach || !coach.active || !shows(await storefrontForRequest(req), coach.venueId) || !(await mayShowVenue(coach.venueId, req)).show)
    return NextResponse.json({ error: "Coach not found." }, { status: 404 });
  if (!isValidDateString(date)) return NextResponse.json({ error: "Invalid date. Use YYYY-MM-DD." }, { status: 400 });
  const sport = (coach.sports.find((s) => s === p.get("sport")) ?? coach.sports[0]) as Sport;
  const hours = await venueHours(coach.venueId, date);
  const policy = await policyForSport(coach.venueId, sport);
  const user = await getSessionUser(req);
  const last = addDays(todayISO(hours.zone), await aheadFor(coach.venueId, user?.id ?? null));
  if (date > last || (await getVenueClosure(coach.venueId, date))) return NextResponse.json({ date, sport, policy, starts: [] });
  return NextResponse.json({ date, sport, policy, starts: await lessonStarts(coach, date, sport) });
}
