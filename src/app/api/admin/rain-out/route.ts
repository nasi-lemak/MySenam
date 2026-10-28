import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { logAction, logCancelledBookings, logClassCancelled } from "@/lib/activity";
import type { Booking } from "@/lib/types";
import { rainOut } from "@/lib/rain-outs";
import { formatMinute } from "@/lib/interval";
import { readMinute } from "@/lib/api";

export const dynamic = "force-dynamic";

/**
 * `{ venueId, courtIds, date, fromMin, untilMin, reason?, reasonPreset?, preview? }`
 * (minutes of the day or HH:MM; `fromHour`/`untilHour` the older form):
 * rained off (lib/rain-outs.ts). `reasonPreset: "rained_off"` (or no reason)
 * tells each customer the built-in reason in their own language; a `reason`
 * without it is sent as typed. With `preview`, only what it would call off.
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
    fromMin: readMinute(body, "fromMin", "fromHour"),
    untilMin: readMinute(body, "untilMin", "untilHour"),
    reason: typeof body.reason === "string" ? body.reason : undefined,
    reasonPreset: typeof body.reasonPreset === "string" ? body.reasonPreset : undefined,
    preview: body.preview === true,
  });
  if (!result.ok) return NextResponse.json(result, { status: 400 });
  const { classesOff, ...shown } = result;
  if (body.preview !== true) {
    await logAction(admin, {
      venueId: body.venueId as number,
      action: "booking.cancelled",
      detail: `Rained off ${body.date} ${formatMinute(readMinute(body, "fromMin", "fromHour"))}–${formatMinute(readMinute(body, "untilMin", "untilHour"))}: ${result.bookings.length} booking(s), ${result.classes} class(es) called off`,
    });
    // And each one under its own code, as a closed day's are.
    const why = `rained off ${String(body.date)}`;
    for (const c of classesOff ?? []) await logClassCancelled(admin, c.session, c.enrolments, why);
    await logCancelledBookings(admin, body.venueId as number, result.bookings as Booking[], why);
  }
  return NextResponse.json(shown);
}
