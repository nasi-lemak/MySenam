import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { documentFor } from "@/lib/approvals";

export const dynamic = "force-dynamic";

/** `?id`: a document the signed-in customer sent with one of their applications. Private: never cached. */
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const id = Number(req.nextUrl.searchParams.get("id"));
  const doc = Number.isInteger(id) && id > 0 ? await documentFor(id, { userId: user.id }) : null;
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
