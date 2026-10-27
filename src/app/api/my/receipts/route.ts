import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { documentsForUser, lineText } from "@/lib/documents";
import { receiptPath } from "@/lib/receipts";

export const dynamic = "force-dynamic";

/** The signed-in customer's receipts and credit notes, newest first, each with its signed link. */
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const docs = await documentsForUser(user.id);
  return NextResponse.json({
    receipts: docs.map((d) => ({
      number: d.number,
      kind: d.kind,
      venueName: d.venueName,
      description: d.lines[0] ? lineText(d.lines[0]) : "",
      total: d.total,
      issuedAt: d.issuedAt,
      path: receiptPath(d.ref),
    })),
  });
}
