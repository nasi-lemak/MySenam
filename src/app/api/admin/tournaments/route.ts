import { NextRequest, NextResponse } from "next/server";
import { jsonObject, readMinute } from "@/lib/api";
import { TEMPLATES, venueTemplates, type EntryKind } from "@/lib/competition-templates";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { createTournament, listTournaments, type Format, type StageKey } from "@/lib/tournaments";
import { listCompetitions } from "@/lib/competitions";
import type { Level } from "@/lib/games";
import type { Category } from "@/lib/who";
import type { Sport } from "@/lib/types";

export const dynamic = "force-dynamic";

/** `?venueId=` — a venue's tournaments and competitions, for its staff, with the sport templates and the venue's own to start one from. */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(req.nextUrl.searchParams.get("venueId"));
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "Which venue?" }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  return NextResponse.json({
    tournaments: await listTournaments([venueId]),
    competitions: await listCompetitions([venueId]),
    templates: TEMPLATES,
    venueTemplates: await venueTemplates(venueId),
  });
}

/**
 * A new tournament, holding its courts at once. `template` (a sport template's key) and `rules` (laid over it)
 * set its scoring and how it treats somebody who leaves; `entryKind` "team" with `roster: { min, max }` makes it a
 * team event. `competitionId` makes it a division of that competition, in its days, hours and courts. Who may
 * enter: `entriesCloseOn`, `ageMin`, `ageMax`, `membersOnly`.
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  let b: Record<string, unknown>;
  try {
    b = (await jsonObject(req)) as Record<string, unknown>;
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
      entryKind: typeof b.entryKind === "string" ? (b.entryKind as EntryKind) : undefined,
      roster:
        b.roster && typeof b.roster === "object"
          ? { min: Number((b.roster as Record<string, unknown>).min), max: Number((b.roster as Record<string, unknown>).max) }
          : undefined,
      template: typeof b.template === "string" && b.template ? b.template : undefined,
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
      rules: b.rules ?? undefined,
      competitionId: Number.isInteger(b.competitionId) ? (b.competitionId as number) : null,
      entriesCloseOn: typeof b.entriesCloseOn === "string" && b.entriesCloseOn ? b.entriesCloseOn : null,
      ageMin: b.ageMin === null || b.ageMin === undefined || b.ageMin === "" ? null : Number(b.ageMin),
      ageMax: b.ageMax === null || b.ageMax === undefined || b.ageMax === "" ? null : Number(b.ageMax),
      membersOnly: b.membersOnly === true,
      resultsBy: b.resultsBy === "players" ? "players" : "staff",
      stageMinutes: b.stageMinutes && typeof b.stageMinutes === "object" ? (b.stageMinutes as Partial<Record<StageKey, number>>) : null,
      thirdPlace: b.thirdPlace === true,
    },
    admin.id
  );
  if (!result.ok) return NextResponse.json({ error: result.error, clashes: result.clashes }, { status: 400 });
  return NextResponse.json({ tournament: result.value }, { status: 201 });
}

