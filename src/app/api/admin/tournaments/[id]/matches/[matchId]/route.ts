import { NextRequest, NextResponse } from "next/server";
import { logAction } from "@/lib/activity";
import { getDb } from "@/lib/db";
import {
  applyCorrection,
  moveMatch,
  previewResult,
  recordPerformances,
  recordResult,
  tournamentDetail,
  type PerformanceInput,
  type ResultInput,
  type TournamentDetail,
} from "@/lib/tournaments";
import { staffTournament } from "@/lib/tournament-access";
import { noteResultBy } from "@/lib/match-reports";

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
 * `{ winner, score?, walkover?, retired?, outOfEvent? }` — a result (`winner: null` for a draw, where the rules
 * allow one), written to the activity log with the one it replaced; `{ performances: [{ entryId, attempts?, status?,
 * note? }] }` for a heat or a final.
 * With `preview: true`: what it would change, nothing changed. With `correction: { mode, reason, token }`: a
 * correction after the knockout has begun (a group result, or a knockout result whose next match is played),
 * confirmed against its preview (managers only). `{ move: { courtId, date, startMin, minutes? } }`: the fixture
 * moved or given another length (managers only), its sides told.
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
  // A fixture moved, or given a different length: an organiser's decision.
  if (body.move && typeof body.move === "object") {
    if (found.admin.role === "desk") return NextResponse.json({ error: "Only a manager can move a fixture." }, { status: 403 });
    const mv = body.move as Record<string, unknown>;
    const moved = await moveMatch(match.id, {
      courtId: Number(mv.courtId),
      date: String(mv.date ?? ""),
      startMin: Number(mv.startMin),
      ...(mv.minutes !== undefined && mv.minutes !== null && mv.minutes !== "" ? { minutes: Number(mv.minutes) } : {}),
    });
    if (!moved.ok) return NextResponse.json({ error: moved.error }, { status: 409 });
    await logAction(found.admin, { venueId: moved.value.detail.venueId, action: "tournament.match_moved", detail: `${moved.value.detail.name}: ${moved.value.change}` });
    return NextResponse.json({ tournament: moved.value.detail, change: moved.value.change });
  }
  // A heat or a final: each competitor's marks.
  if (Array.isArray(body.performances)) {
    const lines = (body.performances as Record<string, unknown>[]).map(
      (p): PerformanceInput => ({
        entryId: Number(p.entryId),
        attempts: Array.isArray(p.attempts) ? p.attempts.map((a) => String(a ?? "")) : undefined,
        status: typeof p.status === "string" ? (p.status as PerformanceInput["status"]) : undefined,
        note: typeof p.note === "string" ? p.note : undefined,
      })
    );
    const done = await recordPerformances(match.id, lines);
    if (!done.ok) return NextResponse.json({ error: done.error }, { status: 409 });
    await logAction(found.admin, { venueId: done.value.venueId, action: "tournament.performances", detail: `${done.value.name}: results for ${lines.length} competitor(s)` });
    return NextResponse.json({ tournament: done.value });
  }
  const input: ResultInput = {
    winner: body.winner === null ? null : Number(body.winner),
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
    return NextResponse.json({ tournament: done.value.detail, changes: done.value.changes, changePhrases: done.value.changePhrases });
  }
  const result = await recordResult(match.id, input);
  if (!result.ok) return NextResponse.json({ error: result.error, code: result.code }, { status: 409 });
  await noteResultBy(match.id, "staff");
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
