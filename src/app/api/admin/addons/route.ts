import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { createAddon, listAddons, readAddonInput } from "@/lib/addons";
import { jsonObject } from "@/lib/api";

export const dynamic = "force-dynamic";

/** `?venueId=` — every extra a venue has, retired ones last. */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(req.nextUrl.searchParams.get("venueId"));
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "Which venue?" }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  return NextResponse.json({ addons: await listAddons(venueId) });
}

/** `{ venueId, name, kind: "rental" | "sale", price, stock?, sport? }` */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  let b: Record<string, unknown>;
  try {
    b = (await jsonObject(req)) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const venueId = Number(b.venueId);
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "Which venue?" }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const made = await createAddon(venueId, readAddonInput(b));
  if (!made.ok) return NextResponse.json({ error: made.error }, { status: 400 });
  return NextResponse.json({ addon: made.value, addons: await listAddons(venueId) }, { status: 201 });
}
