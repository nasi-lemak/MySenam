import { NextRequest, NextResponse } from "next/server";
import { canAccessVenue, denyVenue, isOwner, requireAdmin, requireOwner } from "@/lib/admin-auth";
import {
  defaultFee,
  invoiceById,
  issueDueInvoices,
  listInvoices,
  markInvoicePaid,
  payInvoiceOnline,
  platformAccount,
  setVenuePlan,
  venuePlans,
  voidInvoice,
} from "@/lib/billing";
import { isMarketplace } from "@/lib/mode";

export const dynamic = "force-dynamic";

/**
 * A marketplace venue's invoices. Venue staff see their own venue's; the
 * platform owner sees every venue's, and what each is on.
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  if (!isMarketplace()) return NextResponse.json({ marketplace: false, invoices: [] });

  // Lazily as well as on the schedule, so the first visit of the month is
  // never looking at last month.
  await issueDueInvoices();

  if (isOwner(admin)) {
    return NextResponse.json({
      marketplace: true,
      invoices: await listInvoices(),
      plans: await venuePlans(),
      defaultFee: defaultFee(),
      canPayOnline: platformAccount() !== null,
    });
  }
  return NextResponse.json({
    marketplace: true,
    invoices: await listInvoices(admin.venueId!),
    canPayOnline: platformAccount() !== null,
  });
}

/**
 * `{ action: "pay", invoiceId }` — the venue's own staff, or the owner.
 * `{ action: "markPaid" | "void", invoiceId }` and
 * `{ action: "setPlan", venueId, monthlyFee, billingStartsOn }` — the owner.
 */
export async function POST(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  if (!isMarketplace()) return NextResponse.json({ error: "Not a marketplace." }, { status: 404 });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }
  const input = (body ?? {}) as Record<string, unknown>;

  if (input.action === "pay") {
    const invoice = Number.isInteger(input.invoiceId) ? await invoiceById(input.invoiceId as number) : null;
    if (!invoice) return NextResponse.json({ error: "Invoice not found." }, { status: 404 });
    if (!canAccessVenue(admin, invoice.venueId))
      return NextResponse.json({ error: "You do not manage that venue." }, { status: 403 });
    const result = await payInvoiceOnline(invoice.id, { name: admin.name, email: admin.email });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ url: result.url });
  }

  const denied = requireOwner(admin);
  if (denied) return denied;

  if (input.action === "markPaid" || input.action === "void") {
    if (!Number.isInteger(input.invoiceId))
      return NextResponse.json({ error: "invoiceId is required." }, { status: 400 });
    const result =
      input.action === "markPaid" ? await markInvoicePaid(input.invoiceId as number) : await voidInvoice(input.invoiceId as number);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
    return NextResponse.json({ invoice: result.invoice });
  }

  if (input.action === "setPlan") {
    if (!Number.isInteger(input.venueId))
      return NextResponse.json({ error: "venueId is required." }, { status: 400 });
    const venueDenied = denyVenue(admin, input.venueId as number);
    if (venueDenied) return venueDenied;
    const fee = input.monthlyFee === null || input.monthlyFee === "" ? null : Number(input.monthlyFee);
    const start =
      input.billingStartsOn === null || input.billingStartsOn === "" ? null : String(input.billingStartsOn);
    const result = await setVenuePlan(input.venueId as number, { monthlyFee: fee, billingStartsOn: start });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
    return NextResponse.json({ plans: await venuePlans() });
  }

  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}
