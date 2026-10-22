import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { accountsForUser } from "@/lib/accounts";

export const dynamic = "force-dynamic";

/** `?venueId` → the company and school accounts here the signed-in customer may charge a booking to. */
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const venueId = Number(req.nextUrl.searchParams.get("venueId"));
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  return NextResponse.json({ accounts: await accountsForUser(venueId, user.id) }, { headers: { "Cache-Control": "no-store" } });
}
