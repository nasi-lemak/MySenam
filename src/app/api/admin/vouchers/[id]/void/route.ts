import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { logAction } from "@/lib/activity";
import { voidVoucher, voucherById } from "@/lib/vouchers";
import { asStaff } from "@/lib/acting-staff";

export const dynamic = "force-dynamic";

/** Cancel a gift voucher nobody has used; what was paid is given back (lib/vouchers.ts). */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const id = Number((await params).id);
  if (!Number.isInteger(id) || id <= 0) return NextResponse.json({ error: "Invalid voucher id." }, { status: 400 });
  const existing = await voucherById(id);
  if (!existing) return NextResponse.json({ error: "Voucher not found." }, { status: 404 });
  const denied = denyVenue(admin, existing.venueId);
  if (denied) return denied;
  // As the manager cancelling it, so its credit note says who (lib/acting-staff.ts).
  const result = await asStaff(admin, () => voidVoucher(id, existing.venueId));
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  await logAction(admin, { venueId: existing.venueId, action: "voucher.voided", detail: existing.code });
  return NextResponse.json({ voucher: result.voucher });
}
