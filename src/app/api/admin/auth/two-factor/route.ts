import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { confirmSetup, disableTwoFactor, renewRecoveryCodes, startSetup, twoFactorStatus } from "@/lib/two-factor";
import { rateLimit } from "@/lib/rate-limit";
import { logAction } from "@/lib/activity";

export const dynamic = "force-dynamic";

/** This account's two-factor sign-in: on or off, and whether the install requires it. */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  return NextResponse.json({ status: await twoFactorStatus(admin) });
}

/**
 * `{ action: "start" }` → a new secret and its QR code to scan;
 * `{ action: "confirm", code }` → turns it on, with recovery codes shown once;
 * `{ action: "renew", code }` → new recovery codes;
 * `{ action: "disable", code }` → off, where the install allows.
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const body = (await req.json().catch(() => null)) as { action?: unknown; code?: unknown } | null;
  const code = typeof body?.code === "string" ? body.code : "";
  if (body?.action !== "start") {
    const limited = await rateLimit(req, "login", `2fa:${admin.id}`);
    if (limited) return limited;
  }
  switch (body?.action) {
    case "start": {
      const setup = await startSetup(admin.id);
      return setup ? NextResponse.json(setup) : NextResponse.json({ error: "Account not found." }, { status: 404 });
    }
    case "confirm": {
      const done = await confirmSetup(admin.id, code);
      if (!done.ok) return NextResponse.json(done, { status: 400 });
      await logAction(admin, { venueId: admin.venueId, action: "settings.changed", detail: "Two-factor sign-in turned on" });
      return NextResponse.json({ ...done, status: await twoFactorStatus(admin) });
    }
    case "renew": {
      const done = await renewRecoveryCodes(admin.id, code);
      return done.ok ? NextResponse.json(done) : NextResponse.json(done, { status: 400 });
    }
    case "disable": {
      const done = await disableTwoFactor(admin, code);
      if (!done.ok) return NextResponse.json(done, { status: 400 });
      await logAction(admin, { venueId: admin.venueId, action: "settings.changed", detail: "Two-factor sign-in turned off" });
      return NextResponse.json({ status: await twoFactorStatus(admin) });
    }
    default:
      return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  }
}
