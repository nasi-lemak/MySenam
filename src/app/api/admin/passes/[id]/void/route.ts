import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { getPassById, listPassEntries, voidPass } from "@/lib/store";
import { logAction } from "@/lib/activity";
import { money } from "@/lib/region";
import { asStaff } from "@/lib/acting-staff";

export const dynamic = "force-dynamic";

/**
 * Cancel a pass (managers). Not a refund: the sale stays sold. `{ refund: true }`:
 * staff hand back its unused part, and a credit note is written for that much
 * (`refunded`); what was spent stays sold.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  const { id } = await params;
  const passId = Number(id);
  if (!Number.isInteger(passId) || passId <= 0)
    return NextResponse.json({ error: "Invalid pass id." }, { status: 400 });

  // Scope the action to the venue that sold the pass.
  const existing = await getPassById(passId);
  if (!existing) return NextResponse.json({ error: "Pass not found." }, { status: 404 });
  const denied = denyVenue(admin, existing.venueId);
  if (denied) return denied;

  const body = (await req.json().catch(() => null)) as { refund?: unknown } | null;
  // As the manager cancelling it, so its credit note says who (lib/acting-staff.ts).
  const result = await asStaff(admin, () => voidPass(passId, { refund: body?.refund === true }));
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  const refunded = result.refunded;
  await logAction(admin, {
    venueId: existing.venueId,
    action: "pass.voided",
    detail: `Pass ${passId}${refunded !== undefined ? `, ${money(refunded)} unused handed back` : ""}`,
  });
  return NextResponse.json({ pass: result.pass, entries: await listPassEntries(passId, 20), ...(refunded !== undefined ? { refunded } : {}) });
}
