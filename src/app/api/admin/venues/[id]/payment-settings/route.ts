import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { paymentSettings, removePaymentSettings, savePaymentSettings } from "@/lib/payments";
import { logFromRequest } from "@/lib/activity";

export const dynamic = "force-dynamic";

async function venueFor(
  req: NextRequest,
  params: Promise<{ id: string }>
): Promise<number | NextResponse> {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number((await params).id);
  if (!Number.isInteger(venueId) || venueId <= 0)
    return NextResponse.json({ error: "Invalid venue id." }, { status: 400 });
  return denyVenue(admin, venueId) ?? venueId;
}

/** The venue's gateway account as staff may see it: never the keys. */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const venueId = await venueFor(req, params);
  if (venueId instanceof NextResponse) return venueId;
  return NextResponse.json({ settings: await paymentSettings(venueId) });
}

export async function PUT(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const venueId = await venueFor(req, params);
  if (venueId instanceof NextResponse) return venueId;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { apiKey, collectionId, xSignatureKey, sandbox, enabled } = (body ?? {}) as Record<
    string,
    unknown
  >;
  if (typeof collectionId !== "string")
    return NextResponse.json({ error: "collectionId is required." }, { status: 400 });
  for (const [name, value] of [
    ["apiKey", apiKey],
    ["xSignatureKey", xSignatureKey],
  ] as const)
    if (value !== undefined && value !== "" && (typeof value !== "string" || value.length > 200))
      return NextResponse.json({ error: `${name} must be text.` }, { status: 400 });

  const result = await savePaymentSettings(venueId, {
    apiKey: typeof apiKey === "string" && apiKey !== "" ? apiKey : undefined,
    collectionId,
    xSignatureKey: typeof xSignatureKey === "string" && xSignatureKey !== "" ? xSignatureKey : undefined,
    sandbox: sandbox === true,
    enabled: enabled !== false,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  await logFromRequest(req, { venueId, action: "settings.changed", detail: "Online payment account saved" });
  return NextResponse.json({ settings: result.settings });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const venueId = await venueFor(req, params);
  if (venueId instanceof NextResponse) return venueId;
  await removePaymentSettings(venueId);
  return NextResponse.json({ settings: await paymentSettings(venueId) });
}
