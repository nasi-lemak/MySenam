import { NextRequest, NextResponse } from "next/server";
import { logAction } from "@/lib/activity";
import { cancelTournament, changeTournament, closeEntries, makeDraw, makeFinal, setRules, tournamentChangeDetail, tournamentDetail } from "@/lib/tournaments";
import { tickOutbox } from "@/lib/notify";
import { saveVenueTemplate } from "@/lib/competition-templates";
import { staffTournament } from "@/lib/tournament-access";
import { listOfficials, openReports } from "@/lib/match-reports";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const found = await staffTournament(req, (await params).id);
  if (found instanceof NextResponse) return found;
  return NextResponse.json({
    tournament: await tournamentDetail(found.id, { forStaff: true }),
    // Results players reported and are waiting on, or dispute; and the officials' links.
    reports: await openReports(found.id),
    officials: await listOfficials(found.id),
  });
}

/**
 * `{ name?, description?, entriesCloseOn?, maxEntries?, entryFee? }` — change
 * its details before the draw (lib/tournaments.ts `changeTournament`): the fee
 * for entries made from now on, never below those entered; more places take
 * entries off the waiting list. Logged as `tournament.changed`.
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const found = await staffTournament(req, (await params).id);
  if (found instanceof NextResponse) return found;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const result = await changeTournament(found.id, {
    name: body.name,
    description: body.description,
    entriesCloseOn: body.entriesCloseOn,
    maxEntries: body.maxEntries,
    entryFee: body.entryFee,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  const { before, after, promoted } = result.value;
  await logAction(found.admin, { venueId: after.venueId, action: "tournament.changed", detail: tournamentChangeDetail(before, after, promoted.length) });
  if (promoted.length > 0) await tickOutbox();
  return NextResponse.json({ tournament: await tournamentDetail(found.id, { forStaff: true }), promoted: promoted.length });
}

/**
 * `{ action: "close" | "draw" | "cancel" }`; `{ action: "rules", rules }` before the draw; `{ action: "final",
 * chosen }` — who takes the last places in a performance final where competitors are level; `{ action:
 * "save_template", name }` — keep its settings to start the next one from.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const found = await staffTournament(req, (await params).id);
  if (found instanceof NextResponse) return found;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (body.action === "save_template") {
    const saved = await saveVenueTemplate(found.id, String(body.name ?? ""), found.admin.id);
    if (!saved.ok) return NextResponse.json({ error: saved.error }, { status: 400 });
    return NextResponse.json({ template: saved.value });
  }
  const result =
    body.action === "final"
      ? await makeFinal(found.id, Array.isArray(body.chosen) ? body.chosen.map(Number) : [])
      : body.action === "close"
      ? await closeEntries(found.id)
      : body.action === "draw"
        ? await makeDraw(found.id)
        : body.action === "cancel"
          ? await cancelTournament(found.id)
          : body.action === "rules"
            ? await setRules(found.id, body.rules)
            : null;
  if (!result) return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  const t = await tournamentDetail(found.id, { forStaff: true });
  await logAction(found.admin, {
    venueId: t?.venueId ?? null,
    action:
      body.action === "close"
        ? "tournament.closed"
        : body.action === "draw"
          ? "tournament.drawn"
          : body.action === "rules"
            ? "tournament.rules"
            : body.action === "final"
              ? "tournament.final_chosen"
              : "tournament.cancelled",
    detail: t?.name ?? `Tournament ${found.id}`,
  });
  return NextResponse.json({ tournament: await tournamentDetail(found.id, { forStaff: true }) });
}
