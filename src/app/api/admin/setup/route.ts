import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { dismissSetup, markDetailsChecked, venueSetup } from "@/lib/setup";
import { jsonObject } from "@/lib/api";

export const dynamic = "force-dynamic";

/** The venue asked about: `?venueId=`, or the admin's own. */
function venueOf(admin: { venueIds: number[] | null }, raw: unknown): number | null {
  const own = admin.venueIds?.length === 1 ? admin.venueIds[0] : null;
  const id = raw === undefined || raw === null || raw === "" ? own : Number(raw);
  return Number.isInteger(id) && (id as number) > 0 ? (id as number) : null;
}

/** How far this venue has got with setting itself up. */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = venueOf(admin, req.nextUrl.searchParams.get("venueId"));
  if (venueId === null) return NextResponse.json({ error: "Which venue?" }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  return NextResponse.json(await venueSetup(venueId), { headers: { "Cache-Control": "no-store" } });
}

/** `{ venueId?, action: "detailsChecked" | "dismiss" }` */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  let body: { venueId?: unknown; action?: unknown };
  try {
    body = await jsonObject(req);
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const venueId = venueOf(admin, body.venueId);
  if (venueId === null) return NextResponse.json({ error: "Which venue?" }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  if (body.action === "detailsChecked") await markDetailsChecked(venueId);
  else if (body.action === "dismiss") await dismissSetup(venueId);
  else return NextResponse.json({ error: "Unknown action." }, { status: 400 });
  return NextResponse.json(await venueSetup(venueId));
}
