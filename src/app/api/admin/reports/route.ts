import { NextRequest, NextResponse } from "next/server";
import { denyVenue, isOwner, requireAdmin } from "@/lib/admin-auth";
import { venueReport, walletLiability } from "@/lib/reports";
import { isValidDateString } from "@/lib/time";

export const dynamic = "force-dynamic";

/** The longest period a single report may cover, so one query cannot scan years. */
const MAX_DAYS = 400;

export function GET(req: NextRequest) {
  const admin = requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  const params = req.nextUrl.searchParams;
  const venueId = Number(params.get("venueId"));
  const from = params.get("from") ?? "";
  const to = params.get("to") ?? "";

  if (!Number.isInteger(venueId) || venueId <= 0)
    return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  if (!isValidDateString(from) || !isValidDateString(to))
    return NextResponse.json({ error: "from and to must be YYYY-MM-DD." }, { status: 400 });
  if (to < from)
    return NextResponse.json({ error: "The period ends before it starts." }, { status: 400 });

  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000 + 1;
  if (days > MAX_DAYS)
    return NextResponse.json(
      { error: `A report can cover at most ${MAX_DAYS} days.` },
      { status: 400 }
    );

  const denied = denyVenue(admin, venueId);
  if (denied) return denied;

  const report = venueReport(venueId, from, to);
  if (!report) return NextResponse.json({ error: "Venue not found." }, { status: 404 });

  // Stored credit is spendable at any venue, so it is the platform's
  // liability and only the platform owner is shown it.
  return NextResponse.json({
    report,
    wallet: isOwner(admin) ? walletLiability() : null,
  });
}
