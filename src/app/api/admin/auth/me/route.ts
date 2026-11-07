import { NextRequest, NextResponse } from "next/server";
import { getSessionAdmin } from "@/lib/admin-auth";
import { isOwner } from "@/lib/admin-auth";
import { listVenues, listVenuesByIds } from "@/lib/store";
import { pruneIfDue } from "@/lib/privacy";
import { hasTwoFactor, twoFactorRequired, twoFactorStatus } from "@/lib/two-factor";
import { staffMay } from "@/lib/roles";

export const dynamic = "force-dynamic";

let lastFailedAt = 0;
async function houseKeep(): Promise<void> {
  if (Date.now() - lastFailedAt < 3_600_000) return;
  try {
    await pruneIfDue();
  } catch (err) {
    lastFailedAt = Date.now();
    console.error("[mysenam] applying the retention policy on a dashboard load failed:", err);
    try {
      const { raiseAlert } = await import("@/lib/alerts");
      await raiseAlert("scheduler:retention-failed", "Scheduled work failed: applying the retention policy", err instanceof Error ? err.stack ?? err.message : String(err));
    } catch {
      // The alert is a courtesy; the dashboard still opens.
    }
  }
}

export async function GET(req: NextRequest) {
  const admin = await getSessionAdmin(req);
  if (!admin) return NextResponse.json({ admin: null, venues: [] });

  // An account the install requires two-factor sign-in of, before it has set it up, is told only that (its name and what to do): no
  // venues, and no housekeeping on its behalf. It is signed in to enrol and nothing else (lib/admin-auth.ts `requireAdmin`, ADR 0064).
  if (twoFactorRequired(admin) && !(await hasTwoFactor(admin.id)))
    return NextResponse.json({ admin, venues: [], twoFactor: await twoFactorStatus(admin), canManage: false, may: staffMay("desk") });

  // Housekeeping, on the way past. There is no scheduler in this system, so
  // the retention policy applies itself the first time staff open the
  // dashboard each day — and a venue nobody opens is a venue accumulating
  // nothing either.
  // It must never be the reason a dashboard does not open: a failure is logged and the owners told, and the
  // heavy attempt is not repeated on every load (an hour apart at most, per process).
  await houseKeep();

  // Only the venues this admin may manage: every one for the platform owner,
  // and for anybody else their own, read on its own rather than picked out
  // of every venue there is.
  const venues = isOwner(admin) ? await listVenues() : await listVenuesByIds(admin.venueIds ?? []);
  // What the dashboard may offer this account, as lib/roles.ts answers it: `may` for each control it asks about.
  return NextResponse.json({
    admin,
    venues,
    twoFactor: await twoFactorStatus(admin),
    canManage: admin.role !== "desk",
    may: staffMay(admin.role),
  });
}
