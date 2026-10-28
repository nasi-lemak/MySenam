import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { logAction } from "@/lib/activity";
import { counterDay, sellAtCounter } from "@/lib/counter-sales";
import { money } from "@/lib/region";
import { asStaff } from "@/lib/acting-staff";

export const dynamic = "force-dynamic";

/** `?venueId=&date=` → that day's counter sales, newest first, with the totals by how they were paid. */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(req.nextUrl.searchParams.get("venueId"));
  const date = req.nextUrl.searchParams.get("date") ?? "";
  if (!Number.isInteger(venueId) || venueId <= 0 || !/^\d{4}-\d{2}-\d{2}$/.test(date))
    return NextResponse.json({ error: "venueId and date are required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  return NextResponse.json(await counterDay(venueId, date));
}

/** `{ venueId, items: [{ addonId, quantity } | { name, price, quantity }], via, customerName?, customerPhone? }` → the sale, receipted. */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || !Number.isInteger(body.venueId)) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const venueId = body.venueId as number;
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  // As the member of staff selling it, so its receipt says who took the money (lib/acting-staff.ts).
  const sold = await asStaff(admin, () =>
    sellAtCounter({
      venueId,
      adminId: admin.id,
      items: body.items,
      via: body.via,
      customerName: body.customerName,
      customerPhone: body.customerPhone,
    })
  );
  if (!sold.ok) return NextResponse.json({ error: sold.error }, { status: 400 });
  await logAction(admin, {
    venueId,
    action: "sale.made",
    detail: `${sold.sale.lines.map((l) => `${l.name} × ${l.quantity}`).join(", ")}: ${money(sold.sale.total)}`,
  });
  return NextResponse.json({ sale: sold.sale });
}
