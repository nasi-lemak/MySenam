import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { updateVenue } from "@/lib/store";

export const dynamic = "force-dynamic";

const FIELDS = ["name", "area", "address", "phone"] as const;

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  const { id } = await params;
  const venueId = Number(id);
  if (!Number.isInteger(venueId) || venueId <= 0)
    return NextResponse.json({ error: "Invalid venue id." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const input = (body ?? {}) as Record<string, unknown>;

  const changes: Record<string, string> = {};
  for (const field of FIELDS) {
    const value = input[field];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.trim().length < 2)
      return NextResponse.json({ error: `A valid ${field} is required.` }, { status: 400 });
    changes[field] = value;
  }
  if (Object.keys(changes).length === 0)
    return NextResponse.json({ error: "Nothing to update." }, { status: 400 });

  const result = updateVenue(venueId, changes);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 404 });
  return NextResponse.json({ venue: result.venue });
}
