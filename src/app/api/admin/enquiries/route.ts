import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { logAction } from "@/lib/activity";
import { listEnquiries, setEnquiryStatus } from "@/lib/enquiries";

export const dynamic = "force-dynamic";

async function staffAt(req: NextRequest, raw: unknown) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(raw);
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  return denyVenue(admin, venueId) ?? { admin, venueId };
}

/** The private hire enquiries at the venues this account runs, open ones first (lib/enquiries.ts). */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  return NextResponse.json({ enquiries: await listEnquiries(admin.venueIds) }, { headers: { "Cache-Control": "no-store" } });
}

/** `{ venueId, id, status }`: replied, booked or declined. */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const at = await staffAt(req, body.venueId);
  if (at instanceof NextResponse) return at;
  const enquiry = await setEnquiryStatus(at.venueId, Number(body.id), body.status, at.admin.id);
  if (!enquiry) return NextResponse.json({ error: "No such enquiry here, or no such answer." }, { status: 400 });
  await logAction(at.admin, { venueId: at.venueId, action: "enquiry.handled", detail: `Hire enquiry from ${enquiry.name}: ${enquiry.status}` });
  return NextResponse.json({ enquiry });
}
