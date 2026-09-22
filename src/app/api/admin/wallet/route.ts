import { NextRequest, NextResponse } from "next/server";
import { requireAdmin } from "@/lib/admin-auth";
import { findUserForWallet, listWalletEntries, topUpWallet } from "@/lib/store";
import { MAX_TOP_UP } from "@/lib/types";

export const dynamic = "force-dynamic";

/** Look a customer up at the counter by email or phone. */
export function GET(req: NextRequest) {
  const admin = requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  const query = req.nextUrl.searchParams.get("q");
  if (!query || query.trim() === "")
    return NextResponse.json({ error: "Search by email or phone." }, { status: 400 });

  const customer = findUserForWallet(query);
  if (!customer) return NextResponse.json({ error: "Customer not found." }, { status: 404 });
  return NextResponse.json({ customer, entries: listWalletEntries(customer.id, 20) });
}

export async function POST(req: NextRequest) {
  const admin = requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { userId, amount, reason } = (body ?? {}) as Record<string, unknown>;

  if (!Number.isInteger(userId) || (userId as number) <= 0)
    return NextResponse.json({ error: "userId is required." }, { status: 400 });
  if (!Number.isInteger(amount) || (amount as number) < 1 || (amount as number) > MAX_TOP_UP)
    return NextResponse.json({ error: `Top-up must be RM1–${MAX_TOP_UP}.` }, { status: 400 });

  const result = topUpWallet({
    userId: userId as number,
    amount: amount as number,
    adminId: admin.id,
    reason: typeof reason === "string" ? reason : undefined,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  return NextResponse.json({ balance: result.balance, entry: result.entry }, { status: 201 });
}
