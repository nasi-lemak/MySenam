import { NextRequest, NextResponse } from "next/server";
import { adminForCalendarToken } from "@/lib/rosters";
import { staffShiftCalendar } from "@/lib/roster-calendar";
import { chosenStaffLocale, staffReaderLocale } from "@/lib/staff-locales";

export const dynamic = "force-dynamic";

/**
 * A member of staff's own shifts as an iCalendar feed (lib/roster-calendar.ts). The token is the only key, made by the person
 * themselves (`POST /api/admin/roster/my-calendar`), shown once, and good for the one person's shifts: nobody else's, and no
 * customer's name or number. In the language the person chose for the dashboard, else the install's first staff language.
 */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const token = (await params).token.replace(/\.ics$/, "");
  const admin = await adminForCalendarToken(token);
  if (!admin) return NextResponse.json({ error: "Not found." }, { status: 404 });
  const locale = chosenStaffLocale(admin.locale) ?? staffReaderLocale(null);
  return new NextResponse(await staffShiftCalendar(admin, locale), {
    headers: {
      "Content-Type": "text/calendar; charset=utf-8",
      "Content-Disposition": 'inline; filename="shifts.ics"',
      "Cache-Control": "private, no-store",
      "X-Robots-Tag": "noindex",
    },
  });
}
