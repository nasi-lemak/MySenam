import { NextRequest, NextResponse } from "next/server";
import { coachCalendar, coachForToken } from "@/lib/coach-schedule";

export const dynamic = "force-dynamic";

/** A coach's lessons as an iCalendar feed (lib/coach-schedule.ts). The token is the only key. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const token = (await params).token.replace(/\.ics$/, "");
  const found = await coachForToken(token);
  if (!found) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return new NextResponse(await coachCalendar(found, found.coach.venueId), {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="lessons.ics"',
      // Students' names and numbers: never kept by anything in between.
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex",
    },
  });
}
