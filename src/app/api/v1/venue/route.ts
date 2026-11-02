import { NextRequest, NextResponse } from "next/server";
import { entryResources } from "@/lib/entries";
import { apiCaller } from "@/lib/api-keys";
import { apiVenue } from "@/lib/public-api";
import { getVenue } from "@/lib/store";

export const dynamic = "force-dynamic";

/** The key's venue: its details, hours and courts with their rates (lib/public-api.ts `apiVenue`). */
export async function GET(req: NextRequest) {
  const caller = await apiCaller(req, "availability");
  if (caller instanceof NextResponse) return caller;
  return NextResponse.json({ venue: apiVenue((await getVenue(caller.venueId))!, await entryResources(caller.venueId)) });
}
