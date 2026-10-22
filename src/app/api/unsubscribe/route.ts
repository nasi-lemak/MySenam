import { NextRequest, NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { confirmConsent, unsubscribe } from "@/lib/marketing";

export const dynamic = "force-dynamic";

/** `{ token }` from a venue's email → no more news from it; with `confirm`, yes to it. No account needed. */
export async function POST(req: NextRequest) {
  const limited = await rateLimit(req, "bookingLookup");
  if (limited) return limited;
  const body = (await req.json().catch(() => null)) as { token?: unknown; confirm?: unknown } | null;
  if (!body || typeof body.token !== "string" || !(await (body.confirm === true ? confirmConsent : unsubscribe)(body.token)))
    return NextResponse.json({ error: "That unsubscribe link is not valid." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
