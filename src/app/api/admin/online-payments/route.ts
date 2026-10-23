import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { disputesFor, listOnlinePayments, markRefunded, refundOnline, refundsOwed, settleRefundClaims } from "@/lib/payments";
import { schedulerEnabled } from "@/lib/scheduler";
import { money } from "@/lib/region";
import { logAction } from "@/lib/activity";

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
  // Without the scheduler, a refund interrupted mid-call is settled when staff look at what is owed.
  if (!schedulerEnabled()) await settleRefundClaims().catch(() => 0);
  return NextResponse.json({
    payments: await listOnlinePayments(venueId),
    refundsOwed: await refundsOwed(venueId),
    disputes: await disputesFor(venueId),
  });
}

/**
 * `{ venueId, paymentId }` → staff have refunded it in the gateway.
 * `{ venueId, paymentId, through: "gateway" }` → refund it now, through the
 * gateway's API with the venue's account.
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { venueId, paymentId, through } = (body ?? {}) as Record<string, unknown>;
  if (!Number.isInteger(venueId) || !Number.isInteger(paymentId))
    return NextResponse.json({ error: "venueId and paymentId are required." }, { status: 400 });
  const denied = denyVenue(admin, venueId as number);
  if (denied) return denied;
  const owed = (await refundsOwed(venueId as number)).find((p) => p.id === paymentId);
  const byApi = through === "gateway";
  const result = byApi
    ? await refundOnline(paymentId as number, venueId as number, admin.id)
    : await markRefunded(paymentId as number, venueId as number, admin.id);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  await logAction(admin, {
    venueId: venueId as number,
    action: "payment.refunded",
    detail: `Online payment ${paymentId}${owed ? `, ${money(owed.refundOwed)} to ${owed.payerName ?? "the payer"}` : ""}${
      byApi ? `, through ${result.payment.providerName}` : ", in the gateway"
    }`,
  });
  return NextResponse.json({ payment: result.payment, pending: result.pending });
}
