import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { listMembershipsFor } from "@/lib/store";

export const dynamic = "force-dynamic";

/** The signed-in customer's memberships. */
export function GET(req: NextRequest) {
  const user = getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  return NextResponse.json({
    memberships: listMembershipsFor({ phone: user.phone, userId: user.id }),
  });
}
