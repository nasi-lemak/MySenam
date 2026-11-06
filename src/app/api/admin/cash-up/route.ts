import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { cashUpAs, saveCashUpCount } from "@/lib/cash-up";
import { logFromRequest } from "@/lib/activity";
import { money } from "@/lib/region";

export const dynamic = "force-dynamic";

/**
 * `?venueId&date?&staffId?` → the day's cash-up (lib/cash-up.ts): every receipt and credit note of the day on the
 * venue's calendar, from every source, summed by how it was paid. Front desk gets its own, today or yesterday; a
 * manager anybody's (`staffId`) or everybody's, any day. `date` defaults to the venue's today.
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const params = req.nextUrl.searchParams;
  const venueId = Number(params.get("venueId"));
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const result = await cashUpAs(admin, venueId, { date: params.get("date"), staffId: params.get("staffId") });
  if (!result.ok) return NextResponse.json({ error: result.error, ...(result.code ? { code: result.code } : {}) }, { status: result.status });
  return NextResponse.json({ ...result.cashUp, scope: result.scope, deskDays: result.deskDays }, { headers: { "Cache-Control": "no-store" } });
}

/**
 * `{ venueId, date?, staffId?, counts: [{ method, counted }], note? }` → what the cashier counted at the end of the shift, till by till, against
 * what the cash-up expects, with the variance (lib/cash-up.ts `saveCashUpCount`): whoever may see that cash-up may record its count (front desk
 * its own, today or yesterday; a manager anybody's). A recount is another record, and the latest counts. In the activity log.
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const venueId = Number(body?.venueId);
  if (!body || !Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const ask = { date: typeof body.date === "string" ? body.date : null, staffId: body.staffId === undefined || body.staffId === null ? null : String(body.staffId) };
  const result = await cashUpAs(admin, venueId, ask);
  if (!result.ok) return NextResponse.json({ error: result.error, ...(result.code ? { code: result.code } : {}) }, { status: result.status });
  const saved = await saveCashUpCount(result.cashUp, { id: admin.id, name: admin.name }, body.counts, body.note);
  if (!saved.ok) return NextResponse.json({ error: saved.error }, { status: 400 });
  const off = saved.counts.filter((c) => Math.abs(c.variance) >= 0.005);
  await logFromRequest(req, {
    venueId,
    action: "cashup.counted",
    detail: `Cash-up ${result.cashUp.date}${result.cashUp.staffId === null ? "" : ` for staff ${result.cashUp.staffId}`}: counted ${saved.counts
      .map((c) => `${c.method} ${money(c.counted)} (expected ${money(c.expected)})`)
      .join(", ")}${off.length > 0 ? `; variance ${off.map((c) => `${c.method} ${c.variance > 0 ? "+" : ""}${money(c.variance)}`).join(", ")}` : "; no variance"}`,
  });
  return NextResponse.json({ counts: saved.counts });
}
