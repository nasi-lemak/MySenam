import { NextRequest, NextResponse } from "next/server";
import { startSplitPayment } from "@/lib/payments";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/** `{ name, phone, email? }` → the venue's payment page for one share of a split booking. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const limited = await rateLimit(req, "payment");
  if (limited) return limited;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const started = await startSplitPayment((await params).token, { name: body?.name, phone: body?.phone, email: body?.email });
  if (!started.ok) return NextResponse.json({ error: started.error }, { status: started.status });
  return NextResponse.json({ url: started.url, amount: started.amount });
}
