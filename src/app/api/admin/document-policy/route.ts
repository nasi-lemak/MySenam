import { NextRequest, NextResponse } from "next/server";
import { isOwner, requireAdmin } from "@/lib/admin-auth";
import { scannerHealth } from "@/lib/document-scanning";
import { POLICY_BOUNDS, policyEvents, recordPolicyReview, retentionPolicy, setRetentionPolicy } from "@/lib/retention-policy";

export const dynamic = "force-dynamic";

/**
 * Supporting documents: the install's retention periods for applications
 * (lib/retention-policy.ts), provisional wherever no review is recorded, and the
 * malware scanner's state (lib/document-scanning.ts).
 *
 * GET: any staff account reads the periods (an activity's own may only be
 * shorter); the platform owner also gets the scanner's state (reachable,
 * engine and signature age, documents by state) and the record of changes
 * and reviews.
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const policy = await retentionPolicy();
  const owner = isOwner(admin);
  return NextResponse.json(
    {
      policy,
      bounds: POLICY_BOUNDS,
      ...(owner ? { scanner: await scannerHealth(), events: await policyEvents() } : {}),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

/**
 * The platform owner only. `{ action: "set", documentDays, reviewDays,
 * recordDays, quarantineDays }` sets the install's periods (lapsing every
 * recorded review); `{ action: "review", jurisdictions, scope, reviewerName,
 * reviewerRole, firm, reviewedOn, adviceReference, basis }` records a review,
 * one per jurisdiction: the platform owner's record of what a reviewer
 * advised, not verified by MySenam (lib/retention-policy.ts).
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const done =
    body.action === "set"
      ? await setRetentionPolicy(admin, body)
      : body.action === "review"
        ? await recordPolicyReview(admin, body)
        : { ok: false as const, error: "action is set or review.", status: 400 };
  if (!done.ok) return NextResponse.json({ error: done.error }, { status: done.status });
  return NextResponse.json({ policy: done.policy });
}
