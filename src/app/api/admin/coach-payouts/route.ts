import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { coachPayouts, coachPayoutsCsv } from "@/lib/coach-schedule";

export const dynamic = "force-dynamic";

/**
 * `?venueId=&from=&to=[&format=csv[&coachId=]]` → each coach's lessons in the
 * period and the fees on them (lib/coach-schedule.ts). With `coachId`, the
 * CSV holds that coach's own lessons only: the one to hand to the coach.
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const p = req.nextUrl.searchParams;
  const venueId = Number(p.get("venueId"));
  const from = p.get("from") ?? "";
  const to = p.get("to") ?? "";
  if (!Number.isInteger(venueId) || venueId <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to))
    return NextResponse.json({ error: "venueId, from and to are required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const coachId = p.get("coachId") ? Number(p.get("coachId")) : undefined;
  if (coachId !== undefined && (!Number.isInteger(coachId) || coachId <= 0)) return NextResponse.json({ error: "coachId must be a coach's id." }, { status: 400 });
  if (p.get("format") === "csv")
    return new NextResponse(await coachPayoutsCsv(venueId, from, to, coachId), {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="coach-lessons-${coachId !== undefined ? `${coachId}-` : ""}${from}-to-${to}.csv"`,
        "Cache-Control": "private, no-store",
      },
    });
  return NextResponse.json({ payouts: await coachPayouts(venueId, from, to) });
}
