import { NextRequest, NextResponse } from "next/server";
import { findAddress } from "@/lib/geo";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * `?q=` — where an address is, so the map on the application and branch
 * forms can open on it. Asked through here rather than from the browser so
 * every lookup shares one queue and one cache (lib/geo.ts).
 */
export async function GET(req: NextRequest) {
  const q = req.nextUrl.searchParams.get("q")?.trim() ?? "";
  if (q.length < 3) return NextResponse.json({ error: "Type more of the address." }, { status: 400 });
  const limited = await rateLimit(req, "geocode");
  if (limited) return limited;
  return NextResponse.json({ found: await findAddress(q) });
}
