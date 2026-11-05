import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { logAction } from "@/lib/activity";
import { jsonObject } from "@/lib/api";
import { saveWindowSettings, windowOverrideAlert, windowOverridesReport, windowSettings } from "@/lib/window-overrides";

export const dynamic = "force-dynamic";

const venueIdOf = (v: unknown): number | null => {
  const n = typeof v === "string" ? Number(v) : v;
  return typeof n === "number" && Number.isInteger(n) && n > 0 ? n : null;
};

/**
 * `?venueId[&days]` → the venue's overrides of advisory launch and tide windows (lib/window-overrides.ts; ADR 0046) from the last `days`
 * days (30 by default, up to 366), newest first, with who, when, why, which window; the venue's settings (whether its managers may
 * override, the shortest reason, the weekly alert) and the count in the last 7 days against the alert. A manager's report (lib/roles.ts
 * `MANAGER_ONLY`: front desk is turned away).
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = venueIdOf(req.nextUrl.searchParams.get("venueId"));
  if (venueId === null) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const asked = Number(req.nextUrl.searchParams.get("days") ?? 30);
  const days = Number.isInteger(asked) && asked >= 1 && asked <= 366 ? asked : 30;
  const [settings, overrides, alert] = await Promise.all([windowSettings(venueId), windowOverridesReport(venueId, days), windowOverrideAlert(venueId)]);
  return NextResponse.json({ settings, overrides, days, alert }, { headers: { "Cache-Control": "no-store" } });
}

/**
 * A manager changes the venue's settings for the override: `{ venueId, enabled?, reasonMin?, weeklyAlert? }`. `enabled` false turns the
 * override off for the venue (managers may override by default); `reasonMin` is the shortest reason in characters (3 to 300; null takes
 * the install's, 15), `weeklyAlert` the number of overrides in 7 days past which a needs-attention line is raised (0 is none; null takes the
 * install's, 5). In the activity log.
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  let b: Record<string, unknown>;
  try {
    b = await jsonObject(req);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const venueId = venueIdOf(b.venueId);
  if (venueId === null) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const saved = await saveWindowSettings(venueId, { enabled: b.enabled, reasonMin: b.reasonMin, weeklyAlert: b.weeklyAlert }, admin.id);
  if (!saved.ok) return NextResponse.json({ error: saved.error }, { status: 400 });
  const changes: string[] = [];
  if (saved.before.enabled !== saved.settings.enabled) changes.push(saved.settings.enabled ? "allowed managers to override advisory windows" : "stopped managers overriding advisory windows");
  if (saved.before.reasonMin !== saved.settings.reasonMin) changes.push(`shortest reason ${saved.settings.reasonMin} characters`);
  if (saved.before.weeklyAlert !== saved.settings.weeklyAlert) changes.push(saved.settings.weeklyAlert === 0 ? "no weekly alert" : `weekly alert after ${saved.settings.weeklyAlert} overrides`);
  if (changes.length > 0) await logAction(admin, { venueId, action: "settings.changed", detail: `Window overrides: ${changes.join("; ")}` });
  return NextResponse.json({ settings: saved.settings });
}
