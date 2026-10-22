import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { listBookingsForDate, searchBookings } from "@/lib/store";
import { isValidDateString, todayISO } from "@/lib/time";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  // A customer at the desk: their bookings by code, number, email or name.
  const q = req.nextUrl.searchParams.get("q");
  if (q !== null) return NextResponse.json({ hits: await searchBookings(q, admin.venueIds ?? undefined) });

  const date = req.nextUrl.searchParams.get("date") ?? todayISO();
  if (!isValidDateString(date)) {
    return NextResponse.json({ error: "Invalid date. Use YYYY-MM-DD." }, { status: 400 });
  }

  const bookings = await listBookingsForDate(date, admin.venueIds ?? undefined);
  const confirmed = bookings.filter((b) => b.status === "confirmed");
  const revenue = confirmed.reduce((sum, b) => sum + b.totalPrice, 0);
  const collected = confirmed
    .filter((b) => b.paymentStatus === "paid")
    .reduce((sum, b) => sum + b.totalPrice, 0);
  return NextResponse.json({
    date,
    bookings,
    revenue,
    collected,
    outstanding: revenue - collected,
  });
}
