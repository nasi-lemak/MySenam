import { NextRequest, NextResponse } from "next/server";
import { logAction } from "@/lib/activity";
import { getDb } from "@/lib/db";
import { jsonBody, staffLeague } from "@/lib/league-access";
import { decideResult, leagueDetail } from "@/lib/leagues";

export const dynamic = "force-dynamic";

/**
 * `{ winner, score?, walkover? }` decides it; `{ void: true }` strikes it; `{ clear: true }` puts it back to be played.
 * `version` (the match's as staff saw it): refused as changed (LG5_RESULT_CHANGED) if a player reported or answered
 * since. Both sides are emailed the decision; it is in the activity log.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; matchId: string }> }) {
  const { id, matchId } = await params;
  const found = await staffLeague(req, id);
  if (found instanceof NextResponse) return found;
  const match = (await getDb()
    .prepare(
      `SELECT m.id FROM league_matches m JOIN league_seasons s ON s.id = m.season_id
        WHERE m.id = ? AND s.league_id = ?`
    )
    .get(Number(matchId), found.id)) as { id: number } | undefined;
  if (!match) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const body = await jsonBody(req);
  if (body instanceof NextResponse) return body;
  const result = await decideResult(
    match.id,
    found.admin.id,
    body.void === true
      ? { void: true }
      : body.clear === true
        ? { clear: true }
        : { winner: Number(body.winner), score: typeof body.score === "string" ? body.score : undefined, walkover: body.walkover === true },
    { version: Number.isInteger(body.version) ? (body.version as number) : undefined }
  );
  if (!result.ok) return NextResponse.json({ error: result.error, ...(result.code ? { code: result.code } : {}) }, { status: 409 });
  const l = await leagueDetail(found.id, { forStaff: true });
  const m = result.value;
  const names = new Map((l?.people ?? []).map((p) => [p.id, p.name]));
  await logAction(found.admin, {
    venueId: l?.venueId ?? null,
    action: body.void === true ? "league.result_void" : body.clear === true ? "league.result_cleared" : "league.result_decided",
    detail: `${l?.name ?? `League ${found.id}`}: ${names.get(m.a) ?? m.a} v ${names.get(m.b) ?? m.b} — ${m.status}${m.score ? ` ${m.score}` : ""}`,
  });
  return NextResponse.json({ league: l });
}
