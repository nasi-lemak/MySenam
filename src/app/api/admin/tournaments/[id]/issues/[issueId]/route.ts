import { NextRequest, NextResponse } from "next/server";
import { logAction } from "@/lib/activity";
import { getDb } from "@/lib/db";
import { resolveIssue, reviewIssue, type MatchSlot } from "@/lib/tournaments";
import { staffTournament } from "@/lib/tournament-access";

export const dynamic = "force-dynamic";

async function issueOf(tournamentId: number, issueId: string): Promise<number | null> {
  const row = (await getDb().prepare("SELECT id FROM tournament_issues WHERE id = ? AND tournament_id = ?").get(Number(issueId), tournamentId)) as
    | { id: number }
    | undefined;
  return row?.id ?? null;
}

/** A progression issue: what it affects, whether it can be replayed (and which matches need a court and time), and a token. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string; issueId: string }> }) {
  const { id, issueId } = await params;
  const found = await staffTournament(req, id);
  if (found instanceof NextResponse) return found;
  const issue = await issueOf(found.id, issueId);
  if (!issue) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const review = await reviewIssue(issue);
  if (!review.ok) return NextResponse.json({ error: review.error }, { status: 409 });
  return NextResponse.json(review.value);
}

/**
 * `{ action: "stand" | "replay", reason, token, slots?: { [matchId]: { courtId, date, startMin } } }` — resolve it,
 * as a manager who reviewed it: the results as played stand, or the matches are replayed at the courts and times
 * given (held for the tournament, never over a booking).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string; issueId: string }> }) {
  const { id, issueId } = await params;
  const found = await staffTournament(req, id);
  if (found instanceof NextResponse) return found;
  if (found.admin.role === "desk") return NextResponse.json({ error: "Only a manager can resolve a correction's consequences." }, { status: 403 });
  const issue = await issueOf(found.id, issueId);
  if (!issue) return NextResponse.json({ error: "Not found." }, { status: 404 });
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const slots: Record<string, MatchSlot> = {};
  if (body.slots && typeof body.slots === "object")
    for (const [matchId, raw] of Object.entries(body.slots as Record<string, Record<string, unknown>>))
      slots[matchId] = { courtId: Number(raw?.courtId), date: String(raw?.date ?? ""), startMin: Number(raw?.startMin) };
  const done = await resolveIssue(
    issue,
    {
      action: body.action === "replay" ? "replay" : body.action === "stand" ? "stand" : (String(body.action) as "stand"),
      reason: typeof body.reason === "string" ? body.reason : "",
      token: typeof body.token === "string" ? body.token : "",
      slots,
    },
    found.admin
  );
  if (!done.ok) return NextResponse.json({ error: done.error, code: done.code }, { status: 409 });
  await logAction(found.admin, {
    venueId: done.value.detail.venueId,
    action: body.action === "replay" ? "tournament.replay" : "tournament.results_stand",
    detail: `${done.value.detail.name}: ${String(body.reason).slice(0, 200)}. ${done.value.changes.join(" ")}`,
  });
  return NextResponse.json({ tournament: done.value.detail, changes: done.value.changes, changePhrases: done.value.changePhrases });
}
