import { NextRequest, NextResponse } from "next/server";
import { acknowledge } from "@/lib/urgent";
import { rateLimit } from "@/lib/rate-limit";
import { jsonObject } from "@/lib/api";

export const dynamic = "force-dynamic";

/** `{ token }` — the customer has seen the venue's news. */
export async function POST(req: NextRequest) {
  const limited = await rateLimit(req, "bookingLookup");
  if (limited) return limited;
  let b: Record<string, unknown>;
  try {
    b = (await jsonObject(req)) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (typeof b.token !== "string" || !(await acknowledge(b.token)))
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  return NextResponse.json({ ok: true });
}
