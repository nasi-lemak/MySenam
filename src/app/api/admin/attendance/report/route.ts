import { NextRequest, NextResponse } from "next/server";
import { logAction } from "@/lib/activity";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { attendanceCsv, attendanceReport, type ReportScope } from "@/lib/attendance";
import { isValidDateString } from "@/lib/time";

export const dynamic = "force-dynamic";

/**
 * `?venueId` and one of `classId`, `seriesCode` (a class term) or `from`&`to` (every class and lesson in the period) → the attendance
 * report: per session and per person, with the present rate, who has missed several in a row and the entries left on their passes
 * (a suggestion for a manager to act on by hand: no mark moves money). `&format=csv` → the marks as a spreadsheet, staff only, children
 * named in full (columns in docs/features/programmes.md#attendance-registers); the download is in the activity log.
 * Managers only (lib/roles.ts).
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const p = req.nextUrl.searchParams;
  const venueId = Number(p.get("venueId"));
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  let scope: ReportScope;
  if (p.get("classId")) {
    const classId = Number(p.get("classId"));
    if (!Number.isInteger(classId) || classId <= 0) return NextResponse.json({ error: "classId must be a class's id." }, { status: 400 });
    scope = { classId };
  } else if (p.get("seriesCode")) scope = { seriesCode: p.get("seriesCode")! };
  else if (isValidDateString(p.get("from") ?? "") && isValidDateString(p.get("to") ?? "") && p.get("from")! <= p.get("to")!) scope = { from: p.get("from")!, to: p.get("to")! };
  else return NextResponse.json({ error: "Give classId, seriesCode, or from and to." }, { status: 400 });
  if (p.get("format") === "csv") {
    const csv = await attendanceCsv(venueId, scope);
    if (csv === null) return NextResponse.json({ error: "Nothing found for that." }, { status: 404 });
    await logAction(admin, { venueId, action: "attendance.exported", detail: JSON.stringify(scope).slice(0, 200) });
    return new NextResponse(csv, {
      headers: { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="attendance-${venueId}.csv"`, "Cache-Control": "no-store" },
    });
  }
  const report = await attendanceReport(venueId, scope);
  if (!report) return NextResponse.json({ error: "Nothing found for that." }, { status: 404 });
  return NextResponse.json({ report }, { headers: { "Cache-Control": "no-store" } });
}
