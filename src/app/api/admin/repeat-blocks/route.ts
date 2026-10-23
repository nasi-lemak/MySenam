import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { logFromRequest } from "@/lib/activity";
import { endRepeatBlock, listRepeatBlocks, repeatBlock } from "@/lib/repeat-blocks";
import { formatMinute } from "@/lib/interval";
import { readMinute } from "@/lib/api";

export const dynamic = "force-dynamic";

async function venueOf(req: NextRequest, raw: unknown) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(raw);
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  return denyVenue(admin, venueId) ?? venueId;
}

/** `?venueId` → the venue's repeating blocks with weeks still to come (lib/repeat-blocks.ts). */
export async function GET(req: NextRequest) {
  const venueId = await venueOf(req, req.nextUrl.searchParams.get("venueId"));
  if (venueId instanceof NextResponse) return venueId;
  return NextResponse.json({ repeats: await listRepeatBlocks(venueId) }, { headers: { "Cache-Control": "no-store" } });
}

/**
 * `{ venueId, courtIds, from, days, fromMin, untilMin, weeks, reason }`: block
 * that time every week (minutes of the day or HH:MM; `fromHour`/`untilHour`
 * the older form).
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const venueId = await venueOf(req, body.venueId);
  if (venueId instanceof NextResponse) return venueId;
  const numbers = (v: unknown) => (Array.isArray(v) ? v.map(Number) : []);
  const done = await repeatBlock({
    venueId,
    courtIds: numbers(body.courtIds),
    from: String(body.from ?? ""),
    days: numbers(body.days),
    fromMin: readMinute(body, "fromMin", "fromHour"),
    untilMin: readMinute(body, "untilMin", "untilHour"),
    weeks: Number(body.weeks),
    reason: String(body.reason ?? ""),
  });
  if (!done.ok) return NextResponse.json(done, { status: 400 });
  await logFromRequest(req, {
    venueId,
    action: "block.repeated",
    detail: `${String(body.reason)}: ${formatMinute(readMinute(body, "fromMin", "fromHour"))}–${formatMinute(readMinute(body, "untilMin", "untilHour"))} weekly for ${String(body.weeks)} weeks from ${String(body.from)} (${done.code})`,
  });
  return NextResponse.json(done);
}

/** `?venueId&code`: the rest of the run taken off. */
export async function DELETE(req: NextRequest) {
  const venueId = await venueOf(req, req.nextUrl.searchParams.get("venueId"));
  if (venueId instanceof NextResponse) return venueId;
  const code = req.nextUrl.searchParams.get("code") ?? "";
  const removed = await endRepeatBlock(venueId, code);
  if (removed === 0) return NextResponse.json({ error: "Nothing of that is still to come." }, { status: 404 });
  await logFromRequest(req, { venueId, action: "block.repeated", detail: `Repeating block ${code} ended: ${removed} hours freed` });
  return NextResponse.json({ removed });
}
