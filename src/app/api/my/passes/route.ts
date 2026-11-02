import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { listPassesFor } from "@/lib/store";
import { startPassPayment } from "@/lib/payments";
import { readPassPurchase } from "@/lib/pass-purchases";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** The signed-in customer's own passes. */
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  return NextResponse.json({ passes: await listPassesFor(user.id) });
}

/**
 * `{ venueId, productId, participantId? }` → the page to pay the venue on for
 * one of its passes sold online (lib/pass-purchases.ts): for the customer's
 * own bookings, or, on a pass for one person's place, for somebody they look
 * after. The pass is issued once it is paid.
 */
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const limited = await rateLimit(req, "payment");
  if (limited) return limited;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || !Number.isInteger(body.venueId) || (body.venueId as number) <= 0)
    return NextResponse.json({ error: "venueId is required.", code: "PSO_REQUEST" }, { status: 400 });
  const request = readPassPurchase(body);
  if ("ok" in request) return NextResponse.json({ error: request.error, code: request.code, vars: request.vars }, { status: request.status });
  const started = await startPassPayment(user, body.venueId as number, request);
  if (!started.ok) return NextResponse.json({ error: started.error, code: started.code, vars: started.vars }, { status: started.status });
  return NextResponse.json({ url: started.url, amount: started.amount, reused: started.reused });
}
