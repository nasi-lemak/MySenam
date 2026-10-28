import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { asStaff } from "@/lib/acting-staff";
import { logAction } from "@/lib/activity";
import { readJsonObject, refusal } from "@/lib/api";
import { isOwedOutcome, OWED_REFUSALS, owedRefund, settleOwed } from "@/lib/counter-refunds";
import { money } from "@/lib/region";
import { PAID_VIA_LABELS } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * A counter payment owed back on a booking the venue cancelled (a closed day,
 * a court out of service, a rain-out, its API key; lib/counter-refunds.ts),
 * settled: `{id, outcome: "back"}` handed back at the counter the way it was
 * paid, or `{id, outcome: "credit"}` as stored credit on the account it was
 * booked from. The list is `owed` on `GET /api/admin/bookings`.
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const body = await readJsonObject(req);
  if (body instanceof NextResponse) return body;
  const { id, outcome } = body;
  if (typeof id !== "number" || !Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "id is required." }, { status: 400 });
  if (!isOwedOutcome(outcome)) return NextResponse.json({ error: "outcome must be back or credit." }, { status: 400 });

  const owed = await owedRefund(id, admin.role);
  if (!owed) return NextResponse.json({ error: OWED_REFUSALS.notFound }, { status: 404 });
  const denied = denyVenue(admin, owed.venueId);
  if (denied) return denied;

  // As the member of staff, so the credit note says who gave the money back (lib/acting-staff.ts) and the cash-up counts it.
  const done = await asStaff(admin, () => settleOwed(id, outcome, admin));
  if (!done.ok) return refusal(done);
  const { settled } = done;
  if (outcome === "back") {
    const via = settled.paidOut?.via ?? owed.via;
    await logAction(admin, {
      venueId: owed.venueId,
      action: "payment.paid_out",
      bookingCode: owed.bookingCode,
      detail: `${money(settled.paidOut?.amount ?? owed.amount)} handed back at the counter${via ? `, by ${PAID_VIA_LABELS[via]}` : ""}, owed since the venue cancelled it (${owed.cause})`,
    });
  }
  else
    await logAction(admin, {
      venueId: owed.venueId,
      action: "payment.owed_credited",
      bookingCode: owed.bookingCode,
      detail: `${money(settled.credited ?? owed.amount)} given as stored credit, owed since the venue cancelled it (${owed.cause})`,
    });
  return NextResponse.json({ owed: done.owed, settled });
}
