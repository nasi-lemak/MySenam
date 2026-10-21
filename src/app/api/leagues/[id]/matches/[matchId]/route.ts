import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { jsonBody } from "@/lib/league-access";
import { confirmResult, disputeResult, reportResult } from "@/lib/leagues";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * A player on one of their own matches: `{ action: "report", winner, score }`
 * (their games first), `{ action: "confirm" }`, or `{ action: "dispute", note }`.
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
  const result =
    body.action === "report"
      ? await reportResult(user.id, match.id, { winner: Number(body.winner), score: String(body.score ?? "") })
      : body.action === "confirm"
        ? await confirmResult(user.id, match.id)
        : body.action === "dispute"
          ? await disputeResult(user.id, match.id, String(body.note ?? ""))
          : null;
  if (!result) return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  return NextResponse.json({ match: result.value });
}
