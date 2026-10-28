import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { logFromRequest } from "@/lib/activity";
import { accountById, INVOICE_LIST_STATUSES, issueInvoice, searchInvoices } from "@/lib/accounts";
import { readListQuery } from "@/lib/list-search";
import { tickOutbox } from "@/lib/notify";
import { money } from "@/lib/region";

export const dynamic = "force-dynamic";

/**
 * `?venueId&q?&status?&page?` → the venue's invoices to its accounts, newest first, fifty at a time, found by number
 * or the account's name or email, and by status (`open`, `overdue`, `paid`; lib/list-search.ts).
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const venueId = Number(req.nextUrl.searchParams.get("venueId"));
  if (!Number.isInteger(venueId) || venueId <= 0) return NextResponse.json({ error: "venueId is required." }, { status: 400 });
  const denied = denyVenue(admin, venueId);
  if (denied) return denied;
  const query = readListQuery(req.nextUrl.searchParams, INVOICE_LIST_STATUSES);
  if ("error" in query) return NextResponse.json({ error: query.error }, { status: 400 });
  const found = await searchInvoices(venueId, query);
  return NextResponse.json({ invoices: found.items, page: found.page, more: found.more }, { headers: { "Cache-Control": "no-store" } });
}

/** `{ accountId, period: "YYYY-MM" }`: invoice what was played on it up to that month's end, now (managers). */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body || !Number.isInteger(body.accountId) || typeof body.period !== "string")
    return NextResponse.json({ error: "accountId and period are required." }, { status: 400 });
  const account = await accountById(body.accountId as number, true);
  if (!account) return NextResponse.json({ error: "Account not found." }, { status: 404 });
  const denied = denyVenue(admin, account.venueId);
  if (denied) return denied;
  const invoice = await issueInvoice(account.id, body.period);
  if (!invoice) return NextResponse.json({ error: "Nothing on the account to invoice up to then." }, { status: 409 });
  await tickOutbox();
  await logFromRequest(req, {
    venueId: account.venueId,
    action: "account.invoiced",
    detail: `Invoice ${invoice.number} to ${account.name}: ${money(invoice.total)}`,
  });
  return NextResponse.json({ invoice });
}
