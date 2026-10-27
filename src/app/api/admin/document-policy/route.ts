import { NextRequest, NextResponse } from "next/server";
import { isOwner, requireAdmin } from "@/lib/admin-auth";
import { failedDocuments, retryDocumentScan, scannerHealth } from "@/lib/document-scanning";
import { POLICY_BOUNDS, policyEvents, recordPolicyReview, retentionPolicy, setRetentionPolicy } from "@/lib/retention-policy";

export const dynamic = "force-dynamic";

/**
 * Supporting documents: the install's retention periods for applications
 * (lib/retention-policy.ts), provisional until a review is recorded, and the
 * malware scanner's state (lib/document-scanning.ts).
 *
 * GET: any staff account reads the periods (an activity's own may only be
 * shorter); the platform owner also gets the scanner's state (reachable,
 * engine and signature age, documents by state, documents stored before
 * scanning and where they stand), the documents that failed with their
 * retries (numbers, venue, activity, kind and size: never contents, file
 * name or applicant), and the record of changes and reviews.
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
      ...(owner ? { scanner: await scannerHealth(), failed: await failedDocuments(), events: await policyEvents() } : {}),
    },
    { headers: { "Cache-Control": "no-store" } }
  );
}

/**
 * The platform owner only. `{ action: "set", documentDays, reviewDays,
 * recordDays, quarantineDays }` sets the install's periods (lapsing a recorded
 * review); `{ action: "review", reviewedOn, reviewedBy, basis }` records who
 * reviewed them, when and on what basis; `{ action: "retry", documentId,
 * reason }` has a failed document scanned again (its same bytes back in
 * quarantine, never released by this; refused with a code when its content
 * is gone or changed, it did not fail, or it was retried too often:
 * lib/document-scanning.ts retryDocumentScan).
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  if (body.action === "retry") {
    const retried = await retryDocumentScan(admin, { documentId: body.documentId, reason: body.reason });
    if (!retried.ok) return NextResponse.json({ error: retried.error, code: retried.code }, { status: retried.status });
    return NextResponse.json({ status: retried.status, alreadyQueued: retried.alreadyQueued });
  }
  const done =
    body.action === "set"
      ? await setRetentionPolicy(admin, body)
      : body.action === "review"
        ? await recordPolicyReview(admin, body)
        : { ok: false as const, error: "action is set, review or retry.", status: 400 };
  if (!done.ok) return NextResponse.json({ error: done.error }, { status: done.status });
  return NextResponse.json({ policy: done.policy });
}
