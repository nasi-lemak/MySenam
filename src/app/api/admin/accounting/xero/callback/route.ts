import { NextRequest, NextResponse } from "next/server";
import { canAccessVenue, requireAdmin } from "@/lib/admin-auth";
import { logAction } from "@/lib/activity";
import { finishConnect, whyCode } from "@/lib/accounting-push";

export const dynamic = "force-dynamic";

/**
 * Where Xero sends the manager back after the consent screen (`?code=&state=`, or `?error=` if they declined). The state
 * was made when a signed-in manager of the venue began connecting, is used once, and must be finished by the same person.
 * Nothing of the code, the state or any token is shown, logged or kept except the sealed tokens of a connection that
 * succeeded. Answers by sending the manager back to Reports, Accounting, with `xero=connected` or `xero=failed&why=<code>`
 * (a short code the dashboard says in words, never text from the address). Manager-only, like all of this route (lib/roles.ts).
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const p = req.nextUrl.searchParams;
  const done = await finishConnect(
    { code: p.get("code"), state: p.get("state"), denied: p.has("error") },
    { id: admin.id, name: admin.name },
    (venueId) => canAccessVenue(admin, venueId)
  );
  const back = new URL("/admin", req.url);
  back.searchParams.set("tab", "reports");
  if (done.ok) {
    await logAction(admin, { venueId: done.venueId, action: "accounting.connected", detail: `Xero, ${done.organisation}` });
    back.searchParams.set("venue", String(done.venueId));
    back.searchParams.set("xero", "connected");
  } else {
    if (done.venueId !== null) back.searchParams.set("venue", String(done.venueId));
    back.searchParams.set("xero", "failed");
    back.searchParams.set("why", whyCode(done.error));
  }
  return NextResponse.redirect(back);
}
