import { NextRequest, NextResponse } from "next/server";
import { requireAdmin, requireOwner } from "@/lib/admin-auth";
import { einvoiceRetention, recordEInvoiceRetentionReview, setEInvoiceRetention } from "@/lib/einvoice-retention";
import { pruneOldData, RETENTION, retentionDue, retentionLastRun } from "@/lib/privacy";

export const dynamic = "force-dynamic";

/**
 * Housekeeping is platform-wide — it reaches every venue's rows — so it is the
 * owner's, not a venue operator's. With it, how long e-invoice records are
 * kept (lib/einvoice-retention.ts): the install's statutory period,
 * provisional until a review is recorded.
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const denied = requireOwner(admin);
  if (denied) return denied;

  return NextResponse.json(
    { policy: RETENTION, due: await retentionDue(), lastRun: await retentionLastRun(), einvoice: await einvoiceRetention() },
    { headers: { "Cache-Control": "no-store" } }
  );
}

/**
 * Apply the policy now rather than waiting for the next visit (no body, or
 * `{ action: "run" }`); `{ action: "einvoice-years", years, review? }` sets
 * how many years e-invoice records are kept (less than the floor only with
 * `review`: reviewerName, reviewerRole, firm, reviewedOn, adviceReference,
 * basis); `{ action: "einvoice-review", jurisdiction?, reviewerName, … }`
 * records a review of the period as it stands.
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const denied = requireOwner(admin);
  if (denied) return denied;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (body?.action === "einvoice-years" || body?.action === "einvoice-review") {
    const done = body.action === "einvoice-years" ? await setEInvoiceRetention(admin, body) : await recordEInvoiceRetentionReview(admin, body);
    if (!done.ok) return NextResponse.json({ error: done.error }, { status: done.status });
    return NextResponse.json({ einvoice: done.retention });
  }
  if (body && body.action !== undefined && body.action !== "run")
    return NextResponse.json({ error: "action is run, einvoice-years or einvoice-review." }, { status: 400 });
  return NextResponse.json(await pruneOldData());
}
