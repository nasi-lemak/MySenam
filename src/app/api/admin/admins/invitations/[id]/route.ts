import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { readJsonObject } from "@/lib/api";
import { managesStaff, resendInvitation, withdrawInvitation } from "@/lib/staff-accounts";

export const dynamic = "force-dynamic";

function idOf(raw: string): number | null {
  const id = Number(raw);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Send an invitation not yet accepted again: a new link, the old one void.
 * `{ name, email }` correct it on the way (lib/staff-accounts.ts).
 */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  if (!managesStaff(admin)) return NextResponse.json({ error: "Only a manager can do that." }, { status: 403 });
  const id = idOf((await params).id);
  if (id === null) return NextResponse.json({ error: "Invalid invitation id." }, { status: 400 });
  const body = await readJsonObject(req);
  if (body instanceof NextResponse) return body;
  const sent = await resendInvitation(admin, id, { name: body.name, email: body.email });
  if (!sent.ok) return NextResponse.json({ error: sent.error }, { status: sent.status });
  return NextResponse.json({ invitation: sent.invitation });
}

/** Withdraw an invitation: its link stops working at once. */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  if (!managesStaff(admin)) return NextResponse.json({ error: "Only a manager can do that." }, { status: 403 });
  const id = idOf((await params).id);
  if (id === null) return NextResponse.json({ error: "Invalid invitation id." }, { status: 400 });
  const done = await withdrawInvitation(admin, id);
  if (!done.ok) return NextResponse.json({ error: done.error }, { status: done.status });
  return NextResponse.json({ ok: true });
}
