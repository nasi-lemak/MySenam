import { NextRequest, NextResponse } from "next/server";
import { logAction } from "@/lib/activity";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { readJsonObject } from "@/lib/api";
import { TEMPLATES } from "@/lib/competition-templates";
import type { Level } from "@/lib/games";
import { ladderResponse } from "@/lib/ladder-access";
import { createLadder, listLadders, type LadderSettings } from "@/lib/ladders";
import type { Sport } from "@/lib/types";
import type { Who } from "@/lib/who";

export const dynamic = "force-dynamic";

/** `?venueId=` — a venue's ladders, for its staff, with the head-to-head templates a new one can be scored by. */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(req.nextUrl.searchParams.get("venueId"));
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "Which venue?" }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  return NextResponse.json({ ladders: await listLadders([venueId]), templates: TEMPLATES.filter((t) => !t.rules.performance) });
}

/**
 * A manager's: a new ladder, its first season begun. `{ venueId, name, sport, teamSize?, who?, audience?: "adults" | "juniors", level?,
 * description?, template?, rules?, settings?: { reach, respondDays, playDays, cooldownDays, inactiveDays, inactiveDrop,
 * freezeMaxDays, declineIs } }`.
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const b = await readJsonObject(req);
  if (b instanceof NextResponse) return b;
  const venueId = Number(b.venueId);
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "Which venue?" }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const result = await createLadder(
    {
      venueId,
      name: String(b.name ?? ""),
      sport: String(b.sport ?? "") as Sport,
      teamSize: Number(b.teamSize) === 2 ? 2 : 1,
      who: typeof b.who === "string" ? (b.who as Who) : undefined,
      audience: typeof b.audience === "string" ? (b.audience as "adults" | "juniors") : undefined,
      level: typeof b.level === "string" && b.level ? (b.level as Level) : null,
      description: typeof b.description === "string" ? b.description : undefined,
      template: typeof b.template === "string" && b.template ? b.template : null,
      rules: b.rules ?? undefined,
      settings: b.settings && typeof b.settings === "object" ? (b.settings as Partial<LadderSettings>) : undefined,
    },
    admin.id
  );
  if (!result.ok) return ladderResponse(result);
  await logAction(admin, {
    venueId,
    action: "ladder.created",
    detail: `${result.value.name}: ${result.value.audience}, challenges up to ${result.value.settings.reach} places above`,
  });
  return NextResponse.json({ ladder: result.value }, { status: 201 });
}
