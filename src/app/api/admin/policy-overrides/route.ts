import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { logAction } from "@/lib/activity";
import { refusal } from "@/lib/api";
import { OVERRIDABLE, POLICY_NAMES, setVenueOverrides, venueOverrides } from "@/lib/policy-overrides";

export const dynamic = "force-dynamic";

/**
 * Which of the venue's policies its managers may override for one booking at
 * the counter (lib/policy-overrides.ts; ADR 0026). Reading it is any of the
 * venue's staff's (the desk is told to ask a manager); changing it is a
 * manager's (lib/roles.ts `MANAGER_ONLY`).
 */

/** `?venueId` → `{ policies, overridable }`: those turned on, and every one that can be. */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(req.nextUrl.searchParams.get("venueId"));
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  return NextResponse.json({ policies: await venueOverrides(venueId), overridable: OVERRIDABLE });
}

/** `{ venueId, policies: [...] }` → the policies turned on now; none is off (every one starts off). */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const venueId = Number(body.venueId);
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const set = await setVenueOverrides(venueId, body.policies, admin.id);
  if (!set.ok) return refusal(set, 400);
  const on = set.policies.filter((p) => !set.before.includes(p));
  const off = set.before.filter((p) => !set.policies.includes(p));
  if (on.length > 0 || off.length > 0)
    await logAction(admin, {
      venueId,
      action: "settings.changed",
      detail: `Manager overrides: ${[...on.map((p) => `allowed ${POLICY_NAMES[p]}`), ...off.map((p) => `stopped ${POLICY_NAMES[p]}`)].join("; ")}`,
    });
  return NextResponse.json({ policies: set.policies, overridable: OVERRIDABLE });
}
