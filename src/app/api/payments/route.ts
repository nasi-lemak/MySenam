import { NextRequest, NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { refusal } from "@/lib/api";
import { phoneForLink } from "@/lib/booking-access";
import { refuse } from "@/lib/entitlements";
import { startBookingPayment } from "@/lib/payments";
import { MAX_SERIES_WEEKS } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Open a payment page for one or more of a customer's bookings.
 *
 * `{ code, phone }` or `{ codes: [...], phone }` (or `t`, the first booking's signed link, in place of `phone`), with `deposit: true` for the venue's deposit only. Answers with the gateway's
 * URL to send the customer to; the booking is marked paid when the gateway
 * says it was, never because this was called.
 */
export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { code, codes, deposit, t: link } = (body ?? {}) as Record<string, unknown>;
  let { phone } = (body ?? {}) as Record<string, unknown>;
  const list = Array.isArray(codes) ? codes : typeof code === "string" ? [code] : [];
  if (list.length === 0 || list.length > MAX_SERIES_WEEKS || list.some((c) => typeof c !== "string"))
    return NextResponse.json({ error: "code and phone are required." }, { status: 400 });
  if ((typeof phone !== "string" || phone.trim() === "") && typeof link !== "string")
    return NextResponse.json({ error: "code and phone are required." }, { status: 400 });

  const limited = await rateLimit(req, "payment");
  if (limited) return limited;

  // The first booking's signed link in place of the phone (lib/booking-access.ts): its phone, for every code
  // given, so a code booked on another number is refused as it would be with the phone typed.
  if (typeof phone !== "string" || phone.trim() === "") {
    const opened = await phoneForLink(list[0] as string, link as string);
    if ("refused" in opened)
      return opened.refused === "expired"
        ? refusal(refuse("Q8A_LINK_EXPIRED"), 410)
        : NextResponse.json({ error: "Booking not found. Check the code and phone number." }, { status: 404 });
    phone = opened.phone;
  }

  // `deposit: true` for the venue's deposit only, where it takes one.
  const result = await startBookingPayment({ codes: list as string[], phone: phone as string, deposit: deposit === true });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ url: result.url, amount: result.amount, deposit: result.deposit === true });
}
