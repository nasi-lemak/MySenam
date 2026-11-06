import { NextRequest, NextResponse } from "next/server";
import { canAccessVenue, denyVenue, requireAdmin } from "@/lib/admin-auth";
import type { Admin } from "@/lib/admin-auth";
import { creditScope } from "@/lib/mode";
import { customerScope, lookupThrottle } from "@/lib/customer-lookup";
import { findUserForWallet, listWalletEntries, topUpWallet } from "@/lib/store";
import { COUNTER_METHODS, MAX_TOP_UP, PAID_VIA_LABELS, type CounterMethod } from "@/lib/types";
import { asStaff } from "@/lib/acting-staff";
import { logAction } from "@/lib/activity";
import { money, isAmount } from "@/lib/region";
import { counterSaleRefusal } from "@/lib/suspensions";

export const dynamic = "force-dynamic";

/**
 * Which venue's credit the counter is dealing in, where credit is per venue:
 * a venue's own staff always their own venue, the platform owner whichever
 * one they name. Undefined where credit is platform-wide.
 */
function venueFor(admin: Admin, asked: unknown): number | undefined | NextResponse {
  if (creditScope() !== "venue") return undefined;
  // Not named: the admin's own venue, when they have just the one.
  const own = admin.venueIds?.length === 1 ? admin.venueIds[0] : null;
  const id = asked === undefined || asked === null || asked === "" ? own : Number(asked);
  if (id === null || id === undefined || !Number.isInteger(id) || id <= 0)
    return NextResponse.json({ error: "Say which venue's credit this is." }, { status: 400 });
  return denyVenue(admin, id) ?? id;
}

/**
 * Whose till the money went into, for its cash-up, where credit is the
 * install's own: the venue named, if it is the admin's, or their one venue.
 */
function counterFor(admin: Admin, asked: unknown): number | null {
  const id = asked === undefined || asked === null || asked === "" ? null : Number(asked);
  if (id !== null && Number.isInteger(id) && id > 0 && canAccessVenue(admin, id)) return id;
  return admin.venueIds?.length === 1 ? admin.venueIds[0] : null;
}

/**
 * Look a customer up at the counter by email or phone: one with a relationship with the member of staff's venues, and
 * not more than a counter's worth an hour (lib/customer-lookup.ts).
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;

  const query = req.nextUrl.searchParams.get("q");
  if (!query || query.trim() === "")
    return NextResponse.json({ error: "Search by email or phone." }, { status: 400 });

  const venueId = venueFor(admin, req.nextUrl.searchParams.get("venueId"));
  if (venueId instanceof NextResponse) return venueId;
  const limited = await lookupThrottle(req, admin);
  if (limited) return limited;
  const customer = await findUserForWallet(query, venueId, customerScope(admin));
  if (!customer) return NextResponse.json({ error: "Customer not found." }, { status: 404 });
  return NextResponse.json({
    scope: creditScope(),
    customer,
    entries: await listWalletEntries(customer.id, 20, venueId),
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
  const { userId, amount, reason, venueId: askedVenue, via } = (body ?? {}) as Record<string, unknown>;
  const venueId = venueFor(admin, askedVenue);
  if (venueId instanceof NextResponse) return venueId;

  if (!Number.isInteger(userId) || (userId as number) <= 0)
    return NextResponse.json({ error: "userId is required." }, { status: 400 });
  if (!isAmount(amount, 1, MAX_TOP_UP))
    return NextResponse.json({ error: `Top-up must be ${money(1)}–${MAX_TOP_UP}.` }, { status: 400 });
  // How the money was taken (cash, DuitNow QR, a transfer or a card terminal): on its receipt and in the cash-up.
  if (via === undefined || via === null || via === "") return NextResponse.json({ error: "Say how it was paid.", code: "P8B_VIA_REQUIRED" }, { status: 400 });
  if (!COUNTER_METHODS.includes(via as CounterMethod))
    return NextResponse.json({ error: `via must be one of ${COUNTER_METHODS.join(", ")}.` }, { status: 400 });

  const counter = venueId ?? counterFor(admin, askedVenue);
  // Nothing new is sold at a venue that is suspended or held for an invoice (lib/suspensions.ts).
  const suspended = await counterSaleRefusal(counter);
  if (suspended) return NextResponse.json(suspended, { status: 409 });
  // As the member of staff selling it, so its receipt says who took the money (lib/acting-staff.ts).
  const result = await asStaff(admin, () =>
    topUpWallet({
      userId: userId as number,
      amount: amount as number,
      adminId: admin.id,
      reason: typeof reason === "string" ? reason : undefined,
      venueId,
      via: via as CounterMethod,
      counterVenueId: counter,
    })
  );
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
  await logAction(admin, {
    venueId: counter,
    action: "credit.changed",
    detail: `${money(amount as number)} for customer ${userId}, by ${PAID_VIA_LABELS[via as CounterMethod]}${typeof reason === "string" && reason.trim() ? `: ${reason.trim()}` : ""}`,
  });
  return NextResponse.json({ balance: result.balance, entry: result.entry }, { status: 201 });
}
