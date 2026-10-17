import { NextRequest, NextResponse } from "next/server";
import { isManager, requireAdmin } from "@/lib/admin-auth";
import { addBranch, listBranchRequests } from "@/lib/applications";

export const dynamic = "force-dynamic";

/** A business manager's branches: drafts, waiting to go live, and decided. */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  if (!isManager(admin)) return NextResponse.json({ requests: [] });
  return NextResponse.json({ requests: await listBranchRequests(admin.businessId!) });
}

/** `{ name, area, address, phone, lat, lng, message? }` — add a branch, as a draft to set up. */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  if (!isManager(admin))
    return NextResponse.json({ error: "Only a business manager can add a branch." }, { status: 403 });
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  for (const field of ["name", "area", "address", "phone"])
    if (typeof body[field] !== "string") return NextResponse.json({ error: "Please fill in every field." }, { status: 400 });
  const result = await addBranch(admin, {
    name: body.name as string,
    area: body.area as string,
    address: body.address as string,
    phone: body.phone as string,
    message: typeof body.message === "string" ? body.message : undefined,
    lat: body.lat,
    lng: body.lng,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  return NextResponse.json({ request: result.application, venueId: result.venueId }, { status: 201 });
}
