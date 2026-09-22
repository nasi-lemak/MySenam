import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { listPassesFor } from "@/lib/store";

export const dynamic = "force-dynamic";

/** The signed-in customer's own passes. */
export function GET(req: NextRequest) {
  const user = getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  return NextResponse.json({ passes: listPassesFor({ phone: user.phone, userId: user.id }) });
}
