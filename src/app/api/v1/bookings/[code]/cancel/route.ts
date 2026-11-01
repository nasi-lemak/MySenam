import { NextRequest, NextResponse } from "next/server";
import { apiCaller } from "@/lib/api-keys";
import { cancelThroughKey } from "@/lib/key-bookings";

export const dynamic = "force-dynamic";

/**
 * Cancel one of the venue's bookings, as its staff would (write keys). The customer is told. A counter payment on it
 * is owed back, for the desk to hand back or give as credit (lib/counter-refunds.ts `venueCancel`). The same code the
 * MCP server's cancel_booking runs (lib/key-bookings.ts).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const caller = await apiCaller(req, "write");
  if (caller instanceof NextResponse) return caller;
  return cancelThroughKey(caller, (await params).code);
}
