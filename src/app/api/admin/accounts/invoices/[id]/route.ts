import { NextRequest, NextResponse } from "next/server";
import { denyVenue, requireAdmin } from "@/lib/admin-auth";
import { logFromRequest } from "@/lib/activity";
import { invoiceById, markInvoicePaid, withdrawInvoice } from "@/lib/accounts";
import { money } from "@/lib/region";

export const dynamic = "force-dynamic";

async function invoiceFor(req: NextRequest, id: string) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  const invoice = await invoiceById(Number(id));
  if (!invoice) return NextResponse.json({ error: "Invoice not found." }, { status: 404 });
  return denyVenue(admin, invoice.venueId) ?? invoice;
}

/** `{ via }`: paid, and so is every booking on it. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const invoice = await invoiceFor(req, (await params).id);
  if (invoice instanceof NextResponse) return invoice;
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const done = await markInvoicePaid(invoice.venueId, invoice.id, body?.via);
  if (!done.ok) return NextResponse.json(done, { status: 409 });
  await logFromRequest(req, {
    venueId: invoice.venueId,
    action: "account.paid",
    detail: `Invoice ${invoice.number} from ${invoice.accountName} paid, ${money(invoice.total)} by ${String(body?.via)}`,
  });
  return NextResponse.json({ invoice: done.invoice });
}

/** Withdrawn, its bookings to be invoiced again; not once paid (managers). */
export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const invoice = await invoiceFor(req, (await params).id);
  if (invoice instanceof NextResponse) return invoice;
  if (!(await withdrawInvoice(invoice.venueId, invoice.id))) return NextResponse.json({ error: "A paid invoice stays." }, { status: 409 });
  await logFromRequest(req, { venueId: invoice.venueId, action: "account.invoiced", detail: `Invoice ${invoice.number} to ${invoice.accountName} withdrawn` });
  return NextResponse.json({ ok: true });
}
