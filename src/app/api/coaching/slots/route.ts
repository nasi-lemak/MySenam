import { NextRequest, NextResponse } from "next/server";
import { coachById, lessonSlots } from "@/lib/coaching";
import { aheadFor } from "@/lib/house-rules";
import { mayShowVenue } from "@/lib/listing";
import { getSessionUser } from "@/lib/auth";
import { getAvailability, getVenueClosure, venueHours } from "@/lib/store";
import { shows, storefrontForRequest } from "@/lib/storefront";
import { addDays, isValidDateString, todayISO } from "@/lib/time";
import type { Sport } from "@/lib/types";

export const dynamic = "force-dynamic";

/** `?coachId&date&sport?` → the slots a lesson with that coach can start in that day. */
export async function GET(req: NextRequest) {
  const p = req.nextUrl.searchParams;
  const coach = await coachById(Number(p.get("coachId")));
  const date = p.get("date") ?? "";
  if (!coach || !coach.active || !shows(await storefrontForRequest(req), coach.venueId) || !(await mayShowVenue(coach.venueId, req)).show)
    return NextResponse.json({ error: "Coach not found." }, { status: 404 });
  if (!isValidDateString(date)) return NextResponse.json({ error: "Invalid date. Use YYYY-MM-DD." }, { status: 400 });
  const sport = (coach.sports.find((s) => s === p.get("sport")) ?? coach.sports[0]) as Sport;
  // That day's hours, where its weekday has its own.
  const hours = await venueHours(coach.venueId, date);
  const user = await getSessionUser(req);
  const last = addDays(todayISO(hours.zone), await aheadFor(coach.venueId, user?.id ?? null));
  if (date > last || (await getVenueClosure(coach.venueId, date))) return NextResponse.json({ date, sport, slots: [], step: hours.step });
  const courts = await getAvailability(coach.venueId, date, sport);
  const freeCourtAt = (hour: number) => courts.some((c) => c.slots.some((s) => s.hour === hour && s.available));
  return NextResponse.json({ date, sport, step: hours.step, slots: await lessonSlots(coach, date, freeCourtAt, hours) });
}
