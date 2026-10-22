import { NextRequest, NextResponse } from "next/server";
import { unsubscribe } from "@/lib/marketing";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * One-click unsubscribe from a mail app's own button (RFC 8058): the
 * List-Unsubscribe-Post header on a venue's news says to POST here. Only a
 * POST stops anything, so a scanner fetching links does not.
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const limited = await rateLimit(req, "bookingLookup");
  if (limited) return limited;
  if (!(await unsubscribe((await params).token))) return NextResponse.json({ error: "That unsubscribe link is not valid." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
