import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { addonById, listAddons, readAddonInput, updateAddon } from "@/lib/addons";

export const dynamic = "force-dynamic";

async function owned(req: NextRequest, rawId: string) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const addon = await addonById(Number(rawId));
  if (!addon) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return denyVenue(admin, addon.venueId) ?? addon;
}

/** Change it, or retire it with `active: false` and bring it back with `true`. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const addon = await owned(req, (await params).id);
  if (addon instanceof NextResponse) return addon;
  let b: Record<string, unknown>;
  try {
    b = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const changed = await updateAddon(addon.id, readAddonInput({ ...addon, ...b }));
  if (!changed.ok) return NextResponse.json({ error: changed.error }, { status: 400 });
  return NextResponse.json({ addon: changed.value, addons: await listAddons(addon.venueId) });
}

/** Retired, not deleted: bookings that had it still say what they had. */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const addon = await owned(req, (await params).id);
  if (addon instanceof NextResponse) return addon;
  await updateAddon(addon.id, { ...addon, active: false });
  return NextResponse.json({ addons: await listAddons(addon.venueId) });
}
