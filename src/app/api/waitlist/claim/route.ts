import { NextRequest, NextResponse } from "next/server";
import { refusal } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { claimWaitlistOffer, getClass } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { token } = (body ?? {}) as Record<string, unknown>;
  if (typeof token !== "string" || token.trim() === "")
    return NextResponse.json({ error: "token is required." }, { status: 400 });

  const limited = await rateLimit(req, "bookingLookup");
  if (limited) return limited;

  const result = await claimWaitlistOffer(token);
  if (!result.ok) return refusal(result);

  return NextResponse.json({
    booking: result.booking,
    session: result.booking.classId ? await getClass(result.booking.classId) : null,
  });
}
