import { NextRequest, NextResponse } from "next/server";
import { createAdmin, listAdmins, requireAdmin, requireOwner } from "@/lib/admin-auth";
import { getVenue } from "@/lib/store";

export const dynamic = "force-dynamic";

export function GET(req: NextRequest) {
  const admin = requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const denied = requireOwner(admin);
  if (denied) return denied;
  return NextResponse.json({ admins: listAdmins() });
}

export async function POST(req: NextRequest) {
  const admin = requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const denied = requireOwner(admin);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { name, email, password, venueId } = (body ?? {}) as Record<string, unknown>;

  if (typeof name !== "string" || name.trim().length < 2)
    return NextResponse.json({ error: "Name is required." }, { status: 400 });
  if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return NextResponse.json({ error: "A valid email is required." }, { status: 400 });
  if (typeof password !== "string" || password.length < 8)
    return NextResponse.json({ error: "Password must be at least 8 characters." }, { status: 400 });

  // null venueId creates another platform owner.
  let scope: number | null = null;
  if (venueId !== null && venueId !== undefined) {
    if (!Number.isInteger(venueId) || (venueId as number) <= 0)
      return NextResponse.json({ error: "Invalid venueId." }, { status: 400 });
    if (!getVenue(venueId as number))
      return NextResponse.json({ error: "Venue not found." }, { status: 404 });
    scope = venueId as number;
  }

  const result = createAdmin({ name, email, password, venueId: scope });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  return NextResponse.json({ admin: result.admin }, { status: 201 });
}
