import { isActivity } from "@/lib/activities";
import { NextRequest, NextResponse } from "next/server";
import { offered } from "@/lib/addons";
import { mayShowVenue } from "@/lib/listing";
import { getClass, getCourt } from "@/lib/store";
import { isValidDateString } from "@/lib/time";
import { isMinute, parseClock, type Span } from "@/lib/interval";
import { type Sport } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * What can be added to a booking: `?courtId=&date=&start=18:00&end=19:30`
 * (minutes of the day or HH:MM; `hours=18,19`, the older form, is read as
 * whole hours), or `?venueId=&sport=` in place of a court, or `?classId=`
 * for a class. Rentals say how many are left for that time.
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  let venueId: number;
  let sport: Sport;
  let date = q.get("date") ?? "";
  const minute = (v: string | null) => (v === null ? null : /^\d+$/.test(v) ? Number(v) : parseClock(v));
  const hours = (q.get("hours") ?? "")
    .split(",")
    .filter((h) => h !== "")
    .map(Number);
  let span: Span | null =
    q.get("start") !== null
      ? { start: minute(q.get("start")) ?? NaN, end: minute(q.get("end")) ?? NaN }
      : hours.length > 0
        ? { start: Math.round(Math.min(...hours) * 60), end: Math.round(Math.max(...hours) * 60) + 60 }
        : null;
  if (q.get("classId")) {
    const session = await getClass(Number(q.get("classId")));
    if (!session) return NextResponse.json({ addons: [] });
    venueId = session.venueId;
    sport = session.sport;
    date = session.date;
    span = { start: session.startMin, end: session.endMin };
  } else if (q.get("courtId")) {
    const court = await getCourt(Number(q.get("courtId")));
    if (!court) return NextResponse.json({ addons: [] });
    venueId = court.venueId;
    sport = court.sport;
  } else {
    venueId = Number(q.get("venueId"));
    sport = q.get("sport") as Sport;
    if (!Number.isInteger(venueId) || venueId <= 0 || !(await isActivity(sport)))
      return NextResponse.json({ error: "Give a courtId, a venueId and sport, or a classId." }, { status: 400 });
  }
  if (!isValidDateString(date)) return NextResponse.json({ error: "Invalid date. Use YYYY-MM-DD." }, { status: 400 });
  if (span && (!isMinute(span.start) || !isMinute(span.end) || span.end <= span.start))
    return NextResponse.json({ error: "start and end must be minutes of the day or HH:MM, end after start." }, { status: 400 });
  if (!(await mayShowVenue(venueId, req)).show) return NextResponse.json({ addons: [] });
  const list = await offered(venueId, sport, date, span);
  return NextResponse.json({
    addons: list.map((a) => ({ id: a.id, name: a.name, kind: a.kind, price: a.price, left: a.left ?? null })),
  });
}
