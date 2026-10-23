import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { peakRules, setLastMinute, setPeakRules, upcomingHolidays } from "@/lib/peak";
import { formatMinute } from "@/lib/interval";
import { readMinute } from "@/lib/api";
import { logFromRequest } from "@/lib/activity";

export const dynamic = "force-dynamic";

async function venueOf(req: NextRequest, raw: unknown) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(raw);
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  return denyVenue(admin, venueId) ?? venueId;
}

/** `?venueId` → when the venue's peak rates apply, and its holidays from today. */
export async function GET(req: NextRequest) {
  const venueId = await venueOf(req, req.nextUrl.searchParams.get("venueId"));
  if (venueId instanceof NextResponse) return venueId;
  const { holidays: _, ...rules } = await peakRules(venueId);
  return NextResponse.json({ rules, holidays: await upcomingHolidays(venueId) });
}

const DAY = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const span = (from: number, until: number) => (from === until ? "none" : `${formatMinute(from)}–${formatMinute(until)}`);

/**
 * `{ venueId, weekdayFrom, weekdayUntil, weekendDays, weekendFrom, weekendUntil }`
 * (each time in minutes of the day, or HH:MM; peak may start and end on any minute),
 * or `{ venueId, lastMinute: { hours, percent, offPeakOnly } | { off: true } }`.
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const venueId = await venueOf(req, body.venueId);
  if (venueId instanceof NextResponse) return venueId;
  if (body.lastMinute && typeof body.lastMinute === "object") {
    const set = await setLastMinute(venueId, body.lastMinute as Record<string, unknown>);
    if (!set.ok) return NextResponse.json(set, { status: 400 });
    const lm = set.lastMinute;
    await logFromRequest(req, {
      venueId,
      action: "settings.changed",
      detail: lm ? `Last-minute: ${lm.percent}% off within ${lm.hours}h${lm.offPeakOnly ? ", off-peak only" : ""}` : "Last-minute prices off",
    });
    const { holidays: _, ...rules } = await peakRules(venueId);
    return NextResponse.json({ rules });
  }
  const times = Object.fromEntries(
    (["weekdayFrom", "weekdayUntil", "weekendFrom", "weekendUntil"] as const).map((k) => [k, readMinute(body, k)])
  );
  const result = await setPeakRules(venueId, { ...body, ...times });
  if (!result.ok) return NextResponse.json(result, { status: 400 });
  const r = result.rules;
  await logFromRequest(req, {
    venueId,
    action: "settings.changed",
    detail: `Peak: weekdays ${span(r.weekdayFrom, r.weekdayUntil)}; ${r.weekendDays.map((d) => DAY[d]).join("/") || "no weekend"} ${span(r.weekendFrom, r.weekendUntil)}`,
  });
  const { holidays: _, ...rules } = r;
  return NextResponse.json({ rules });
}
