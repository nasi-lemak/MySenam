import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import type { Admin } from "@/lib/admin-auth";
import { blockPhone, listBlockedPhones, unblockPhone } from "@/lib/limits";

export const dynamic = "force-dynamic";

/** The venue in the path, and the admin, once it is theirs to manage. */
async function scope(
  req: NextRequest,
  params: Promise<{ id: string }>
): Promise<{ admin: Admin; venueId: number } | NextResponse> {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number((await params).id);
  if (!Number.isInteger(venueId) || venueId <= 0)
    return NextResponse.json({ error: "Invalid venue id." }, { status: 400 });
  return denyVenue(admin, venueId) ?? { admin, venueId };
}

async function body(req: NextRequest): Promise<Record<string, unknown> | null> {
  try {
    return (await req.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Numbers this venue does not take online bookings from. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const s = await scope(req, params);
  if (s instanceof NextResponse) return s;
  return NextResponse.json({ blocked: await listBlockedPhones(s.venueId) });
}

/** `{ phone, reason? }` */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const s = await scope(req, params);
  if (s instanceof NextResponse) return s;
  const input = await body(req);
  if (!input || typeof input.phone !== "string")
    return NextResponse.json({ error: "A phone number is required." }, { status: 400 });
  const result = await blockPhone({
    venueId: s.venueId,
    phone: input.phone,
    reason: typeof input.reason === "string" ? input.reason : undefined,
    adminId: s.admin.id,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ blocked: await listBlockedPhones(s.venueId) });
}

/** `{ phone }` */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const s = await scope(req, params);
  if (s instanceof NextResponse) return s;
  const input = await body(req);
  if (!input || typeof input.phone !== "string")
    return NextResponse.json({ error: "A phone number is required." }, { status: 400 });
  await unblockPhone(s.venueId, input.phone);
  return NextResponse.json({ blocked: await listBlockedPhones(s.venueId) });
}
