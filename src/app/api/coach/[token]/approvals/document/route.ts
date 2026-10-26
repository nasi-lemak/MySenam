import { NextRequest, NextResponse } from "next/server";
import { downloadHeaders } from "@/lib/approval-documents";
import { openDocument } from "@/lib/approvals";
import { coachForToken } from "@/lib/coach-schedule";
import { rateLimit } from "@/lib/rate-limit";

export const dynamic = "force-dynamic";

/**
 * `?id`: a document sent with an application this coach may review. Private
 * and never cached; a PDF as an attachment (lib/approval-documents.ts). Each
 * opening is recorded under the coach's name.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ token: string }> }) {
  const limited = await rateLimit(req, "login", "coach-self");
  if (limited) return limited;
  const found = await coachForToken((await params).token);
  if (!found || !found.coach.active) return NextResponse.json({ error: "This link is no longer in use." }, { status: 404 });
  const id = Number(req.nextUrl.searchParams.get("id"));
  const doc = Number.isInteger(id) && id > 0 ? await openDocument(id, { kind: "coach", coachId: found.coach.id, name: found.coach.name }) : null;
  if (!doc) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return new NextResponse(new Uint8Array(doc.content), { headers: downloadHeaders(doc) });
}
