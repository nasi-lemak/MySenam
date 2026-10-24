import { NextRequest, NextResponse } from "next/server";
import { parseRules } from "@/lib/tournament-rules";
import { readMinute } from "@/lib/api";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { createTournament, listTournaments, type Format } from "@/lib/tournaments";
import type { Level } from "@/lib/games";
import type { Category } from "@/lib/who";
import type { Sport } from "@/lib/types";

export const dynamic = "force-dynamic";

/** `?venueId=` — a venue's tournaments, for its staff. */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(req.nextUrl.searchParams.get("venueId"));
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "Which venue?" }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  return NextResponse.json({ tournaments: await listTournaments([venueId]) });
}

/** A new tournament, holding its courts at once. */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  let b: Record<string, unknown>;
  try {
    b = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const venueId = Number(b.venueId);
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "Which venue?" }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const result = await createTournament(
    {
      venueId,
      name: String(b.name ?? ""),
      sport: String(b.sport ?? "") as Sport,
      format: String(b.format ?? "") as Format,
      teamSize: Number(b.teamSize) === 2 ? 2 : 1,
      category: typeof b.category === "string" ? (b.category as Category) : undefined,
      level: typeof b.level === "string" && b.level ? (b.level as Level) : null,
      entryFee: Number(b.entryFee ?? 0),
      maxEntries: Number(b.maxEntries),
      groupSize: Number(b.groupSize) || undefined,
      advance: Number(b.advance) || undefined,
      startsOn: String(b.startsOn ?? ""),
      endsOn: String(b.endsOn ?? ""),
      // Each day's time, in minutes of the day or HH:MM (startHour and endHour, the older form), and each match's length.
      startMin: readMinute(b, "startMin", "startHour"),
      endMin: readMinute(b, "endMin", "endHour"),
      ...(b.matchMinutes !== undefined ? { matchMinutes: Number(b.matchMinutes) } : {}),
      courtIds: Array.isArray(b.courtIds) ? b.courtIds.map(Number) : [],
      description: typeof b.description === "string" ? b.description : undefined,
      rules: rulesOf(b.rules),
    },
    admin.id
  );
  if (!result.ok) return NextResponse.json({ error: result.error, clashes: result.clashes }, { status: 400 });
  return NextResponse.json({ tournament: result.value }, { status: 201 });
}

/** Rules as given, or the defaults when they are missing or not understood (the form only offers valid ones). */
function rulesOf(raw: unknown) {
  const parsed = parseRules(raw);
  return parsed.ok ? parsed.rules : undefined;
}
