import { NextRequest, NextResponse } from "next/server";
import { deleteAdmin, isManager, isOwner, listAdminsFor, requireAdmin } from "@/lib/admin-auth";

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

  const result = await deleteAdmin(adminId);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  return NextResponse.json({ ok: true });
}
