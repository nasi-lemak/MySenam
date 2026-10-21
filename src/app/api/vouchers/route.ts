import { NextRequest, NextResponse } from "next/server";
import { startVoucherPayment } from "@/lib/payments";
import { rateLimit } from "@/lib/rate-limit";
import { currentLocale } from "@/lib/locale";
import { shows, storefrontForRequest } from "@/lib/storefront";
import { mayShowVenue } from "@/lib/listing";

export const dynamic = "force-dynamic";

/**
 * `{ venueId, amount, buyerName, buyerEmail, buyerPhone?, recipientName?, message? }`
 * → the page to pay on. The voucher is good, and emailed, once it is paid.
 * No account needed: it is bought for somebody else.
 */
export async function POST(req: NextRequest) {
  const limited = rateLimit(req, "payment");
  if (limited) return limited;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || !Number.isInteger(body.venueId)) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const venueId = body.venueId as number;
  if (!shows(await storefrontForRequest(req), venueId) || !(await mayShowVenue(venueId, req)).show)
    return NextResponse.json({ error: "Venue not found." }, { status: 404 });
  const text = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : null);
  const started = await startVoucherPayment({
    venueId,
    amount: Number(body.amount),
    buyerName: text("buyerName") ?? "",
    buyerEmail: text("buyerEmail"),
    buyerPhone: text("buyerPhone"),
    recipientName: text("recipientName"),
    message: text("message"),
    // The email that sends it is written in the language it was bought in.
    locale: await currentLocale(),
  });
  if (!started.ok) return NextResponse.json({ error: started.error, code: started.code, vars: started.vars }, { status: started.status });
  return NextResponse.json({ url: started.url, amount: started.amount });
}
