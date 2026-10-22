import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { logAction } from "@/lib/activity";
import { rainOut } from "@/lib/rain-outs";
import { formatHour } from "@/lib/time";

export const dynamic = "force-dynamic";

/**
 * `{ venueId, courtIds, date, fromHour, untilHour, reason?, preview? }`:
 * rained off (lib/rain-outs.ts). With `preview`, only what it would call off.
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || !Number.isInteger(body.venueId)) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, body.venueId as number);
  if (denied) return denied;
  const courtIds = Array.isArray(body.courtIds) ? body.courtIds.filter((c): c is number => Number.isInteger(c)) : [];
  const result = await rainOut({
    venueId: body.venueId as number,
    courtIds,
    date: String(body.date ?? ""),
    fromHour: Number(body.fromHour),
    untilHour: Number(body.untilHour),
    reason: typeof body.reason === "string" ? body.reason : undefined,
    preview: body.preview === true,
  });
  if (!result.ok) return NextResponse.json(result, { status: 400 });
  if (body.preview !== true)
    await logAction(admin, {
      venueId: body.venueId as number,
      action: "booking.cancelled",
      detail: `Rained off ${body.date} ${formatHour(Number(body.fromHour))}–${formatHour(Number(body.untilHour))}: ${result.bookings.length} booking(s), ${result.classes} class(es) called off`,
    });
  return NextResponse.json(result);
}
