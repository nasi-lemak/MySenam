import { NextRequest, NextResponse } from "next/server";
import { coachCalendar, coachFeedLocale, coachForToken } from "@/lib/coach-schedule";

export const dynamic = "force-dynamic";

/** A coach's lessons as an iCalendar feed (lib/coach-schedule.ts). The token is the only key; `?lang=` names the language its words and times are in. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const token = (await params).token.replace(/\.ics$/, "");
  const found = await coachForToken(token);
  if (!found) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return new NextResponse(await coachCalendar(found, found.coach.venueId, coachFeedLocale(req.nextUrl.searchParams.get("lang"))), {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="lessons.ics"',
      // Students' names and numbers: never kept by anything in between.
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex",
    },
  });
}
