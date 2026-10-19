import { NextRequest, NextResponse } from "next/server";
import { createAdmin, isManager, isOwner, listAdminsFor, requireAdmin } from "@/lib/admin-auth";
import { getVenue } from "@/lib/store";
import { logAction } from "@/lib/activity";

export const dynamic = "force-dynamic";

/**
 * Staff accounts. The platform owner manages them all. A business manager
 * manages their own business's: staff at its branches, and fellow managers.
 * Branch staff manage none.
 */
function mayManageStaff(admin: { venueId: number | null; businessId: number | null }): NextResponse | null {
  if (isOwner(admin) || isManager(admin)) return null;
  return NextResponse.json({ error: "Only a business manager or the platform owner can do that." }, { status: 403 });
}

export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const denied = mayManageStaff(admin);
  if (denied) return denied;
  return NextResponse.json({ admins: await listAdminsFor(admin) });
}

/**
 * `{ name, email, password, venueId }` — staff at that branch.
 * `{ name, email, password, businessId }` — a manager of that whole business.
 * Neither, from the platform owner only — another platform owner.
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const denied = mayManageStaff(admin);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { name, email, password, venueId, businessId, role } = (body ?? {}) as Record<string, unknown>;

  if (typeof name !== "string" || name.trim().length < 2)
    return NextResponse.json({ error: "Name is required." }, { status: 400 });
  if (typeof email !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
    return NextResponse.json({ error: "A valid email is required." }, { status: 400 });
  if (typeof password !== "string" || password.length < 8)
    return NextResponse.json({ error: "Password must be at least 8 characters." }, { status: 400 });

  const hasVenue = venueId !== null && venueId !== undefined;
  const hasBusiness = businessId !== null && businessId !== undefined;
  if (hasVenue && (!Number.isInteger(venueId) || (venueId as number) <= 0))
    return NextResponse.json({ error: "Invalid venueId." }, { status: 400 });
  if (hasBusiness && (!Number.isInteger(businessId) || (businessId as number) <= 0))
    return NextResponse.json({ error: "Invalid businessId." }, { status: 400 });
  if (hasVenue && hasBusiness)
    return NextResponse.json({ error: "Staff work at one branch, or manage the whole business — not both." }, { status: 400 });

  if (!isOwner(admin)) {
    // A manager adds staff to their own branches, or managers to their own business.
    const own =
      (hasVenue && (admin.venueIds ?? []).includes(venueId as number)) ||
      (hasBusiness && businessId === admin.businessId);
    if (!own) return NextResponse.json({ error: "You can only add staff to your own business." }, { status: 403 });
  }
  if (hasVenue && !(await getVenue(venueId as number)))
    return NextResponse.json({ error: "Venue not found." }, { status: 404 });

  const result = await createAdmin({
    name,
    email,
    password,
    venueId: hasVenue ? (venueId as number) : null,
    businessId: hasBusiness ? (businessId as number) : null,
    role: role === "desk" ? "desk" : "manager",
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  await logAction(admin, {
    venueId: hasVenue ? (venueId as number) : null,
    action: "staff.added",
    detail: `${result.admin.name} (${result.admin.email})${hasVenue ? `, ${result.admin.role === "desk" ? "front desk" : "manager"}` : ", business manager"}`,
  });
  return NextResponse.json({ admin: result.admin }, { status: 201 });
}
