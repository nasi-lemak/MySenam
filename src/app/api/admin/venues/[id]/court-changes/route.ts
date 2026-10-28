import { NextRequest, NextResponse } from "next/server";
import { listCourtChanges } from "@/lib/dated-changes";
import { venueScope } from "@/lib/dated-changes-routes";

export const dynamic = "force-dynamic";

/** Every court's rates and own hours set from later dates, court by court (ADR 0027). */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const scoped = await venueScope(req, params);
  if (scoped instanceof NextResponse) return scoped;
  return NextResponse.json({ courts: await listCourtChanges(scoped.venueId) }, { headers: { "Cache-Control": "no-store" } });
}
