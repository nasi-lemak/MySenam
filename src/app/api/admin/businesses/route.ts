import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, requireOwner } from "@/lib/admin-auth";
import { groupIntoBusiness, listBusinesses } from "@/lib/branches";

export const dynamic = "force-dynamic";

/** Every business and its branches. The platform owner's. */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const denied = requireOwner(admin);
  if (denied) return denied;
  return NextResponse.json({ businesses: await listBusinesses() });
}

/**
 * `{ name, venueIds, managerIds? }` — a new business from these venues.
 * `{ businessId, venueIds, managerIds? }` — more branches or managers for one.
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const denied = requireOwner(admin);
  if (denied) return denied;
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const ids = (v: unknown) =>
    Array.isArray(v) && v.every((x) => Number.isInteger(x) && x > 0) ? (v as number[]) : null;
  const venueIds = ids(body.venueIds ?? []);
  const managerIds = ids(body.managerIds ?? []);
  if (!venueIds || !managerIds) return NextResponse.json({ error: "venueIds and managerIds must be lists of ids." }, { status: 400 });
  try {
    const result = await groupIntoBusiness({
      name: typeof body.name === "string" ? body.name : undefined,
      businessId: Number.isInteger(body.businessId) ? (body.businessId as number) : undefined,
      venueIds,
      managerIds,
    });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
    return NextResponse.json({ businessId: result.businessId, businesses: await listBusinesses() }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not do that." }, { status: 400 });
  }
}
