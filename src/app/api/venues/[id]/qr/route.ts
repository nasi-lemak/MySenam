import { NextRequest, NextResponse } from "next/server";
import { mayShowVenue } from "@/lib/listing";
import { venueQrSvg } from "@/lib/venue-link";

export const dynamic = "force-dynamic";

/** The venue's booking link as a QR code (SVG), to print or share. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const id = Number((await params).id);
  // A draft is its own staff's to print, nobody else's to find.
  if (!Number.isInteger(id) || !(await mayShowVenue(id, req)).show) return NextResponse.json({ error: "Venue not found." }, { status: 404 });
  return new NextResponse(await venueQrSvg(id), {
    headers: { "Content-Type": "image/svg+xml", "Cache-Control": "private, max-age=3600" },
  });
}
