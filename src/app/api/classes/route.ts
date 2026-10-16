import { NextRequest, NextResponse } from "next/server";
import { listClasses } from "@/lib/store";
import { storefrontForRequest } from "@/lib/storefront";
import { isValidDateString } from "@/lib/time";
import { Sport, SPORTS } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Public: upcoming instructor-led classes. */
export function GET(req: NextRequest) {
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

  return NextResponse.json({
    classes: listClasses({
      venueId: venueParam ? Number(venueParam) : undefined,
      venueIds: storefrontForRequest(req)?.venueIds,
      sport: (sportParam as Sport) ?? undefined,
      from,
      to,
    }),
  });
}
