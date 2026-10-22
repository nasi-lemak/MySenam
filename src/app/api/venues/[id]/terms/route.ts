import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { bookingTerms, dismissedVersion, dismissTerms, standing } from "@/lib/booking-terms";
import { SPORTS, type Sport } from "@/lib/types";
import { mayShowVenue } from "@/lib/listing";

export const dynamic = "force-dynamic";

async function venueOf(req: NextRequest, raw: string): Promise<number | NextResponse> {
  const venueId = Number(raw);
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "Invalid venue id." }, { status: 400 });
  if (!(await mayShowVenue(venueId, req)).show) return NextResponse.json({ error: "Venue not found." }, { status: 404 });
  return venueId;
}

/**
 * The venue's booking rules for the "before you book" box (lib/booking-terms.ts),
 * whether this account said not to show them again, and its own strikes here.
 * A guest's strikes are not told: a phone number typed in is not proof of whose it is.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const venueId = await venueOf(req, (await params).id);
  if (venueId instanceof NextResponse) return venueId;
  // For the sport being booked, where its rules differ from the venue's.
  const sport = req.nextUrl.searchParams.get("sport");
  const terms = await bookingTerms(venueId, sport && SPORTS.includes(sport as Sport) ? (sport as Sport) : undefined);
  if (!terms) return NextResponse.json({ error: "Venue not found." }, { status: 404 });
  const user = await getSessionUser(req);
  return NextResponse.json({
    terms,
    dismissed: user ? (await dismissedVersion(user.id, venueId)) === terms.version : null,
    you: user ? await standing(venueId, user.phone) : null,
  });
}

/** `{ version }`: this account has read these rules; do not show them again until they change. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const venueId = await venueOf(req, (await params).id);
  if (venueId instanceof NextResponse) return venueId;
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { version?: unknown } | null;
  if (typeof body?.version !== "string") return NextResponse.json({ error: "version is required." }, { status: 400 });
  await dismissTerms(user.id, venueId, body.version);
  return NextResponse.json({ ok: true });
}
