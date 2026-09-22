import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { listBookingsForDate } from "@/lib/store";
import { isValidDateString, todayISO } from "@/lib/time";

export const dynamic = "force-dynamic";

export function GET(req: NextRequest) {
  const admin = requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  const date = req.nextUrl.searchParams.get("date") ?? todayISO();
  if (!isValidDateString(date)) {
    return NextResponse.json({ error: "Invalid date. Use YYYY-MM-DD." }, { status: 400 });
  }

  const bookings = listBookingsForDate(date, admin.venueId ?? undefined);
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
