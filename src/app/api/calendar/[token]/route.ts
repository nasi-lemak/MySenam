import { NextRequest, NextResponse } from "next/server";
import { feedLocale, staffCalendar, venueForFeed } from "@/lib/staff-calendar";

export const dynamic = "force-dynamic";

/**
 * A venue's bookings and classes as an iCalendar feed, for its staff's own
 * calendar apps (lib/staff-calendar.ts). The token is the only key: a wrong
 * or withdrawn one finds nothing. `?lang=` names the staff language its words
 * and times are in.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const token = (await params).token.replace(/\.ics$/, "");
  const venueId = await venueForFeed(token);
  if (venueId === null) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return new NextResponse(await staffCalendar(venueId, feedLocale(req.nextUrl.searchParams.get("lang"))), {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="bookings.ics"',
      // Customers' names and numbers: never kept by anything in between.
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex",
    },
  });
}
