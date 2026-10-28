import { NextRequest, NextResponse } from "next/server";
import { deleteAdmin, isManager, isOwner, listAdminsFor, requireAdmin, setStaffRole, type Admin } from "@/lib/admin-auth";
import { logAction } from "@/lib/activity";
import { jsonObject } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  if (!isOwner(admin) && !isManager(admin))
    return NextResponse.json({ error: "Only a business manager or the platform owner can do that." }, { status: 403 });

  const { id } = await params;
  const adminId = Number(id);
  if (!Number.isInteger(adminId) || adminId <= 0)
    return NextResponse.json({ error: "Invalid admin id." }, { status: 400 });
  if (adminId === admin.id)
    return NextResponse.json({ error: "You cannot remove your own account." }, { status: 409 });

  // A manager removes only their own business's staff and managers.
  if (!isOwner(admin) && !(await listAdminsFor(admin)).some((a) => a.id === adminId))
    return NextResponse.json({ error: "That account is not part of your business." }, { status: 403 });

  const target = (await listAdminsFor(admin)).find((a) => a.id === adminId);
  const result = await deleteAdmin(adminId);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  if (target) await logAction(admin, { venueId: target.venueId, action: "staff.removed", detail: `${target.name} (${target.email})` });
  return NextResponse.json({ ok: true });
}

/** `{ role: "manager" | "desk" }` for a member of branch staff. */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  if (!isOwner(admin) && !isManager(admin))
    return NextResponse.json({ error: "Only a business manager or the platform owner can do that." }, { status: 403 });
  const adminId = Number((await params).id);
  let body: Record<string, unknown>;
  try {
    body = (await jsonObject(req)) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  if (body.role !== "manager" && body.role !== "desk")
    return NextResponse.json({ error: "A manager or front desk." }, { status: 400 });
  const target: Admin | undefined = (await listAdminsFor(admin)).find((a) => a.id === adminId);
  if (!target) return NextResponse.json({ error: "That account is not part of your business." }, { status: 403 });
  if (target.venueId === null)
    return NextResponse.json({ error: "Only branch staff have a role; business managers always manage." }, { status: 409 });
  await setStaffRole(adminId, body.role);
  await logAction(admin, { venueId: target.venueId, action: "staff.role", detail: `${target.name}: ${target.role} → ${body.role}` });
  return NextResponse.json({ ok: true });
}
