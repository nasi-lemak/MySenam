import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { coachIdsFor, documentFor } from "@/lib/approvals";

export const dynamic = "force-dynamic";

/**
 * `?id`: a document sent with an application the signed-in coach may review
 * (a venue linked this account to its coach record and named them for the
 * activity). Private: never cached.
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const id = Number(req.nextUrl.searchParams.get("id"));
  let doc: Awaited<ReturnType<typeof documentFor>> = null;
  if (Number.isInteger(id) && id > 0)
    for (const coachId of await coachIdsFor(user.id)) {
      doc = await documentFor(id, { coachId });
      if (doc) break;
    }
  if (!doc) return NextResponse.json({ error: "Not found." }, { status: 404 });
  return new NextResponse(new Uint8Array(doc.content), {
    headers: {
      "Content-Type": doc.contentType,
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "default-src 'none'",
    },
  });
}
