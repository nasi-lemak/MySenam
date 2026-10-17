import { NextRequest, NextResponse } from "next/server";
import { countSearchCourts, listAreas, readNear, SEARCH_COURT_LIMIT, searchAvailability } from "@/lib/store";
import { storefrontForRequest } from "@/lib/storefront";
import { isValidDateString, todayISO } from "@/lib/time";
import { CLOSE_HOUR, MAX_HOURS_PER_BOOKING, OPEN_HOUR, Sport, SPORTS } from "@/lib/types";

export const dynamic = "force-dynamic";

function parseHour(value: string | null, fallback: number): number | null {
  if (value === null || value === "") return fallback;
  const hour = Number(value);
  if (!Number.isInteger(hour) || hour < OPEN_HOUR || hour > CLOSE_HOUR) return null;
  return hour;
}

export async function GET(req: NextRequest) {
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

  // On a storefront, only its venues.
  const venueIds = (await storefrontForRequest(req))?.venueIds;
  // Near a point (`near=lat,lng&km=10`) is a where of its own, instead of an area.
  const near = readNear(params.get("near"), params.get("km")) ?? undefined;
  if (params.get("near") && !near)
    return NextResponse.json({ error: "That location is not in Malaysia." }, { status: 400 });
  const area = near ? undefined : params.get("area") || undefined;
  const areas = await listAreas(venueIds);

  // Across a whole marketplace, every free hour on every court in the
  // country is too much to work out for one page of results — and a court
  // three states away is no use to whoever is asking. Ask where first.
  if (!area && (await countSearchCourts({ sport: sport as Sport, venueIds, near })) > SEARCH_COURT_LIMIT)
    return NextResponse.json({ date, sport, duration, results: [], areas, needsArea: true });

  const results = await searchAvailability({
    sport: sport as Sport,
    date,
    fromHour,
    toHour,
    duration,
    area,
    venueIds,
    near,
  });

  return NextResponse.json({ date, sport, duration, results, areas, needsArea: false });
}
