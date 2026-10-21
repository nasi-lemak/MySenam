import { NextRequest, NextResponse } from "next/server";
import { getSessionUser } from "@/lib/auth";
import { getWalletBalance, listWalletEntries, walletBalances } from "@/lib/store";
import { creditScope } from "@/lib/mode";
import { getDb } from "@/lib/db";
import { onlineTopUpsAllowed, startTopUpPayment, takesPaymentOnline } from "@/lib/payments";
import { rateLimit } from "@/lib/rate-limit";

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
    topUpVenues: await topUpVenues(user.id),
  });
}

/** Where this customer can buy credit online: venues they have booked or hold credit at that take payment online. */
async function topUpVenues(userId: number): Promise<{ id: number; name: string }[]> {
  if (!onlineTopUpsAllowed()) return [];
  const rows = (await getDb()
    .prepare(
      `SELECT DISTINCT v.id, v.name FROM venues v
        WHERE v.published_at IS NOT NULL AND v.suspended_at IS NULL AND (
          v.id IN (SELECT c.venue_id FROM bookings b JOIN courts c ON c.id = b.court_id WHERE b.user_id = ?)
          OR v.id IN (SELECT venue_id FROM wallet_entries WHERE user_id = ? AND venue_id IS NOT NULL))
        ORDER BY v.name LIMIT 20`
    )
    .all(userId, userId)) as { id: number; name: string }[];
  const open: { id: number; name: string }[] = [];
  for (const v of rows) if (await takesPaymentOnline(v.id)) open.push(v);
  return open;
}

/** `{ venueId, amount }` → the page to pay on; the credit lands once it is paid. */
export async function POST(req: NextRequest) {
  const user = await getSessionUser(req);
  if (!user) return NextResponse.json({ error: "Please sign in." }, { status: 401 });
  const limited = await rateLimit(req, "payment");
  if (limited) return limited;
  const body = (await req.json().catch(() => null)) as { venueId?: unknown; amount?: unknown } | null;
  if (!body || !Number.isInteger(body.venueId)) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const started = await startTopUpPayment(user, body.venueId as number, Number(body.amount));
  if (!started.ok) return NextResponse.json({ error: started.error }, { status: started.status });
  return NextResponse.json({ url: started.url, amount: started.amount });
}
