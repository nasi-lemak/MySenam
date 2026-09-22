import { NextRequest, NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { cancelSeries } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { seriesCode, phone } = (body ?? {}) as Record<string, unknown>;
  if (typeof seriesCode !== "string" || typeof phone !== "string")
    return NextResponse.json({ error: "seriesCode and phone are required." }, { status: 400 });

  const limited = rateLimit(req, "bookingLookup");
  if (limited) return limited;

  const result = cancelSeries(seriesCode, phone);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  return NextResponse.json({ cancelled: result.cancelled });
}
