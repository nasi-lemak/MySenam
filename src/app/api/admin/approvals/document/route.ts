import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { downloadHeaders } from "@/lib/approval-documents";
import { openDocument } from "@/lib/approvals";

export const dynamic = "force-dynamic";

/**
 * `?venueId&id`: a document sent with an application to this venue, for its
 * staff to review. Private and never cached; a PDF as an attachment
 * (lib/approval-documents.ts). Each opening is recorded under the staff
 * member's name.
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(req.nextUrl.searchParams.get("venueId"));
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!Number.isInteger(venueId) || venueId <= 0 || !Number.isInteger(id) || id <= 0)
    return NextResponse.json({ error: "venueId and id are required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const doc = await openDocument(id, { kind: "staff", adminId: admin.id, name: admin.name, venueId });
  if (!doc) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return new NextResponse(new Uint8Array(doc.content), { headers: downloadHeaders(doc) });
}
