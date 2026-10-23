import { NextRequest, NextResponse } from "next/server";
import { coachById, lessonStarts } from "@/lib/coaching";
import { aheadFor } from "@/lib/house-rules";
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
 */
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const coach = await coachById(Number(p.get("coachId")));
  const date = p.get("date") ?? "";
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
