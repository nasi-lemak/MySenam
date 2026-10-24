import { NextRequest, NextResponse } from "next/server";
import { refusal } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { cancelSeries, getBookingById, seriesCancelPlan } from "@/lib/store";
import { notifySeriesCancelled, tickOutbox } from "@/lib/notify";
import { currentLocale } from "@/lib/locale";
import { refundCancelled } from "@/lib/payments";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { seriesCode, phone, preview, codes, acceptLate } = (body ?? {}) as Record<string, unknown>;
  if (typeof seriesCode !== "string" || typeof phone !== "string")
    return NextResponse.json({ error: "seriesCode and phone are required." }, { status: 400 });
  const list = (v: unknown) => (Array.isArray(v) && v.every((c) => typeof c === "string") ? (v as string[]) : null);
  if (codes !== undefined && list(codes) === null)
    return NextResponse.json({ error: "codes must be a list of booking codes." }, { status: 400 });
  if (acceptLate !== undefined && list(acceptLate) === null)
    return NextResponse.json({ error: "acceptLate must be a list of booking codes." }, { status: 400 });

  const limited = await rateLimit(req, "bookingLookup");
  if (limited) return limited;

  // What cancelling each upcoming week would do, before anything is done.
  if (preview === true) {
    const plan = await seriesCancelPlan(seriesCode, phone);
    if (!plan.ok) return refusal(plan);
    return NextResponse.json({ weeks: plan.weeks });
  }

  // The weeks chosen, late ones only on the terms accepted; without a choice, only those free to cancel.
  const result = await cancelSeries(
    seriesCode,
    phone,
    codes !== undefined ? { codes: list(codes)!, acceptLate: list(acceptLate) ?? [] } : undefined
  );
  if (!result.ok) return refusal(result);
  const refunds = await refundCancelled(result.bookingIds);
  const cancelled = (await Promise.all(result.bookingIds.map((id) => getBookingById(id)))).filter((b): b is NonNullable<typeof b> => b !== null);
  await notifySeriesCancelled(cancelled, await currentLocale(), { refunds });
  await tickOutbox();
  return NextResponse.json({ cancelled: result.cancelled, refunds, weeks: result.weeks, left: result.left });
}
