import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { logFromRequest } from "@/lib/activity";
import { addBooker, removeBooker } from "@/lib/accounts";

export const dynamic = "force-dynamic";

async function venueOf(req: NextRequest, raw: unknown) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(raw);
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  return denyVenue(admin, venueId) ?? venueId;
}

/** `{ venueId, accountId, name, phone }`: somebody who may charge their own bookings to the account (managers). */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const venueId = await venueOf(req, body.venueId);
  if (venueId instanceof NextResponse) return venueId;
  const done = await addBooker(venueId, Number(body.accountId), body);
  if (!done.ok) return NextResponse.json(done, { status: 400 });
  await logFromRequest(req, { venueId, action: "account.changed", detail: `Account ${body.accountId}: ${String(body.name)} may book on it` });
  return NextResponse.json({ ok: true });
}

/** `?venueId&accountId&phone`: no longer (managers). */
export async function DELETE(req: NextRequest) {
  const q = req.nextUrl.searchParams;
  const venueId = await venueOf(req, q.get("venueId"));
  if (venueId instanceof NextResponse) return venueId;
  if (!(await removeBooker(venueId, Number(q.get("accountId")), q.get("phone") ?? "")))
    return NextResponse.json({ error: "That number is not on the account." }, { status: 404 });
  await logFromRequest(req, { venueId, action: "account.changed", detail: `Account ${q.get("accountId")}: a number taken off` });
  return NextResponse.json({ ok: true });
}
