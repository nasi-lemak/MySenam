import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { downloadHeaders } from "@/lib/approval-documents";
import { NOT_RELEASED, openDocument, reviewerCoaches } from "@/lib/approvals";

export const dynamic = "force-dynamic";

/**
 * `?id`: a document sent with an application the signed-in coach may review
 * (a venue linked this account to its coach record and named them for the
 * activity). Private and never cached; a PDF as an attachment
 * (lib/approval-documents.ts). Each opening is recorded under the coach's name.
 * Only once its malware scan released it (409 before).
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const id = Number(req.nextUrl.searchParams.get("id"));
  let doc: Awaited<ReturnType<typeof openDocument>> = null;
  if (Number.isInteger(id) && id > 0)
    for (const coach of await reviewerCoaches(user.id)) {
      doc = await openDocument(id, { kind: "coach", coachId: coach.id, name: coach.name });
      if (doc) break;
    }
  if (!doc) return NextResponse.json({ error: "Not found." }, { status: 404 });
  // Entitled, but not released by its malware scan (pending, refused or unscannable): never handed out.
  if ("withheld" in doc)
    return NextResponse.json({ error: NOT_RELEASED, code: "SCAN_NOT_RELEASED", scan: doc.withheld }, { status: 409, headers: { "Cache-Control": "no-store" } });
  return new NextResponse(new Uint8Array(doc.content), { headers: downloadHeaders(doc) });
}
