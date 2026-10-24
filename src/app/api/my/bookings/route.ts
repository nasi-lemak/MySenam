import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { listUserBookings } from "@/lib/store";
import { refundStatusFor } from "@/lib/payments";

export const dynamic = "force-dynamic";

export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const bookings = await listUserBookings(user.id);
  // Money paid online and owed back, or refunded, on any of them: for the customer to follow.
  return NextResponse.json({ bookings, refunds: await refundStatusFor(bookings.map((b) => b.id)) });
}
