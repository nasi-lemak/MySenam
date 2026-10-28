import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { DOCUMENT_LIST_STATUSES, linePhrase, lineText, searchDocuments } from "@/lib/documents";
import { readListQuery } from "@/lib/list-search";
import { receiptPath } from "@/lib/receipts";

export const dynamic = "force-dynamic";

/**
 * `?venueId&q?&status?&page?` → the venue's receipts and credit notes, newest first, fifty at a time, each with its
 * link to print: found by number, booking code, customer's name or number, and `status` receipt or credit_note
 * (lib/list-search.ts).
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(req.nextUrl.searchParams.get("venueId"));
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const query = readListQuery(req.nextUrl.searchParams, DOCUMENT_LIST_STATUSES);
  if ("error" in query) return NextResponse.json({ error: query.error }, { status: 400 });
  const found = await searchDocuments(venueId, query);
  return NextResponse.json({
    receipts: found.items.map((d) => ({
      number: d.number,
      kind: d.kind,
      customer: d.customerName,
      // With whom it is for, where the line keeps that apart (lib/documents.ts `lineText`).
      description: d.lines[0] ? lineText(d.lines[0]) : "",
      // Where MySenam worded it: the phrase, for the staff language (lib/staff-text.ts).
      descriptionPhrase: d.lines[0] ? linePhrase(d.lines[0]) : null,
      total: d.total,
      tax: d.tax?.amount ?? 0,
      credits: d.credits,
      issuedAt: d.issuedAt,
      paidVia: d.paidVia,
      staffName: d.staffName,
      path: receiptPath(d.ref),
    })),
    page: found.page,
    more: found.more,
  });
}
