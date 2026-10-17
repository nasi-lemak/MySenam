import { NextRequest, NextResponse } from "next/server";
import { listClasses } from "@/lib/store";
import { storefrontForRequest } from "@/lib/storefront";
import { addDays, isValidDateString, todayISO } from "@/lib/time";
import { Sport, SPORTS } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * The classes page across a whole marketplace: what is coming up, not
 * everything ever put in a diary, and no one venue's timetable crowding out
 * the rest. A venue's own classes, asked for by venue, are all there.
 */
const WINDOW_DAYS = 14;
const PER_VENUE_PER_DAY = 6;
const MOST = 200;

/** Public: upcoming instructor-led classes. */
export async function GET(req: NextRequest) {
  const params = req.nextUrl.searchParams;
  const venueParam = params.get("venueId");
  const sportParam = params.get("sport");
  const from = params.get("from") ?? undefined;
  const to = params.get("to") ?? undefined;

  if (venueParam && !Number.isInteger(Number(venueParam)))
    return NextResponse.json({ error: "Invalid venueId." }, { status: 400 });
  if (sportParam && !SPORTS.includes(sportParam as Sport))
    return NextResponse.json({ error: "Unknown sport." }, { status: 400 });
  for (const [label, value] of [["from", from], ["to", to]] as const) {
    if (value && !isValidDateString(value))
      return NextResponse.json({ error: `Invalid ${label} date.` }, { status: 400 });
  }

  const venueId = venueParam ? Number(venueParam) : undefined;
  const classes = await listClasses({
    venueId,
    venueIds: (await storefrontForRequest(req))?.venueIds,
    sport: (sportParam as Sport) ?? undefined,
    from,
    to: to ?? (venueId ? undefined : addDays(from ?? todayISO(), WINDOW_DAYS)),
  });
  if (venueId) return NextResponse.json({ classes });

  const perVenueDay = new Map<string, number>();
  const fair = classes.filter((c) => {
    const key = `${c.venueId}:${c.date}`;
    const n = (perVenueDay.get(key) ?? 0) + 1;
    perVenueDay.set(key, n);
    return n <= PER_VENUE_PER_DAY;
  });
  return NextResponse.json({ classes: fair.slice(0, MOST) });
}
