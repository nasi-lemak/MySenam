import { NextRequest, NextResponse } from "next/server";
import { isManager, requireAdmin } from "@/lib/admin-auth";
import { readJsonObject } from "@/lib/api";
import { logAction } from "@/lib/activity";
import { addBranch, listBranchRequests } from "@/lib/applications";

export const dynamic = "force-dynamic";

/** A business manager's branches: drafts, waiting to go live, and decided. */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  if (!isManager(admin)) return NextResponse.json({ requests: [] });
  return NextResponse.json({ requests: await listBranchRequests(admin.businessId!) });
}

/**
 * `{ name, area, address, phone, lat, lng, message?, copyFrom? }` — add a branch, as a draft to set up; with
 * `copyFrom` (another branch of the business), started from that one's set-up (lib/branch-copy.ts).
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  if (!isManager(admin))
    return NextResponse.json({ error: "Only a business manager can add a branch." }, { status: 403 });
  const body = await readJsonObject(req);
  if (body instanceof NextResponse) return body;
  for (const field of ["name", "area", "address", "phone"])
    if (typeof body[field] !== "string") return NextResponse.json({ error: "Please fill in every field." }, { status: 400 });
  const copyFrom = body.copyFrom === undefined || body.copyFrom === null || body.copyFrom === "" ? undefined : Number(body.copyFrom);
  if (copyFrom !== undefined && (!Number.isInteger(copyFrom) || copyFrom <= 0))
    return NextResponse.json({ error: "copyFrom is one of your branches." }, { status: 400 });
  const result = await addBranch(admin, {
    name: body.name as string,
    area: body.area as string,
    address: body.address as string,
    phone: body.phone as string,
    message: typeof body.message === "string" ? body.message : undefined,
    lat: body.lat,
    lng: body.lng,
    copyFrom,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  const copied = result.copied;
  await logAction(admin, {
    venueId: result.venueId!,
    action: "venue.branch_added",
    detail: copied
      ? `Added this branch as a draft, from venue #${copied.fromVenueId}'s set-up: ${copied.courts} court(s)` +
        (copied.skippedCourts.length ? `; not copied: ${copied.skippedCourts.join(", ")}` : "")
      : "Added this branch as a draft",
  });
  return NextResponse.json({ request: result.application, venueId: result.venueId, copied: copied ?? null }, { status: 201 });
}
