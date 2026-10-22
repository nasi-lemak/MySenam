import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { logFromRequest } from "@/lib/activity";
import { getDb } from "@/lib/db";
import { currentWaiver, setWaiver } from "@/lib/waivers";

export const dynamic = "force-dynamic";

async function venueOf(req: NextRequest, raw: unknown) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(raw);
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  return denyVenue(admin, venueId) ?? venueId;
}

async function withCount(venueId: number) {
  const waiver = await currentWaiver(venueId);
  const signed = waiver
    ? ((await getDb().prepare("SELECT COUNT(*)::int AS n FROM waiver_signatures WHERE waiver_id = ?").get(waiver.id)) as { n: number }).n
    : 0;
  return { waiver, signed };
}

/** `?venueId` → the waiver in force and how many have agreed to it (lib/waivers.ts). */
export async function GET(req: NextRequest) {
  const venueId = await venueOf(req, req.nextUrl.searchParams.get("venueId"));
  if (venueId instanceof NextResponse) return venueId;
  return NextResponse.json(await withCount(venueId), { headers: { "Cache-Control": "no-store" } });
}

/** `{ venueId, text }`: new words, agreed to afresh; empty for none (managers). */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const venueId = await venueOf(req, body.venueId);
  if (venueId instanceof NextResponse) return venueId;
  const before = await currentWaiver(venueId);
  const saved = await setWaiver(venueId, body.text);
  if (!saved.ok) return NextResponse.json(saved, { status: 400 });
  if (saved.waiver?.id !== before?.id)
    await logFromRequest(req, { venueId, action: "settings.changed", detail: saved.waiver ? "Waiver changed: everybody agrees afresh" : "Waiver taken away" });
  return NextResponse.json(await withCount(venueId));
}
