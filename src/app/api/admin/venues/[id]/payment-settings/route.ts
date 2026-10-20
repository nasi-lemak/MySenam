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
  // `{ provider, credentials: { … }, sandbox, enabled }`; Billplz's three keys
  // may also come at the top level, as they did before there was a choice.
  const { provider, credentials, apiKey, collectionId, xSignatureKey, sandbox, enabled } = (body ?? {}) as Record<
    string,
    unknown
  >;
  if (provider !== undefined && typeof provider !== "string")
    return NextResponse.json({ error: "provider must be text." }, { status: 400 });
  if (credentials !== undefined && (typeof credentials !== "object" || credentials === null || Array.isArray(credentials)))
    return NextResponse.json({ error: "credentials must be an object." }, { status: 400 });
  const text = (v: unknown) => (typeof v === "string" ? v : undefined);

  const result = await savePaymentSettings(venueId, {
    provider,
    credentials: credentials as Record<string, unknown> | undefined,
    apiKey: text(apiKey),
    collectionId: text(collectionId),
    xSignatureKey: text(xSignatureKey),
    sandbox: sandbox === true,
    enabled: enabled !== false,
    // A wrong key shows up here, not as a customer's failed payment.
    check: true,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  await logFromRequest(req, { venueId, action: "settings.changed", detail: `Online payment account saved (${result.settings.providerName})` });
  return NextResponse.json({ settings: result.settings });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const venueId = await venueFor(req, params);
  if (venueId instanceof NextResponse) return venueId;
  await removePaymentSettings(venueId);
  return NextResponse.json({ settings: await paymentSettings(venueId) });
}
