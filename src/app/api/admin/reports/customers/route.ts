import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { customerReport } from "@/lib/customer-report";
import { isValidDateString } from "@/lib/time";

export const dynamic = "force-dynamic";

/** `?venueId&from&to` → who the customers were (lib/customer-report.ts). Managers only, as the other reports. */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const params = req.nextUrl.searchParams;
  const venueId = Number(params.get("venueId"));
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  if (!isValidDateString(from) || !isValidDateString(to) || to < from)
    return NextResponse.json({ error: "from and to must be YYYY-MM-DD, in order." }, { status: 400 });
  if ((Date.parse(to) - Date.parse(from)) / 86_400_000 > 400) return NextResponse.json({ error: "A report can cover at most 400 days." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  return NextResponse.json({ report: await customerReport(venueId, from, to) }, { headers: { "Cache-Control": "no-store" } });
}
