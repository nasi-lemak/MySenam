import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { listOnlinePayments, markRefunded, refundsOwed } from "@/lib/payments";

export const dynamic = "force-dynamic";

/** `?venueId=` → the venue's recent online payments, and what it owes back. */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(req.nextUrl.searchParams.get("venueId"));
  if (!Number.isInteger(venueId) || venueId <= 0)
    return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  return NextResponse.json({
    payments: await listOnlinePayments(venueId),
    refundsOwed: await refundsOwed(venueId),
  });
}

/** `{ venueId, paymentId }` → staff have refunded it in the gateway. */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { venueId, paymentId } = (body ?? {}) as Record<string, unknown>;
  if (!Number.isInteger(venueId) || !Number.isInteger(paymentId))
    return NextResponse.json({ error: "venueId and paymentId are required." }, { status: 400 });
  const denied = denyVenue(admin, venueId as number);
  if (denied) return denied;
  const result = await markRefunded(paymentId as number, venueId as number);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  return NextResponse.json({ payment: result.payment });
}
