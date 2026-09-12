import { NextRequest, NextResponse } from "next/server";

// Dev default — set ADMIN_PASSCODE in the environment for real deployments.
const PASSCODE = process.env.ADMIN_PASSCODE || "mudah-admin";

/** Returns a 401 response if the admin passcode header is wrong, else null. */
export function requireAdmin(req: NextRequest): NextResponse | null {
  if (req.headers.get("x-admin-passcode") !== PASSCODE) {
    return NextResponse.json({ error: "Wrong passcode." }, { status: 401 });
  }
  return null;
}
