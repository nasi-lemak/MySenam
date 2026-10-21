import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { rateLimit } from "@/lib/rate-limit";
import { bookAgainLink, findBooking } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * `?code` (signed in, one's own booking) or `?code&phone` → `{ url }`: the
 * venue page with the same court and hours picked on the next day they are
 * free.
 */
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code") ?? "";
  const phone = req.nextUrl.searchParams.get("phone");
  if (!code) return NextResponse.json({ error: "code is required." }, { status: 400 });
  const limited = await rateLimit(req, "bookingLookup");
  if (limited) return limited;

  let mine = false;
  if (phone) mine = (await findBooking(code, phone)) !== null;
  else {
    const user = await getSessionUser(req);
    if (user)
      mine =
        (await getDb().prepare("SELECT 1 AS n FROM bookings WHERE UPPER(code) = UPPER(?) AND user_id = ?").get(code.trim(), user.id)) !==
        undefined;
  }
  if (!mine)
    return NextResponse.json({ error: "Booking not found. Check the code and phone number.", code: "BOOKING_NOT_FOUND_CODE" }, { status: 404 });
  const url = await bookAgainLink(code);
  if (!url) return NextResponse.json({ error: "Booking not found.", code: "BOOKING_NOT_FOUND" }, { status: 404 });
  return NextResponse.json({ url });
}
