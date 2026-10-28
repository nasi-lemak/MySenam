import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { documentsForUser, lineText } from "@/lib/documents";
import { receiptPath } from "@/lib/receipts";
import { localDateOf } from "@/lib/time";
import { zoneSettings } from "@/lib/zones";

export const dynamic = "force-dynamic";

/**
 * The signed-in customer's receipts and credit notes, newest first, each with
 * its signed link: `issuedAt` as stored (UTC), `issuedOn` the date as its
 * venue's calendar has it (the install's for one with no venue).
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const docs = await documentsForUser(user.id);
  const zones = new Map<number, string | undefined>();
  for (const id of new Set(docs.map((d) => d.venueId).filter((id): id is number => id !== null))) zones.set(id, (await zoneSettings(id))?.zone);
  return NextResponse.json({
    receipts: docs.map((d) => ({
      number: d.number,
      kind: d.kind,
      venueName: d.venueName,
      description: d.lines[0] ? lineText(d.lines[0]) : "",
      total: d.total,
      issuedAt: d.issuedAt,
      issuedOn: localDateOf(d.issuedAt, d.venueId !== null ? zones.get(d.venueId) : undefined),
      path: receiptPath(d.ref),
    })),
  });
}
