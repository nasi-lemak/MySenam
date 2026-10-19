import { NextRequest, NextResponse } from "next/server";
import { myPrivateVenues } from "@/lib/access";
import { getSessionUser } from "@/lib/auth";

export const dynamic = "force-dynamic";

/** The private and members-only venues whose list this account's number is on. */
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  return NextResponse.json({ venues: await myPrivateVenues(user.id) });
}
