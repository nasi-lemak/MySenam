import { NextRequest, NextResponse } from "next/server";
import { deleteAdmin, requireAdmin, requireOwner } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const denied = requireOwner(admin);
  if (denied) return denied;

  const { id } = await params;
  const adminId = Number(id);
  if (!Number.isInteger(adminId) || adminId <= 0)
    return NextResponse.json({ error: "Invalid admin id." }, { status: 400 });
  if (adminId === admin.id)
    return NextResponse.json({ error: "You cannot remove your own account." }, { status: 409 });

  const result = await deleteAdmin(adminId);
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  return NextResponse.json({ ok: true });
}
