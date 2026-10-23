import { NextRequest, NextResponse } from "next/server";
import { logAction } from "@/lib/activity";
import { getDb } from "@/lib/db";
import { recordResult, tournamentDetail, type TournamentDetail } from "@/lib/tournaments";
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

/** `{ winner, score?, walkover? }` — a result, written to the activity log with the one it replaced. */
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
  const before = (await tournamentDetail(found.id, { forStaff: true }))!;
  const was = before.matches.find((m) => m.id === match.id)!;
  const result = await recordResult(match.id, {
    winner: Number(body.winner),
    score: typeof body.score === "string" ? body.score : undefined,
    walkover: body.walkover === true,
  });
  if (!result.ok) return NextResponse.json({ error: result.error, code: result.code }, { status: 409 });
  const d = result.value;
  const now = d.matches.find((m) => m.id === match.id)!;
  const name = (id: number | null) => d.entries.find((e) => e.id === id)?.name ?? "nobody";
  const told = (m: typeof now) => `${name(m.winner)} won${m.score ? ` ${m.score}` : m.status === "walkover" ? " by walkover" : ""}`;
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
