import { NextRequest, NextResponse } from "next/server";
import { isActivity } from "@/lib/activities";
import { mayShowVenue } from "@/lib/listing";
import { RATING_FORMATS, type RatingFormat } from "@/lib/rating-math";
import { boardChoices, businessBoard, rankingPolicy, venueBoard } from "@/lib/ratings";

export const dynamic = "force-dynamic";

/**
 * Public, and only where the venue's manager has switched public rankings on (`public_rankings`, off by default: until then this
 * answers 404, as for a page that is not there, however much has been rated). A venue's rankings for a sport and format
 * (`?sport=&format=`, `&season=2026` for one year's results, `&scope=business` for the business's branches that list theirs side by side).
 * Only people who chose to be listed (declared adults, under the name they gave) and teams their captains published; ranked only once
 * they have the venue's number of counted results (`rules.rankAfter`), and, where the venue chose to show them, the others apart in
 * `board.provisional`: not ranked, not in an order of merit. Without a sport and format, what there is to choose from. Nothing here
 * names a child, or anybody who did not say yes.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const venueId = Number((await params).id);
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "Invalid venue id." }, { status: 400 });
  if (!(await mayShowVenue(venueId, req)).show) return NextResponse.json({ error: "Venue not found." }, { status: 404 });
  const policy = await rankingPolicy(venueId);
  // Not published: nothing, not an empty list. The venue's managers still see everything in their own panel.
  if (!policy.publicRankings) return NextResponse.json({ error: "This venue has not published rankings." }, { status: 404 });
  const q = req.nextUrl.searchParams;
  const choices = await boardChoices(venueId);
  // `provisionalGames` is what the field has always been called: the counted results before somebody is ranked here.
  const published = { provisionalGames: policy.rankAfter, rankAfter: policy.rankAfter, showProvisional: policy.showProvisional };
  const sport = q.get("sport");
  const format = q.get("format");
  if (!sport || !format) return NextResponse.json({ choices, rules: published });
  if (!(await isActivity(sport)) || !(RATING_FORMATS as string[]).includes(format)) return NextResponse.json({ error: "Unknown sport or format." }, { status: 400 });
  const seasonText = q.get("season");
  const season = seasonText && seasonText !== "all" ? Number(seasonText) : undefined;
  if (season !== undefined && (!Number.isInteger(season) || season < 2000 || season > 2200)) return NextResponse.json({ error: "Which year?" }, { status: 400 });
  const board = q.get("scope") === "business" ? await businessBoard(venueId, sport, format as RatingFormat, { season }) : await venueBoard(venueId, sport, format as RatingFormat, { season });
  if (!board) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return NextResponse.json({ choices, board, rules: published });
}
