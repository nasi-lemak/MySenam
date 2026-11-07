import { NextRequest, NextResponse } from "next/server";
import { denyVenue, isOwner, requireAdmin } from "@/lib/admin-auth";
import {
  disputesFor,
  listOnlinePayments,
  markRefunded,
  refundOnline,
  refundsInFlight,
  refundsOwed,
  refundWorkload,
  settleRefundClaims,
} from "@/lib/payments";
import { cancelPolicy } from "@/lib/cancel-policy";
import { gatewayFor } from "@/lib/gateways";
import { paymentsToCheck, reviewPayment } from "@/lib/payment-settlement";
import { schedulerEnabled } from "@/lib/scheduler";
import { money } from "@/lib/region";
import { logAction } from "@/lib/activity";

export const dynamic = "force-dynamic";

/**
 * `?venueId=` → the venue's recent online payments, what it owes back, and
 * the work its refunds by hand have made. `?workload=all` → that work across
 * every venue, for the platform's owner.
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  if (req.nextUrl.searchParams.get("workload") === "all") {
    if (!isOwner(admin)) return NextResponse.json({ error: "Only the platform's owner sees every venue's refunds." }, { status: 403 });
    return NextResponse.json({ workload: await refundWorkload(null) });
  }
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
    // Asked of the gateway and not yet answered, or still going through: neither owed nor done.
    refundsInFlight: await refundsInFlight(venueId),
    disputes: await disputesFor(venueId),
    // Money received and not applied, an excess to pay back, a payment that came after a hold was let go: for staff to look at (ADR 0065).
    paymentsToCheck: await paymentsToCheck(venueId, (id) => gatewayFor(id)?.name ?? id),
    workload: await refundWorkload(venueId),
    refundWithinDays: (await cancelPolicy(venueId)).refundWithinDays,
  });
}

/**
 * `{ venueId, paymentId, note? }` → staff have refunded it themselves (in the
 * gateway's dashboard, by transfer), with the reference they wrote down.
 * `{ venueId, paymentId, through: "gateway" }` → refund it now, through the
 * gateway's API with the venue's account.
 * `{ venueId, paymentId, action: "review", note? }` → staff have looked at a
 * payment on the list of payments to check (`paymentsToCheck`); money owed on
 * it stays under Refunds owed until it is refunded.
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
  const { venueId, paymentId, through, note, action } = (body ?? {}) as Record<string, unknown>;
  if (!Number.isInteger(venueId) || !Number.isInteger(paymentId))
    return NextResponse.json({ error: "venueId and paymentId are required." }, { status: 400 });
  const denied = denyVenue(admin, venueId as number);
  if (denied) return denied;
  if (action === "review") {
    const reviewed = await reviewPayment(paymentId as number, venueId as number, admin, typeof note === "string" ? note : null);
    return reviewed.ok ? NextResponse.json({ ok: true }) : NextResponse.json({ error: reviewed.error }, { status: reviewed.status });
  }
  const owed = (await refundsOwed(venueId as number)).find((p) => p.id === paymentId);
  const byApi = through === "gateway";
  const result = byApi
    ? await refundOnline(paymentId as number, venueId as number, admin.id)
    : await markRefunded(paymentId as number, venueId as number, admin.id, typeof note === "string" ? note : null);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  await logAction(admin, {
    venueId: venueId as number,
    action: "payment.refunded",
    detail: `Online payment ${paymentId}${owed ? `, ${money(owed.refundOwed)} to ${owed.payerName ?? "the payer"}` : ""}${
      byApi ? `, through ${result.payment.providerName}` : `, by hand${typeof note === "string" && note.trim() ? ` (${note.trim().slice(0, 200)})` : ""}`
    }`,
  });
  return NextResponse.json({ payment: result.payment, pending: result.pending });
}
