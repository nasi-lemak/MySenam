import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import type { Admin } from "@/lib/admin-auth";
import { creditScope } from "@/lib/mode";
import { findUserForWallet, listWalletEntries, topUpWallet } from "@/lib/store";
import { MAX_TOP_UP } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * Which venue's credit the counter is dealing in, where credit is per venue:
 * a venue's own staff always their own venue, the platform owner whichever
 * one they name. Undefined where credit is platform-wide.
 */
function venueFor(admin: Admin, asked: unknown): number | undefined | NextResponse {
  if (creditScope() !== "venue") return undefined;
  const id = asked === undefined || asked === null || asked === "" ? admin.venueId : Number(asked);
  if (id === null || id === undefined || !Number.isInteger(id) || id <= 0)
    return NextResponse.json({ error: "Say which venue's credit this is." }, { status: 400 });
  return denyVenue(admin, id) ?? id;
}

/** Look a customer up at the counter by email or phone. */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  const query = req.nextUrl.searchParams.get("q");
  if (!query || query.trim() === "")
    return NextResponse.json({ error: "Search by email or phone." }, { status: 400 });

  const venueId = venueFor(admin, req.nextUrl.searchParams.get("venueId"));
  if (venueId instanceof NextResponse) return venueId;
  const customer = await findUserForWallet(query, venueId);
  if (!customer) return NextResponse.json({ error: "Customer not found." }, { status: 404 });
  return NextResponse.json({
    scope: creditScope(),
    customer,
    entries: await listWalletEntries(customer.id, 20),
  });
}

export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const { userId, amount, reason, venueId: askedVenue } = (body ?? {}) as Record<string, unknown>;
  const venueId = venueFor(admin, askedVenue);
  if (venueId instanceof NextResponse) return venueId;

  if (!Number.isInteger(userId) || (userId as number) <= 0)
    return NextResponse.json({ error: "userId is required." }, { status: 400 });
  if (!Number.isInteger(amount) || (amount as number) < 1 || (amount as number) > MAX_TOP_UP)
    return NextResponse.json({ error: `Top-up must be RM1–${MAX_TOP_UP}.` }, { status: 400 });

  const result = await topUpWallet({
    userId: userId as number,
    amount: amount as number,
    adminId: admin.id,
    reason: typeof reason === "string" ? reason : undefined,
    venueId,
  });
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  return NextResponse.json({ balance: result.balance, entry: result.entry }, { status: 201 });
}
