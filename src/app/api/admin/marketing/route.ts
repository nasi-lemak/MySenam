import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { logAction } from "@/lib/activity";
import { audience, sendCampaign, testCampaign } from "@/lib/marketing";

export const dynamic = "force-dynamic";

/** `?venueId=` → how many agreed to hear from the venue, how many stopped, and what it has sent. */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(req.nextUrl.searchParams.get("venueId"));
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  return NextResponse.json(await audience(venueId));
}

/** `{ venueId, action: "test" | "send", subject, body }`: a copy to yourself, or the real thing (lib/marketing.ts). */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || !Number.isInteger(body.venueId)) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const venueId = body.venueId as number;
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const input = { subject: body.subject, body: body.body };
  if (body.action === "test") {
    const sent = await testCampaign(venueId, admin.email, input);
    return sent.ok ? NextResponse.json({ sentTo: admin.email }) : NextResponse.json({ error: sent.error }, { status: 400 });
  }
  if (body.action !== "send") return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  const sent = await sendCampaign(venueId, admin.id, input);
  if (!sent.ok) return NextResponse.json({ error: sent.error }, { status: 409 });
  await logAction(admin, { venueId, action: "campaign.sent", detail: `"${String(body.subject).slice(0, 80)}" to ${sent.recipients}` });
  return NextResponse.json({ recipients: sent.recipients, ...(await audience(venueId)) });
}
