import { NextRequest, NextResponse } from "next/server";
import { logAction } from "@/lib/activity";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { settleAccountCredit } from "@/lib/accounts";
import { money } from "@/lib/region";

export const dynamic = "force-dynamic";

/**
 * `{ venueId, accountId, note? }`: the credit waiting on a company or school
 * account, paid back to it by hand (a bank transfer), recorded so it never
 * comes off an invoice afterwards (lib/accounts.ts `settleAccountCredit`).
 * Managers; in the activity log.
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const venueId = Number(body?.venueId);
  const accountId = Number(body?.accountId);
  if (!body || !Number.isInteger(venueId) || venueId <= 0 || !Number.isInteger(accountId) || accountId <= 0)
    return NextResponse.json({ error: "venueId and accountId are required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const note = typeof body.note === "string" ? body.note : null;
  const done = await settleAccountCredit(venueId, accountId, { adminId: admin.id, name: admin.name }, note);
  if (!done.ok) return NextResponse.json({ error: done.error }, { status: 409 });
  await logAction(admin, {
    venueId,
    action: "account.credit_settled",
    detail: `Paid back ${money(done.amount)} of credit on account ${done.account.name} by hand${note?.trim() ? `: ${note.trim().slice(0, 200)}` : ""}`,
  });
  return NextResponse.json({ amount: done.amount, account: done.account });
}
