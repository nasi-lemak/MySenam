import { NextRequest, NextResponse } from "next/server";
import { listBookingsForDate } from "@/lib/store";
import { isValidDateString, todayISO } from "@/lib/time";

export const dynamic = "force-dynamic";

// Dev default — set ADMIN_PASSCODE in the environment for real deployments.
const PASSCODE = process.env.ADMIN_PASSCODE || "mudah-admin";

export function GET(req: NextRequest) {
  if (req.headers.get("x-admin-passcode") !== PASSCODE) {
    return NextResponse.json({ error: "Wrong passcode." }, { status: 401 });
  }
  const date = req.nextUrl.searchParams.get("date") ?? todayISO();
  if (!isValidDateString(date)) {
    return NextResponse.json({ error: "Invalid date. Use YYYY-MM-DD." }, { status: 400 });
  }
  const bookings = listBookingsForDate(date);
  const revenue = bookings
    .filter((b) => b.status === "confirmed")
    .reduce((sum, b) => sum + b.totalPrice, 0);
  return NextResponse.json({ date, bookings, revenue });
}
