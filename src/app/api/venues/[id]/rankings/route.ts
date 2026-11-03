import { NextRequest, NextResponse } from "next/server";
import { isActivity } from "@/lib/activities";
import { mayShowVenue } from "@/lib/listing";
import { RATING_FORMATS, type RatingFormat } from "@/lib/rating-math";
import { boardChoices, businessBoard, ratingRulesNow, venueBoard } from "@/lib/ratings";

export const dynamic = "force-dynamic";

/**
 * Public: a venue's rankings for a sport and format (`?sport=&format=`, `&season=2026` for one year's results, `&scope=business`
 * for the business's branches that list theirs side by side). Only people who chose to be listed (declared adults, under the
 * name they gave) and teams their captains published, and only once a rating is no longer provisional. Without a sport and
 * format, what there is to choose from. Nothing here names a child, or anybody who did not say yes.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const venueId = Number((await params).id);
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "Invalid venue id." }, { status: 400 });
  if (!(await mayShowVenue(venueId, req)).show) return NextResponse.json({ error: "Venue not found." }, { status: 404 });
  const q = req.nextUrl.searchParams;
  const choices = await boardChoices(venueId);
  const { rules } = await ratingRulesNow();
  const published = { provisionalGames: rules.provisionalGames };
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
