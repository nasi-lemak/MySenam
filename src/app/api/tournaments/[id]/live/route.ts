import { NextRequest, NextResponse } from "next/server";
import { mayShowVenue } from "@/lib/listing";
import { liveBoard } from "@/lib/tournament-day";
import { tournamentById } from "@/lib/tournaments";

export const dynamic = "force-dynamic";

/**
 * The tournament's live board for anybody, signed in or not: what is on each court, what is next, and the latest
 * results, by the names the public may see (a declared minor by first name and initial). Nothing about check-in,
 * calls, staff, guardians or contact details (`liveBoard`). Shown where the tournament's own page is.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const t = await tournamentById(Number((await params).id));
  if (!t || t.status === "cancelled" || !(await mayShowVenue(t.venueId, req)).show) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return NextResponse.json({ board: await liveBoard(t.id) }, { headers: { "Cache-Control": "no-store" } });
}
