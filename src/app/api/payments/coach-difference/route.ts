import { NextRequest, NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { startCoachDifferencePayment } from "@/lib/payments";

export const dynamic = "force-dynamic";

/**
 * Open a payment page for the difference a paid lesson owes after the venue
 * gave it to a dearer coach (lib/lesson-coaches.ts; lib/payments.ts
 * startCoachDifferencePayment).
 *
 * `{ token }` from the link in the coach-change email, or `{ code, phone,
 * changeId }` from the customer's booking page. Answers with the gateway's URL
 * for exactly the amount owed on that change (a page still open for it is
 * sent back to); the difference is marked paid when the gateway says the money
 * arrived, never because this was called. The counter can still take it.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || (typeof body.token !== "string" && (typeof body.code !== "string" || typeof body.phone !== "string" || !Number.isInteger(body.changeId))))
    return NextResponse.json({ error: "token, or code, phone and changeId, are required." }, { status: 400 });
  const limited = await rateLimit(req, "payment");
  if (limited) return limited;
  const result = await startCoachDifferencePayment(
    typeof body.token === "string" ? { token: body.token } : { code: body.code, phone: body.phone, changeId: body.changeId }
  );
  if (!result.ok)
    return NextResponse.json(
      { error: result.error, ...(result.code ? { code: result.code } : {}), ...(result.vars ? { vars: result.vars } : {}) },
      { status: result.status }
    );
  return NextResponse.json({ url: result.url, amount: result.amount, reused: result.reused });
}
