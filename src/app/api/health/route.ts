import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Is this instance serving?
 *
 * Deliberately thin. A health check is reachable by anything that can reach
 * the port, so it says whether the database answers and nothing else — no
 * counts, no versions, no paths for somebody to learn the shape of the box
 * from. The detail an operator actually wants is behind the admin session.
 */
export async function GET() {
  try {
    await getDb().prepare("SELECT 1").get();
    return NextResponse.json({ ok: true }, { headers: { "Cache-Control": "no-store" } });
  } catch {
    return NextResponse.json({ ok: false }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
}
