import { NextRequest, NextResponse } from "next/server";
import { logAction } from "@/lib/activity";
import { getDb } from "@/lib/db";
import { applyCorrection, previewResult, recordResult, tournamentDetail, type ResultInput, type TournamentDetail } from "@/lib/tournaments";
import { staffTournament } from "@/lib/tournament-access";

export const dynamic = "force-dynamic";

/** Who is in the knockout's first round, line by line, for the activity log. */
function knockoutLines(d: TournamentDetail): string {
  const name = (id: number | null) => (id === null ? "bye" : d.entries.find((e) => e.id === id)?.name ?? `#${id}`);
  return d.matches
    .filter((m) => m.stage === "knockout" && m.round === 1)
    .sort((a, b) => a.position - b.position)
    .map((m) => `${name(m.a)} v ${name(m.b)}`)
    .join("; ");
}

/**
 * `{ winner, score?, walkover?, retired?, outOfEvent? }` — a result, written to the activity log with the one it replaced.
 * With `preview: true`: what it would change, nothing changed. With `correction: { mode, reason, token }`: a
 * correction after the knockout has begun (a group result, or a knockout result whose next match is played),
 * confirmed against its preview (managers only).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; matchId: string }> }) {
  const { id, matchId } = await params;
  const found = await staffTournament(req, id);
  if (found instanceof NextResponse) return found;
  const match = (await getDb()
    .prepare("SELECT id FROM tournament_matches WHERE id = ? AND tournament_id = ?")
    .get(Number(matchId), found.id)) as { id: number } | undefined;
  if (!match) return NextResponse.json({ error: "Not found." }, { status: 404 });
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const input: ResultInput = {
    winner: Number(body.winner),
    score: typeof body.score === "string" ? body.score : undefined,
    walkover: body.walkover === true,
    retired: body.retired === true,
    outOfEvent: body.outOfEvent === true,
  };
  if (body.preview === true) {
    const preview = await previewResult(match.id, input);
    if (!preview.ok) return NextResponse.json({ error: preview.error }, { status: 409 });
    return NextResponse.json({ preview: preview.value });
  }
  const before = (await tournamentDetail(found.id, { forStaff: true }))!;
  const was = before.matches.find((m) => m.id === match.id)!;
  if (body.correction !== undefined) {
    if (found.admin.role === "desk") return NextResponse.json({ error: "Only a manager can correct a result after the knockout has begun." }, { status: 403 });
    const c = (body.correction ?? {}) as Record<string, unknown>;
    if (c.mode !== "replace" && c.mode !== "standings_only") return NextResponse.json({ error: 'correction.mode is "replace" or "standings_only".' }, { status: 400 });
    const done = await applyCorrection(
      match.id,
      input,
      { mode: c.mode, reason: typeof c.reason === "string" ? c.reason : "", token: typeof c.token === "string" ? c.token : "" },
      found.admin
    );
    if (!done.ok) return NextResponse.json({ error: done.error, code: done.code }, { status: 409 });
    await logAction(found.admin, {
      venueId: done.value.detail.venueId,
      action: c.mode === "replace" ? "tournament.corrected" : "tournament.corrected_standings_only",
      detail: `${done.value.detail.name}: ${String(c.reason).slice(0, 200)}. ${done.value.changes.join(" ")}`,
    });
    return NextResponse.json({ tournament: done.value.detail, changes: done.value.changes });
  }
  const result = await recordResult(match.id, input);
  if (!result.ok) return NextResponse.json({ error: result.error, code: result.code }, { status: 409 });
  const d = result.value;
  const now = d.matches.find((m) => m.id === match.id)!;
  const name = (id: number | null) => d.entries.find((e) => e.id === id)?.name ?? "nobody";
  const told = (m: typeof now) =>
    `${name(m.winner)} won${m.score ? ` ${m.score}` : ""}${m.status === "walkover" ? " by walkover" : m.status === "retired" ? " (the other side retired)" : ""}`;
  await logAction(found.admin, {
    venueId: d.venueId,
    action: was.winner === null ? "tournament.result" : "tournament.result_changed",
    detail: `${d.name}, ${name(now.a)} v ${name(now.b)}: ${told(now)}${was.winner === null ? "" : ` (was: ${told(was)})`}`,
  });
  const [linesBefore, linesAfter] = [knockoutLines(before), knockoutLines(d)];
  const filledBefore = before.matches.some((m) => m.stage === "knockout" && m.round === 1 && (m.a !== null || m.b !== null));
  if (filledBefore && linesBefore !== linesAfter)
    await logAction(found.admin, { venueId: d.venueId, action: "tournament.knockout_refilled", detail: `${d.name}: ${linesAfter} (was: ${linesBefore})` });
  return NextResponse.json({ tournament: d });
}
