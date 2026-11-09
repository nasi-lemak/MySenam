import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { readJsonObject, refusal } from "@/lib/api";
import { getDb } from "@/lib/db";
import {
  historicalCandidate,
  historicalCandidates,
  historicalRecords,
  obligationSince,
  previewHistorical,
  readHistorical,
  recordHistorical,
} from "@/lib/historical-counter-refunds";

export const dynamic = "force-dynamic";

/**
 * Cancellations from before the obligation was written (ADR 0078; lib/historical-counter-refunds.ts): a manager's (front desk is refused by
 * `MANAGER_ONLY`), at their own venues only.
 *
 * GET: `{ since, candidates, records }`: when migration 0346 was applied, the credit notes still to review at the manager's venues (with the
 * evidence: activity-log actions, other credit notes, stored credit, payouts on the booking) and the reconciliations already recorded.
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const scope = admin.venueIds ?? null;
  return NextResponse.json({ since: await obligationSince(), candidates: await historicalCandidates(scope), records: await historicalRecords(scope) });
}

/**
 * POST `{ creditNoteId, finding: "earlier" | "now" | "earlier_and_now", earlier?: { amount, on, via }, now?: { amount, via }, evidence, reason,
 * remainderReason?, acknowledgeCountedDays?, preview? }`. With `preview: true` nothing is written: `{ preview }` says what would be and what it
 * does to the cash-up (today's for the part handed back now; the credit note's day and the earlier day unchanged; till counts already recorded).
 * Without it the record is written once (`{ preview, recordId }`); a second submission, or a second manager at once, is refused (409).
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const body = await readJsonObject(req);
  if (body instanceof NextResponse) return body;
  const input = readHistorical(body);
  if ("ok" in input) return refusal(input, 400);
  // The venue first: another venue's manager learns nothing more of it than that it is not theirs.
  const found = await historicalCandidate(input.creditNoteId);
  if (found.ok) {
    const denied = denyVenue(admin, found.candidate.venueId);
    if (denied) return denied;
  } else if (!(await mayKnow(admin, input.creditNoteId))) return NextResponse.json({ error: found.error }, { status: 404 });
  if (body.preview === true) {
    const previewed = await previewHistorical(input);
    if (!previewed.ok) return refusal(previewed);
    return NextResponse.json({ preview: previewed.preview });
  }
  const done = await recordHistorical(input, { id: admin.id, name: admin.name, role: admin.role });
  if (!done.ok) return refusal(done);
  return NextResponse.json({ preview: done.preview, recordId: done.recordId });
}

/** A credit note no longer listed: its venue's managers are told why (already recorded); anybody else that there is nothing. */
async function mayKnow(admin: Parameters<typeof denyVenue>[0], creditNoteId: number): Promise<boolean> {
  const row = (await getDb().prepare("SELECT venue_id FROM receipts WHERE id = ? AND kind = 'credit_note'").get(creditNoteId)) as { venue_id: number | null } | undefined;
  return row?.venue_id != null && denyVenue(admin, row.venue_id) === null;
}
