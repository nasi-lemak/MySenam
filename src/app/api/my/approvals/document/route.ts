import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { downloadHeaders } from "@/lib/approval-documents";
import { openDocument } from "@/lib/approvals";

export const dynamic = "force-dynamic";

/**
 * `?id`: a document the signed-in customer sent with one of their
 * applications. Private and never cached; a PDF as an attachment, under a
 * policy that lets nothing in it run (lib/approval-documents.ts). Each
 * opening is recorded.
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const id = Number(req.nextUrl.searchParams.get("id"));
  const doc = Number.isInteger(id) && id > 0 ? await openDocument(id, { kind: "customer", userId: user.id, name: user.name }) : null;
  if (!doc) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return new NextResponse(new Uint8Array(doc.content), { headers: downloadHeaders(doc) });
}
