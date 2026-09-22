import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { getPassById, listPassEntries, voidPass } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  const { id } = await params;
  const passId = Number(id);
  if (!Number.isInteger(passId) || passId <= 0)
    return NextResponse.json({ error: "Invalid pass id." }, { status: 400 });

  // Scope the action to the venue that sold the pass.
  const existing = getPassById(passId);
  if (!existing) return NextResponse.json({ error: "Pass not found." }, { status: 404 });
  const denied = denyVenue(admin, existing.venueId);
  if (denied) return denied;

  const result = voidPass(passId);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  return NextResponse.json({ pass: result.pass, entries: listPassEntries(passId, 20) });
}
