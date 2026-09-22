import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getWalletBalance, listWalletEntries } from "@/lib/store";

export const dynamic = "force-dynamic";

export function GET(req: NextRequest) {
  const user = getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  return NextResponse.json({
    balance: getWalletBalance(user.id),
    entries: listWalletEntries(user.id),
  });
}
