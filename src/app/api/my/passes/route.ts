import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { listPassesFor } from "@/lib/store";

export const dynamic = "force-dynamic";

/** The signed-in customer's own passes. */
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  return NextResponse.json({ passes: await listPassesFor(user.id) });
}
