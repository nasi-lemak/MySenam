import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { logAction } from "@/lib/activity";
import { money } from "@/lib/region";
import { COUNTER_METHODS, type CounterMethod } from "@/lib/types";
import { searchVouchers, sellVoucher, VOUCHER_LIST_STATUSES, voucherPath } from "@/lib/vouchers";
import { asStaff } from "@/lib/acting-staff";
import { readListQuery } from "@/lib/list-search";

export const dynamic = "force-dynamic";

/**
 * `?venueId&q?&status?&page?` → the gift vouchers it has sold, newest first, fifty at a time, found by code, name,
 * email or number and by status (lib/list-search.ts), each with its printable page.
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(req.nextUrl.searchParams.get("venueId"));
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const query = readListQuery(req.nextUrl.searchParams, VOUCHER_LIST_STATUSES);
  if ("error" in query) return NextResponse.json({ error: query.error }, { status: 400 });
  const found = await searchVouchers(venueId, query);
  return NextResponse.json({ vouchers: found.items.map((v) => ({ ...v, printUrl: voucherPath(v.code) })), page: found.page, more: found.more });
}

/** `{ venueId, amount, buyerName, buyerEmail?, buyerPhone?, recipientName?, message?, via? }`: sold at the counter. */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || !Number.isInteger(body.venueId)) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const venueId = body.venueId as number;
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const text = (k: string) => (typeof body[k] === "string" ? (body[k] as string) : null);
  const via = COUNTER_METHODS.includes(body.via as CounterMethod) ? (body.via as CounterMethod) : null;
  // As the member of staff selling it, so its receipt says who took the money (lib/acting-staff.ts).
  const result = await asStaff(admin, () =>
    sellVoucher({
      venueId,
      amount: Number(body.amount),
      buyerName: text("buyerName") ?? "",
      buyerEmail: text("buyerEmail"),
      buyerPhone: text("buyerPhone"),
      recipientName: text("recipientName"),
      message: text("message"),
      adminId: admin.id,
      via,
    })
  );
  if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
  const v = result.voucher;
  await logAction(admin, { venueId, action: "voucher.sold", detail: `${v.code}, ${money(v.amount)}, to ${v.buyerName}` });
  return NextResponse.json({ voucher: { ...v, printUrl: voucherPath(v.code) } }, { status: 201 });
}
