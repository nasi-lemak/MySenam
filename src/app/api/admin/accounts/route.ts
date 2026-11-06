import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { logFromRequest } from "@/lib/activity";
import { closeAccount, listAccounts, listInvoices, overdueBlockDays, saveAccount } from "@/lib/accounts";
import { offeredLocales } from "@/lib/i18n";

export const dynamic = "force-dynamic";

async function venueOf(req: NextRequest, raw: unknown) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(raw);
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  return denyVenue(admin, venueId) ?? venueId;
}

/** `?venueId` → the venue's company and school accounts, its invoices to them (lib/accounts.ts), the languages an invoice can be in, and `overdueBlockDays` (the venue's setting; null for never). */
export async function GET(req: NextRequest) {
  const venueId = await venueOf(req, req.nextUrl.searchParams.get("venueId"));
  if (venueId instanceof NextResponse) return venueId;
  return NextResponse.json(
    { accounts: await listAccounts(venueId), invoices: await listInvoices(venueId), languages: offeredLocales(), overdueBlockDays: await overdueBlockDays(venueId) },
    { headers: { "Cache-Control": "no-store" } }
  );
}

/** `{ venueId, id?, name, email, contact?, address?, taxNo?, termsDays?, creditLimit?, locale? }`: open one, or change it (managers). */
export async function POST(req: NextRequest) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  const venueId = await venueOf(req, body.venueId);
  if (venueId instanceof NextResponse) return venueId;
  const saved = await saveAccount(venueId, body);
  if (!saved.ok) return NextResponse.json(saved, { status: 400 });
  const a = saved.account;
  await logFromRequest(req, {
    venueId,
    action: "account.changed",
    detail: `${body.id === undefined ? "Opened" : "Changed"} account ${a.name}: ${a.termsDays} days to pay${a.creditLimit === null ? "" : `, limit ${a.creditLimit}`}`,
  });
  return NextResponse.json({ account: a });
}

/** `?venueId&id`: closed to new bookings; what is on it is still invoiced (managers). */
export async function DELETE(req: NextRequest) {
  const venueId = await venueOf(req, req.nextUrl.searchParams.get("venueId"));
  if (venueId instanceof NextResponse) return venueId;
  const id = Number(req.nextUrl.searchParams.get("id"));
  if (!Number.isInteger(id) || !(await closeAccount(venueId, id))) return NextResponse.json({ error: "That account is not open here." }, { status: 404 });
  await logFromRequest(req, { venueId, action: "account.changed", detail: `Closed account ${id}` });
  return NextResponse.json({ ok: true });
}
