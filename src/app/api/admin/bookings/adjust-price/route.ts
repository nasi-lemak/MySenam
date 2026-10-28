import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { logAction } from "@/lib/activity";
import { asStaff } from "@/lib/acting-staff";
import { adjustBookingPrice, adjustmentsFor } from "@/lib/price-adjustments";
import { getDb } from "@/lib/db";
import { getVenueIdForBookingCode } from "@/lib/store";
import { money } from "@/lib/region";

export const dynamic = "force-dynamic";

/** `?code` → the price adjustments on one booking, oldest first (lib/price-adjustments.ts). */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const code = req.nextUrl.searchParams.get("code") ?? "";
  if (!code.trim()) return NextResponse.json({ error: "code is required." }, { status: 400 });
  const venueId = await getVenueIdForBookingCode(code);
  if (venueId === null) return NextResponse.json({ error: "Booking not found." }, { status: 404 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const b = (await getDb().prepare("SELECT id FROM bookings WHERE UPPER(code) = UPPER(?)").get(code.trim())) as { id: number };
  return NextResponse.json({ adjustments: (await adjustmentsFor([b.id])).get(b.id) ?? [] });
}

/**
 * `{ code, amount? | complimentary: true, reason }` → a manager's new price for one booking, with the reason
 * (lib/price-adjustments.ts; managers only, lib/roles.ts). Before it is paid the price changes and its receipt shows
 * the difference; after it was paid at the counter only a lower price, the difference on a credit note.
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.code !== "string" || body.code.trim() === "") return NextResponse.json({ error: "code is required." }, { status: 400 });
  const venueId = await getVenueIdForBookingCode(body.code);
  if (venueId === null) return NextResponse.json({ error: "Booking not found." }, { status: 404 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  // As the manager, so a credit note it writes says who gave the money back (lib/acting-staff.ts).
  const result = await asStaff(admin, () =>
    adjustBookingPrice({ code: body.code as string, amount: body.amount, complimentary: body.complimentary, reason: body.reason, staff: admin })
  );
  if (!result.ok) return NextResponse.json({ error: result.error, code: result.code }, { status: result.status });
  const a = result.adjustment;
  await logAction(admin, {
    venueId,
    action: "booking.price_adjusted",
    bookingCode: result.booking.code,
    detail: `${money(a.before)} → ${money(a.after)}${a.complimentary ? " (complimentary)" : ""}${a.paid ? `, after payment: ${money(-a.delta)} back on ${result.creditNote?.number ?? "a credit note"}` : ""}: ${a.reason}`,
  });
  return NextResponse.json(result);
}
