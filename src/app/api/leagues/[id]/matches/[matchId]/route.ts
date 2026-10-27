import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { jsonBody } from "@/lib/league-access";
import { confirmResult, disputeResult, reportResult } from "@/lib/leagues";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * A player on one of their own matches (or one of somebody they entered):
 * `{ action: "report", winner, score, version? }` (their games first),
 * `{ action: "confirm", version }`, or `{ action: "dispute", note, version }`.
 * `version` is the match's as the player saw it (`LeagueMatch.version`): an
 * answer to a result that changed since is refused (code LG5_RESULT_CHANGED),
 * and confirming or disputing needs it.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; matchId: string }> }) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const { id, matchId } = await params;
  const match = (await getDb()
    .prepare(
      `SELECT m.id FROM league_matches m JOIN league_seasons s ON s.id = m.season_id
        WHERE m.id = ? AND s.league_id = ?`
    )
    .get(Number(matchId), Number(id))) as { id: number } | undefined;
  if (!match) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const limited = await rateLimit(req, "booking");
  if (limited) return limited;
  const body = await jsonBody(req);
  if (body instanceof NextResponse) return body;
  const version = Number.isInteger(body.version) ? (body.version as number) : undefined;
  // An answer is to the result the player saw, so it names it.
  if ((body.action === "confirm" || body.action === "dispute") && version === undefined)
    return NextResponse.json({ error: "Say which result you are answering: version is needed." }, { status: 400 });
  const result =
    body.action === "report"
      ? await reportResult(user.id, match.id, { winner: Number(body.winner), score: String(body.score ?? "") }, { version })
      : body.action === "confirm"
        ? await confirmResult(user.id, match.id, { version })
        : body.action === "dispute"
          ? await disputeResult(user.id, match.id, String(body.note ?? ""), { version })
          : null;
  if (!result) return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  if (!result.ok) return NextResponse.json({ error: result.error, ...(result.code ? { code: result.code } : {}) }, { status: 409 });
  return NextResponse.json({ match: result.value });
}
