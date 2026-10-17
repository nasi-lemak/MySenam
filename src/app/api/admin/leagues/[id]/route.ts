import { NextRequest, NextResponse } from "next/server";
import { jsonBody, staffLeague } from "@/lib/league-access";
import { closeLeague, endSeason, leagueDetail, planSeason, startSeason } from "@/lib/leagues";
import { todayISO } from "@/lib/time";

export const dynamic = "force-dynamic";

/** The league as staff see it, `?season=` for an earlier one. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const found = await staffLeague(req, (await params).id);
  if (found instanceof NextResponse) return found;
  const raw = req.nextUrl.searchParams.get("season");
  return NextResponse.json({ league: await leagueDetail(found.id, { forStaff: true, season: raw ? Number(raw) : undefined }) });
}

/**
 * `{ action: "start", startsOn?, endsOn? }` makes the boxes now, and starts it today unless told otherwise;
 * `{ action: "end" }` finishes the season being played;
 * `{ action: "plan", startsOn }` moves the coming season;
 * `{ action: "close" }` stops the league.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const found = await staffLeague(req, (await params).id);
  if (found instanceof NextResponse) return found;
  const body = await jsonBody(req);
  if (body instanceof NextResponse) return body;
  const date = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const result =
    body.action === "start"
      ? await startSeason(found.id, { startsOn: date(body.startsOn) ?? todayISO(), endsOn: date(body.endsOn) })
      : body.action === "end"
        ? await endSeason(found.id)
        : body.action === "plan"
          ? await planSeason(found.id, String(body.startsOn ?? ""))
          : body.action === "close"
            ? await closeLeague(found.id)
            : null;
  if (!result) return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  return NextResponse.json({ league: await leagueDetail(found.id, { forStaff: true }) });
}
