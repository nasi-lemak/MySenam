import { NextRequest, NextResponse } from "next/server";
import { refusal } from "@/lib/api";
import { rateLimit } from "@/lib/rate-limit";
import { cancelSeries, getBookingById } from "@/lib/store";
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
  const { seriesCode, phone } = (body ?? {}) as Record<string, unknown>;
  if (typeof seriesCode !== "string" || typeof phone !== "string")
    return NextResponse.json({ error: "seriesCode and phone are required." }, { status: 400 });

  const limited = await rateLimit(req, "bookingLookup");
  if (limited) return limited;

  const result = await cancelSeries(seriesCode, phone);
  if (!result.ok) return refusal(result);
  const refunds = await refundCancelled(result.bookingIds);
  const cancelled = (await Promise.all(result.bookingIds.map((id) => getBookingById(id)))).filter((b): b is NonNullable<typeof b> => b !== null);
  await notifySeriesCancelled(cancelled, await currentLocale(), { refunds });
  await tickOutbox();
  return NextResponse.json({ cancelled: result.cancelled, refunds });
}
