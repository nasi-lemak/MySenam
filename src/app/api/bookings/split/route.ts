import { NextRequest, NextResponse } from "next/server";
import { rateLimit } from "@/lib/rate-limit";
import { splitBooking, splitPath } from "@/lib/splits";
import { venueBaseUrl } from "@/lib/storefront";
import { findBooking, getCourt } from "@/lib/store";

export const dynamic = "force-dynamic";

/** `{ code, phone, parts }` → the booking split `parts` ways, and the link to send friends (lib/splits.ts). */
export async function POST(req: NextRequest) {
  const limited = await rateLimit(req, "bookingLookup");
  if (limited) return limited;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || typeof body.code !== "string" || typeof body.phone !== "string")
    return NextResponse.json({ error: "code and phone are required." }, { status: 400 });
  const made = await splitBooking(body.code, body.phone, body.parts);
  if (!made.ok) return NextResponse.json({ error: made.error }, { status: made.status });
  const booking = (await findBooking(body.code, body.phone))!;
  const court = (await getCourt(booking.courtId))!;
  return NextResponse.json({ split: made.split, url: `${await venueBaseUrl(court.venueId)}${splitPath(made.split.token)}` });
}
