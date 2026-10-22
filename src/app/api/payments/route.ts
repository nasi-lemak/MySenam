import { NextRequest, NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { startBookingPayment } from "@/lib/payments";
import { MAX_RECUR_WEEKS } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Open a payment page for one or more of a customer's bookings.
 *
 * `{ code, phone }` or `{ codes: [...], phone }`, with `deposit: true` for the venue's deposit only. Answers with the gateway's
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
  const { code, codes, phone, deposit } = (body ?? {}) as Record<string, unknown>;
  const list = Array.isArray(codes) ? codes : typeof code === "string" ? [code] : [];
  if (list.length === 0 || list.length > MAX_RECUR_WEEKS || list.some((c) => typeof c !== "string"))
    return NextResponse.json({ error: "code and phone are required." }, { status: 400 });
  if (typeof phone !== "string" || phone.trim() === "")
    return NextResponse.json({ error: "code and phone are required." }, { status: 400 });

  const limited = await rateLimit(req, "payment");
  if (limited) return limited;

  // `deposit: true` for the venue's deposit only, where it takes one.
  const result = await startBookingPayment({ codes: list as string[], phone, deposit: deposit === true });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
  return NextResponse.json({ url: result.url, amount: result.amount, deposit: result.deposit === true });
}
