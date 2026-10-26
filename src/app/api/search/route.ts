import { catalogue, isActivity } from "@/lib/activities";
import { findActivities } from "@/lib/activity-registry";
import { NextRequest, NextResponse } from "next/server";
import { countSearchCourts, listAreas, readNear, SEARCH_COURT_LIMIT, SEARCH_SORTS, searchAvailability, type SearchSort } from "@/lib/store";
import { storefrontForRequest } from "@/lib/storefront";
import { releaseExpiredHolds } from "@/lib/holds";
import { readFacilityFilters } from "@/lib/facilities";
import { coversFor } from "@/lib/photos";
import { isValidDateString, todayISO } from "@/lib/time";
import { MAX_COURT_HOURS, Sport } from "@/lib/types";
import { DAY_MINUTES, isMinute, parseClock } from "@/lib/interval";
import { region } from "@/lib/region";
import { getSessionUser } from "@/lib/auth";
import { readTaking } from "@/lib/eligibility";

export const dynamic = "force-dynamic";

/** A time of day from the query: HH:MM, or hours (18, 18.5). Null when it does not read. */
function parseTime(value: string | null, fallback: number): number | null {
  if (value === null || value === "") return fallback;
  const minute = value.includes(":") ? parseClock(value) : Number.isFinite(Number(value)) ? Math.round(Number(value) * 60) : null;
  return isMinute(minute) ? minute : null;
}

export async function GET(req: NextRequest) {
  await releaseExpiredHolds();
  const params = req.nextUrl.searchParams;
  // Who is taking part (`taking=self,12`), for a signed-in account only: the
  // answer is then that account's, so no shared cache may keep it or hand it to
  // anybody else (lib/eligibility.ts). Without `taking` the results are the
  // public ones, as for anybody.
  const asked = params.get("taking");
  const user = asked ? await getSessionUser(req) : null;
  const taking = user ? readTaking(asked, user.id) : null;
  const json = (body: unknown, init?: { status?: number }) =>
    asked !== null
      ? NextResponse.json(body, { ...init, headers: { "Cache-Control": "private, no-store", Vary: "Cookie" } })
      : NextResponse.json(body, init);
  // `sport=futsal`, or words for it: `q=takraw` finds sepak takraw, `q=spin` cycling.
  let sport = params.get("sport");
  if (!sport && params.get("q")) {
    await catalogue();
    sport = findActivities(params.get("q")!.slice(0, 60))[0] ?? null;
    if (!sport) return json({ error: "Nothing by that name is booked here." }, { status: 404 });
  }
  const date = params.get("date") ?? todayISO();

  if (!sport || !(await isActivity(sport)))
    return json({ error: "A valid sport is required." }, { status: 400 });
  if (!isValidDateString(date))
    return json({ error: "Invalid date. Use YYYY-MM-DD." }, { status: 400 });

  // The earliest and latest start wanted: `from=18:00&to=21:30` (or hours, `from=18`).
  const fromMin = parseTime(params.get("from"), 0);
  const toMin = parseTime(params.get("to"), DAY_MINUTES);
  if (fromMin === null || toMin === null)
    return json({ error: "from and to are times of day: HH:MM, or hours." }, { status: 400 });
  if (fromMin > toMin)
    return json({ error: "'from' must not be after 'to'." }, { status: 400 });

  // How long: `minutes=75`, or `duration` in hours (1.5). Each court's own
  // policy says whether it takes that length; those that do not are left out.
  const minutesParam = params.get("minutes");
  const durationParam = params.get("duration");
  const minutes = minutesParam ? Number(minutesParam) : durationParam ? Math.round(Number(durationParam) * 60) : 60;
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_COURT_HOURS * 60)
    return json({ error: `A booking is 1 minute to ${MAX_COURT_HOURS} hours long.` }, { status: 400 });
  const duration = minutes / 60;

  // On a storefront, only its venues.
  const venueIds = (await storefrontForRequest(req))?.venueIds;
  // Near a point (`near=lat,lng&km=10`) is a where of its own, instead of an area.
  const near = readNear(params.get("near"), params.get("km")) ?? undefined;
  if (params.get("near") && !near)
    return json({ error: `That location is not in ${region().name}.` }, { status: 400 });
  const area = near ? undefined : params.get("area") || undefined;
  const areas = await listAreas(venueIds);

  // Across a whole marketplace, every free hour on every court in the
  // country is too much to work out for one page of results — and a court
  // three states away is no use to whoever is asking. Ask where first.
  if (!area && (await countSearchCourts({ sport: sport as Sport, venueIds, near })) > SEARCH_COURT_LIMIT)
    return json({ date, sport, duration, minutes, results: [], areas, needsArea: true });

  // `sort=nearest` needs somewhere to be near; without it, soonest.
  const sortAsked = params.get("sort");
  const sort: SearchSort = SEARCH_SORTS.includes(sortAsked as SearchSort) && (sortAsked !== "nearest" || near) ? (sortAsked as SearchSort) : "soonest";

  const results = await searchAvailability({
    sort,
    // By venue, each venue's times come together: room for more than the first few.
    limit: sort === "soonest" ? undefined : 200,
    sport: sport as Sport,
    date,
    fromMin,
    toMin,
    minutes,
    area,
    venueIds,
    near,
    // Must have: `has=aircon,showers`.
    ...(() => {
      const wanted = readFacilityFilters(params.get("has"));
      return { amenities: wanted.amenities, courtFilters: wanted.courts };
    })(),
    ...(taking ? { taking } : {}),
  });

  // A thumbnail for each venue found that has one.
  const covers = Object.fromEntries(await coversFor([...new Set(results.map((r) => r.venue.id))]));
  return json({ date, sport, duration, minutes, sort, results, areas, covers, needsArea: false });
}
