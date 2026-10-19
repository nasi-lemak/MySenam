import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { logAction } from "@/lib/activity";
import { bookingsCsv, paymentsCsv } from "@/lib/export";
import { isValidDateString } from "@/lib/time";

export const dynamic = "force-dynamic";

const MAX_DAYS = 400;

/** `?venueId&from&to&kind=bookings|payments` → a CSV download, for managers. */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const p = req.nextUrl.searchParams;
  const venueId = Number(p.get("venueId"));
  const from = p.get("from") ?? "";
  const to = p.get("to") ?? "";
  const kind = p.get("kind") === "payments" ? "payments" : "bookings";
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  if (!isValidDateString(from) || !isValidDateString(to) || to < from)
    return NextResponse.json({ error: "from and to must be YYYY-MM-DD, in order." }, { status: 400 });
  if ((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1 > MAX_DAYS)
    return NextResponse.json({ error: `An export can cover at most ${MAX_DAYS} days.` }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;

  const csv = kind === "payments" ? await paymentsCsv(venueId, from, to) : await bookingsCsv(venueId, from, to);
  // Customers' names and numbers left the building: worth knowing who took them.
  await logAction(admin, { venueId, action: "export", detail: `${kind}, ${from} to ${to}` });
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${kind}-${venueId}-${from}-to-${to}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
