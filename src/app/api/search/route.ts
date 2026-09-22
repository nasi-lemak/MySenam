import { NextRequest, NextResponse } from "next/server";
import { listAreas, searchAvailability } from "@/lib/store";
import { isValidDateString, todayISO } from "@/lib/time";
import { CLOSE_HOUR, MAX_HOURS_PER_BOOKING, OPEN_HOUR, Sport, SPORTS } from "@/lib/types";

export const dynamic = "force-dynamic";

function parseHour(value: string | null, fallback: number): number | null {
  if (value === null || value === "") return fallback;
  const hour = Number(value);
  if (!Number.isInteger(hour) || hour < OPEN_HOUR || hour > CLOSE_HOUR) return null;
  return hour;
}

export function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const sport = params.get("sport");
  const date = params.get("date") ?? todayISO();

  if (!sport || !SPORTS.includes(sport as Sport))
    return NextResponse.json({ error: "A valid sport is required." }, { status: 400 });
  if (!isValidDateString(date))
    return NextResponse.json({ error: "Invalid date. Use YYYY-MM-DD." }, { status: 400 });

  const fromHour = parseHour(params.get("from"), OPEN_HOUR);
  const toHour = parseHour(params.get("to"), CLOSE_HOUR);
  if (fromHour === null || toHour === null)
    return NextResponse.json(
      { error: `Hours must be between ${OPEN_HOUR} and ${CLOSE_HOUR}.` },
      { status: 400 }
    );
  if (fromHour > toHour)
    return NextResponse.json({ error: "'from' must not be after 'to'." }, { status: 400 });

  const durationParam = params.get("duration");
  const duration = durationParam ? Number(durationParam) : 1;
  if (!Number.isInteger(duration) || duration < 1 || duration > MAX_HOURS_PER_BOOKING)
    return NextResponse.json(
      { error: `Duration must be 1–${MAX_HOURS_PER_BOOKING} hours.` },
      { status: 400 }
    );

  const results = searchAvailability({
    sport: sport as Sport,
    date,
    fromHour,
    toHour,
    duration,
    area: params.get("area") ?? undefined,
  });

  return NextResponse.json({ date, sport, duration, results, areas: listAreas() });
}
