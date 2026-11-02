import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { getPassById, listPassEntries, voidPass } from "@/lib/store";
import { logAction } from "@/lib/activity";
import { money } from "@/lib/region";
import { asStaff } from "@/lib/acting-staff";
import { withTransaction } from "@/lib/db";
import { oweBackPass } from "@/lib/payments";

export const dynamic = "force-dynamic";

/**
 * Cancel a pass (managers). Not a refund: the sale stays sold. `{ refund: true }`:
 * staff hand back its unused part, and a credit note is written for that much
 * (`refunded`); what was spent stays sold. Bought online, that much is owed
 * back on its payment in the same change (`owedBack`; lib/payments.ts
 * `oweBackPass`), refunded from *Refunds owed* through the gateway.
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
  // As the manager cancelling it, so its credit note says who (lib/acting-staff.ts). Voided and owed back together, or neither.
  const { result, owed } = await asStaff(admin, () =>
    withTransaction(async () => {
      const voided = await voidPass(passId, { refund: body?.refund === true });
      return { result: voided, owed: voided.ok && voided.refunded ? await oweBackPass(passId, voided.refunded) : null };
    })
  );
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  const refunded = result.refunded;
  await logAction(admin, {
    venueId: existing.venueId,
    action: "pass.voided",
    detail: `Pass ${passId}${refunded !== undefined ? `, ${money(refunded)} unused handed back` : ""}${owed !== null ? `, ${money(owed)} paid online owed back` : ""}`,
  });
  return NextResponse.json({
    pass: result.pass,
    entries: await listPassEntries(passId, 20),
    ...(refunded !== undefined ? { refunded } : {}),
    ...(owed !== null ? { owedBack: owed } : {}),
  });
}
