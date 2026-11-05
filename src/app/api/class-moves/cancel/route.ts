import { NextRequest, NextResponse } from "next/server";
import { jsonObject, refusal } from "@/lib/api";
import { cancelMovedPlace } from "@/lib/class-moves";
import { tickOutbox } from "@/lib/notify";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * `{ token, bookingId }`: a customer whose class the venue moved cancels one place, within the window the move gave them, for
 * everything back (lib/class-moves.ts `cancelMovedPlace`). The token is the private link in the message they were sent; it
 * covers only that person's places in that move. Once: a second tap finds it cancelled. 404 for a link nobody holds.
 */
export async function POST(req: NextRequest) {
  const limited = await rateLimit(req, "bookingLookup");
  if (limited) return limited;
  let body: Record<string, unknown>;
  try {
    body = await jsonObject(req);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (typeof body.token !== "string" || typeof body.bookingId !== "number") return NextResponse.json({ error: "Not found." }, { status: 404 });
  const result = await cancelMovedPlace(body.token, body.bookingId);
  if (!result.ok) return refusal(result, result.code === "CLSA_LINK" ? 404 : 409);
  await tickOutbox();
  return NextResponse.json({ ok: true, refunds: result.refunds.map((r) => ({ how: r.how, amount: r.amount, pending: r.pending === true })) });
}
