import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { logAction } from "@/lib/activity";
import { getCounterSale, voidCounterSale } from "@/lib/counter-sales";
import { money } from "@/lib/region";
import { asStaff } from "@/lib/acting-staff";

export const dynamic = "force-dynamic";

/** `{ reason }` → the sale voided and its receipt credited (managers only). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "Invalid sale id." }, { status: 400 });
  const existing = await getCounterSale(id);
  if (!existing) return NextResponse.json({ error: "Sale not found." }, { status: 404 });
  const denied = denyVenue(admin, existing.venueId);
  if (denied) return denied;
  const body = (await req.json().catch(() => null)) as { reason?: unknown } | null;
  // As the manager voiding it, so its credit note says who (lib/acting-staff.ts).
  const voided = await asStaff(admin, () => voidCounterSale(id, admin.id, body?.reason));
  if (!voided.ok) return NextResponse.json({ error: voided.error }, { status: 409 });
  await logAction(admin, { venueId: existing.venueId, action: "sale.voided", detail: `${existing.receipt?.number ?? `Sale ${id}`}, ${money(existing.total)}: ${voided.sale.voidReason}` });
  return NextResponse.json({ sale: voided.sale });
}
