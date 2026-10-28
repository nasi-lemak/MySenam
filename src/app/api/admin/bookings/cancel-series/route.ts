import { NextRequest, NextResponse } from "next/server";
import { canAccessVenue, requireAdmin } from "@/lib/admin-auth";
import { refusal } from "@/lib/api";
import { logAction } from "@/lib/activity";
import { getDb } from "@/lib/db";
import { isLocale } from "@/lib/i18n";
import { notifySeriesCancelled, tickOutbox } from "@/lib/notify";
import { refundCancelled } from "@/lib/payments";
import { money } from "@/lib/region";
import { isCancelOutcome, logCancelled, previewStaffSeries, seriesVenueIds, staffCancelSeries } from "@/lib/counter-refunds";

export const dynamic = "force-dynamic";

/**
 * Staff cancel weeks of a weekly series (lib/counter-refunds.ts).
 * `{seriesCode, preview: true}` lists each upcoming week with its own terms
 * and ways to settle it; `{seriesCode, codes, outcome, expect}` cancels the
 * weeks chosen, each on its terms, settled as chosen where the week allows it.
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
  const { seriesCode, preview, codes, outcome, expect } = (body ?? {}) as Record<string, unknown>;
  if (typeof seriesCode !== "string" || seriesCode.trim() === "")
    return NextResponse.json({ error: "seriesCode is required." }, { status: 400 });
  const venueIds = await seriesVenueIds(seriesCode);
  if (venueIds.length === 0) return NextResponse.json({ error: "Series not found." }, { status: 404 });
  if (!venueIds.every((id) => canAccessVenue(admin, id)))
    return NextResponse.json({ error: "You do not manage that venue." }, { status: 403 });

  if (preview === true) {
    const plan = await previewStaffSeries(seriesCode, admin.role);
    if (!plan.ok) return refusal(plan, 404);
    return NextResponse.json({ weeks: plan.weeks });
  }

  if (!Array.isArray(codes) || !codes.every((c) => typeof c === "string"))
    return NextResponse.json({ error: "codes must be a list of booking codes." }, { status: 400 });
  if (outcome !== undefined && !isCancelOutcome(outcome))
    return NextResponse.json({ error: "outcome must be back, credit or keep." }, { status: 400 });
  const expected =
    expect !== undefined && expect !== null && typeof expect === "object" && Object.values(expect).every((v) => typeof v === "number" && Number.isFinite(v))
      ? (expect as Record<string, number>)
      : undefined;
  if (expect !== undefined && !expected) return NextResponse.json({ error: "expect must map booking codes to amounts." }, { status: 400 });

  const result = await staffCancelSeries(seriesCode, codes as string[], admin, {
    ...(outcome !== undefined ? { outcome } : {}),
    ...(expected ? { expect: expected } : {}),
  });
  if (!result.ok) return refusal(result);
  const ids = result.cancelled.map((c) => c.booking.id);
  // Paid online: owed back on the payment now, to the card where the venue refunds through its gateway.
  const refunds = await refundCancelled(ids, { byVenue: true });
  for (const c of result.cancelled) await logCancelled(admin, venueIds[0], c.booking, c.settled);
  if (result.cancelled.length > 0) {
    const back = result.cancelled.reduce((sum, c) => sum + (c.settled?.refund ?? 0), 0);
    await logAction(admin, {
      venueId: venueIds[0],
      action: "booking.series_cancelled",
      bookingCode: seriesCode.trim().toUpperCase(),
      detail: `${result.cancelled.length} week(s): ${result.cancelled.map((c) => c.booking.code).join(", ")}${back > 0 ? `; ${money(back)} back` : ""}${
        result.left.length > 0 ? `; left: ${result.left.map((l) => l.code).join(", ")}` : ""
      }`,
    });
    // One message for the weeks cancelled, in the language the series was booked in.
    const first = result.cancelled[0].booking;
    const row = (await getDb().prepare("SELECT locale FROM bookings WHERE id = ?").get(first.id)) as { locale: string | null } | undefined;
    await notifySeriesCancelled(
      result.cancelled.map((c) => c.booking),
      row?.locale && isLocale(row.locale) ? row.locale : "en",
      { refunds }
    );
    await tickOutbox();
  }
  return NextResponse.json({
    cancelled: result.cancelled.map((c) => ({ code: c.booking.code, settled: c.settled })),
    left: result.left,
    refunds,
  });
}
