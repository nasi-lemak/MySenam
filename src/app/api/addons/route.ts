import { NextRequest, NextResponse } from "next/server";
import { offered } from "@/lib/addons";
import { mayShowVenue } from "@/lib/listing";
import { getClass, getCourt } from "@/lib/store";
import { isSlotHour, isValidDateString } from "@/lib/time";
import { SPORTS, type Sport } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * What can be added to a booking: `?courtId=&date=&hours=18,19`, or
 * `?venueId=&sport=` in place of a court, or `?classId=` for a class.
 * Rentals say how many are left for those hours.
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  let venueId: number;
  let sport: Sport;
  let date = q.get("date") ?? "";
  let hours = (q.get("hours") ?? "")
    .split(",")
    .filter((h) => h !== "")
    .map(Number);
  if (q.get("classId")) {
    const session = await getClass(Number(q.get("classId")));
    if (!session) return NextResponse.json({ addons: [] });
    venueId = session.venueId;
    sport = session.sport;
    date = session.date;
    hours = Array.from({ length: session.endHour - session.startHour }, (_, i) => session.startHour + i);
  } else if (q.get("courtId")) {
    const court = await getCourt(Number(q.get("courtId")));
    if (!court) return NextResponse.json({ addons: [] });
    venueId = court.venueId;
    sport = court.sport;
  } else {
    venueId = Number(q.get("venueId"));
    sport = q.get("sport") as Sport;
    if (!Number.isInteger(venueId) || venueId <= 0 || !SPORTS.includes(sport))
      return NextResponse.json({ error: "Give a courtId, a venueId and sport, or a classId." }, { status: 400 });
  }
  if (!isValidDateString(date)) return NextResponse.json({ error: "Invalid date. Use YYYY-MM-DD." }, { status: 400 });
  if (hours.length > 24 || !hours.every(isSlotHour))
    return NextResponse.json({ error: "hours must be a list of hours." }, { status: 400 });
  if (!(await mayShowVenue(venueId, req)).show) return NextResponse.json({ addons: [] });
  const list = await offered(venueId, sport, date, hours);
  return NextResponse.json({
    addons: list.map((a) => ({ id: a.id, name: a.name, kind: a.kind, price: a.price, left: a.left ?? null })),
  });
}
