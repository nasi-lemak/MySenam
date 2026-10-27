import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { documentsForVenue, linePhrase, lineText } from "@/lib/documents";
import { receiptPath } from "@/lib/receipts";

export const dynamic = "force-dynamic";

/** `?venueId` → the venue's latest receipts and credit notes, each with its link to print. */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(req.nextUrl.searchParams.get("venueId"));
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const docs = await documentsForVenue(venueId);
  return NextResponse.json({
    receipts: docs.map((d) => ({
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
      path: receiptPath(d.ref),
    })),
  });
}
