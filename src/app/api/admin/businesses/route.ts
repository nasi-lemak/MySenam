import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, requireOwner } from "@/lib/admin-auth";
import { groupIntoBusiness, listBusinesses } from "@/lib/branches";
import { jsonObject } from "@/lib/api";
import { logAction } from "@/lib/activity";
import { getDb } from "@/lib/db";

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
    body = (await jsonObject(req)) as Record<string, unknown>;
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
    // Who runs which business is a privilege: kept in the log, where the business's own managers read it too.
    const why = typeof body.reason === "string" && body.reason.trim() ? `: ${body.reason.trim().slice(0, 200)}` : "";
    const branches =
      venueIds.length > 0
        ? ((await getDb().prepare(`SELECT name FROM venues WHERE id IN (${venueIds.map(() => "?").join(",")}) ORDER BY id`).all(...venueIds)) as { name: string }[]).map((v) => v.name)
        : [];
    await logAction(admin, {
      venueId: null,
      businessId: result.businessId,
      action: "business.grouped",
      detail: `${typeof body.name === "string" && body.name.trim() ? `New business ${body.name.trim()}` : `Business ${result.businessId}`}: branches ${branches.join(", ") || "none added"}${why}`,
    });
    if (managerIds.length > 0) {
      const people = (await getDb().prepare(`SELECT name, email FROM admins WHERE id IN (${managerIds.map(() => "?").join(",")}) ORDER BY id`).all(...managerIds)) as {
        name: string;
        email: string;
      }[];
      await logAction(admin, {
        venueId: null,
        businessId: result.businessId,
        action: "staff.promoted",
        detail: `Made business manager: ${people.map((p) => `${p.name} (${p.email})`).join(", ")}${why}`,
      });
    }
    return NextResponse.json({ businessId: result.businessId, businesses: await listBusinesses() }, { status: 201 });
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Could not do that." }, { status: 400 });
  }
}
