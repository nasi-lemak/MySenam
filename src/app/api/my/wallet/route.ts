import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getWalletBalance, listWalletEntries, walletBalances } from "@/lib/store";
import { creditScope } from "@/lib/mode";

export const dynamic = "force-dynamic";

/**
 * The customer's credit. `?venueId=` asks what can be spent there, which is
 * all of it where credit is platform-wide, and that venue's own plus any
 * spendable anywhere where it is per venue.
 */
export async function GET(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const venueParam = Number(req.nextUrl.searchParams.get("venueId"));
  const venueId = Number.isInteger(venueParam) && venueParam > 0 ? venueParam : undefined;
  return NextResponse.json({
    scope: creditScope(),
    balance: await getWalletBalance(user.id, venueId),
    balances: await walletBalances(user.id),
    entries: await listWalletEntries(user.id),
  });
}
