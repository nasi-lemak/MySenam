import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { readJsonObject } from "@/lib/api";
import { changeRole, correctStaff, managesStaff, removeStaff } from "@/lib/staff-accounts";

export const dynamic = "force-dynamic";

const NOT_YOURS = () => NextResponse.json({ error: "Only a manager can do that." }, { status: 403 });

function idOf(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/** Remove an account: signed out everywhere at once (lib/staff-accounts.ts `removeStaff`). */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  if (!managesStaff(admin)) return NOT_YOURS();
  const adminId = idOf((await params).id);
  if (adminId === null) return NextResponse.json({ error: "Invalid admin id." }, { status: 400 });
  const done = await removeStaff(admin, adminId);
  if (!done.ok) return NextResponse.json({ error: done.error }, { status: done.status });
  return NextResponse.json({ ok: true });
}

/**
 * `{ role: "manager" | "desk" }` for a member of branch staff, and/or
 * `{ name, email }` to correct them: a new address is invited, and the
 * account moves to it when that invitation is accepted (`{ invited: true }`).
 */
export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  if (!managesStaff(admin)) return NOT_YOURS();
  const adminId = idOf((await params).id);
  if (adminId === null) return NextResponse.json({ error: "Invalid admin id." }, { status: 400 });
  const body = await readJsonObject(req);
  if (body instanceof NextResponse) return body;
  const correcting = body.name !== undefined || body.email !== undefined;
  if (body.role === undefined && !correcting) return NextResponse.json({ error: "A manager or front desk." }, { status: 400 });
  if (body.role !== undefined && body.role !== "manager" && body.role !== "desk")
    return NextResponse.json({ error: "A manager or front desk." }, { status: 400 });
  let invited = false;
  if (correcting) {
    const done = await correctStaff(admin, adminId, { name: body.name, email: body.email });
    if (!done.ok) return NextResponse.json({ error: done.error }, { status: done.status });
    invited = done.invited;
  }
  if (body.role === "manager" || body.role === "desk") {
    const done = await changeRole(admin, adminId, body.role);
    if (!done.ok) return NextResponse.json({ error: done.error }, { status: done.status });
  }
  return NextResponse.json({ ok: true, invited });
}
