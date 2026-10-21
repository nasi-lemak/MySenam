import { NextRequest, NextResponse } from "next/server";
import { refusal } from "@/lib/api";
import { getSessionUser } from "@/lib/auth";
import { rateLimit } from "@/lib/rate-limit";
import { redeemVoucher } from "@/lib/vouchers";

export const dynamic = "force-dynamic";

/** `{ code }` → the gift voucher, now credit on this account at its venue. */
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  // Codes are guessed one try at a time, slowly.
  const limited = await rateLimit(req, "bookingLookup");
  if (limited) return limited;
  const body = (await req.json().catch(() => null)) as { code?: unknown } | null;
  if (typeof body?.code !== "string" || body.code.trim() === "")
    return NextResponse.json({ error: "code is required." }, { status: 400 });
  const result = await redeemVoucher(user.id, body.code);
  if (!result.ok) return refusal(result);
  return NextResponse.json({ amount: result.voucher.amount, venueName: result.voucher.venueName });
}
