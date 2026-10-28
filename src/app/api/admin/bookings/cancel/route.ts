import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { getVenueIdForBookingCode } from "@/lib/store";
import { notifyVenueCancelled, tickOutbox } from "@/lib/notify";
import { refusal } from "@/lib/api";
import { refundCancelled } from "@/lib/payments";
import { isCancelOutcome, logCancelled, previewStaffCancel, settledWords, staffCancel } from "@/lib/counter-refunds";

export const dynamic = "force-dynamic";

/**
 * Staff cancel a booking (lib/counter-refunds.ts). `{code, preview: true}`
 * says what was paid and how, the venue's terms, and each way it can be
 * settled; `{code, outcome, expectRefund}` cancels it so: `back` the way it
 * was paid (where not said, as before), `credit` as stored credit, or `keep`
 * the venue's late share.
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
  const { code, preview, outcome, expectRefund } = (body ?? {}) as Record<string, unknown>;
  if (typeof code !== "string" || code.trim() === "")
    return NextResponse.json({ error: "code is required." }, { status: 400 });
  if (outcome !== undefined && !isCancelOutcome(outcome))
    return NextResponse.json({ error: "outcome must be back, credit or keep." }, { status: 400 });
  if (expectRefund !== undefined && (typeof expectRefund !== "number" || !Number.isFinite(expectRefund) || expectRefund < 0))
    return NextResponse.json({ error: "expectRefund must be an amount." }, { status: 400 });

  const venueId = await getVenueIdForBookingCode(code);
  if (venueId === null) return NextResponse.json({ error: "Booking not found." }, { status: 404 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;

  if (preview === true) {
    const seen = await previewStaffCancel(code, admin.role);
    if (!seen.ok) return refusal(seen);
    return NextResponse.json({ preview: seen.preview });
  }

  const { result, settled } = await staffCancel(code, admin, {
    ...(outcome !== undefined ? { outcome } : {}),
    ...(expectRefund !== undefined ? { expectRefund: expectRefund as number } : {}),
  });
  if (!result.ok) return refusal(result);
  // Paid online: it goes back now, as when a customer cancels, rather than waiting on staff.
  await refundCancelled([result.booking.id], { byVenue: true });
  await logCancelled(admin, venueId, result.booking, settled);
  // The customer is told, and the desk sees until they have seen it.
  const notice = await notifyVenueCancelled(result.booking, undefined, undefined, settledWords(settled));
  await tickOutbox();
  return NextResponse.json({ booking: result.booking, noticeId: notice, settled });
}
