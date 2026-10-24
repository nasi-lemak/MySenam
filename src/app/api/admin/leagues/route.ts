import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { jsonBody } from "@/lib/league-access";
import { createLeague, listLeagues } from "@/lib/leagues";
import { TEMPLATES } from "@/lib/competition-templates";
import type { Level } from "@/lib/games";
import type { Who } from "@/lib/who";
import type { Sport } from "@/lib/types";

export const dynamic = "force-dynamic";

/** `?venueId=` — a venue's leagues, for its staff, with the head-to-head templates a new one can be scored by. */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(req.nextUrl.searchParams.get("venueId"));
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "Which venue?" }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  return NextResponse.json({ leagues: await listLeagues([venueId]), templates: TEMPLATES.filter((t) => !t.rules.performance) });
}

/** A new league, its first season forming. */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const b = await jsonBody(req);
  if (b instanceof NextResponse) return b;
  const venueId = Number(b.venueId);
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "Which venue?" }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const result = await createLeague(
    {
      venueId,
      name: String(b.name ?? ""),
      sport: String(b.sport ?? "") as Sport,
      teamSize: Number(b.teamSize) === 2 ? 2 : 1,
      who: typeof b.who === "string" ? (b.who as Who) : undefined,
      level: typeof b.level === "string" && b.level ? (b.level as Level) : null,
      boxSize: b.boxSize !== undefined ? Number(b.boxSize) : undefined,
      moves: b.moves !== undefined ? Number(b.moves) : undefined,
      seasonDays: b.seasonDays !== undefined ? Number(b.seasonDays) : undefined,
      fee: Number(b.fee ?? 0),
      startsOn: String(b.startsOn ?? ""),
      description: typeof b.description === "string" ? b.description : undefined,
      template: typeof b.template === "string" && b.template ? b.template : null,
      rules: b.rules ?? undefined,
    },
    admin.id
  );
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ league: result.value }, { status: 201 });
}
