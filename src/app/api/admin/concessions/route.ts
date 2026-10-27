import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { logFromRequest } from "@/lib/activity";
import { listConcessions, retireConcession, saveConcession } from "@/lib/concessions";

export const dynamic = "force-dynamic";

async function venueOf(req: NextRequest, raw: unknown) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(raw);
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  return denyVenue(admin, venueId) ?? venueId;
}

/** `?venueId` → the concession prices offered here (lib/concessions.ts). */
export async function GET(req: NextRequest) {
  const venueId = await venueOf(req, req.nextUrl.searchParams.get("venueId"));
  if (venueId instanceof NextResponse) return venueId;
  return NextResponse.json({ concessions: await listConcessions(venueId) }, { headers: { "Cache-Control": "no-store" } });
}

/**
 * `{ venueId, id?, name, percent, proof, sport?, offPeakOnly?, preset?, scope? }`: offer one, or
 * change it (managers). `preset` (student, senior, child, oku) is kept while the name
 * and proof are that preset's own words, so customers read it in their language.
 * `scope`: `booking` (the whole booking, the default) or `participant` (one
 * person's place on a booking priced by the place; lib/entitlements.ts).
 */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const venueId = await venueOf(req, body.venueId);
  if (venueId instanceof NextResponse) return venueId;
  const saved = await saveConcession(venueId, body);
  if (!saved.ok) return NextResponse.json(saved, { status: 400 });
  const c = saved.concession;
  await logFromRequest(req, {
    venueId,
    action: "settings.changed",
    detail: `Concession price: ${c.name}, ${c.percent}% off${c.sport ? ` (${c.sport})` : ""}${c.offPeakOnly ? ", off-peak only" : ""}${c.scope === "participant" ? ", one person's place" : ""}`,
  });
  return NextResponse.json({ concession: c });
}

/** `?venueId&id`: no longer offered (managers). */
export async function DELETE(req: NextRequest) {
  const venueId = await venueOf(req, req.nextUrl.searchParams.get("venueId"));
  if (venueId instanceof NextResponse) return venueId;
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!Number.isInteger(id) || !(await retireConcession(venueId, id)))
    return NextResponse.json({ error: "That concession is not offered here." }, { status: 404 });
  await logFromRequest(req, { venueId, action: "settings.changed", detail: `Concession price ${id} withdrawn` });
  return NextResponse.json({ ok: true });
}
