import { NextRequest, NextResponse } from "next/server";
import { submitEnquiry } from "@/lib/enquiries";
import { currentLocale } from "@/lib/locale";
import { mayShowVenue } from "@/lib/listing";
import { tickOutbox } from "@/lib/notify";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * `{ name, phone, email?, kind, wantedOn?, people?, message }`: a private hire
 * enquiry from the venue's page, passed to its staff (lib/enquiries.ts).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const venueId = Number((await params).id);
  if (!Number.isInteger(venueId) || venueId <= 0 || !(await mayShowVenue(venueId, req)).show)
    return NextResponse.json({ error: "Venue not found." }, { status: 404 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  // A field no person sees: a form that fills it in is a script.
  if (typeof body.website === "string" && body.website !== "") return NextResponse.json({ ok: true }, { status: 201 });
  const limited = await rateLimit(req, "enquiry");
  if (limited) return limited;
  // The language the page was in, so staff can answer in it.
  const done = await submitEnquiry(venueId, body, await currentLocale());
  if (!done.ok) return NextResponse.json(done, { status: 400 });
  await tickOutbox();
  return NextResponse.json({ ok: true }, { status: 201 });
}
