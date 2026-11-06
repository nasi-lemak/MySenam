import { NextRequest, NextResponse } from "next/server";
import { platformAccount } from "@/lib/gateways";
import { canAccessVenue, denyVenue, isOwner, requireAdmin, requireOwner } from "@/lib/admin-auth";
import {
  defaultFee,
  invoiceById,
  issueDueInvoices,
  listInvoices,
  markInvoicePaid,
  payInvoiceOnline,
  setVenuePlan,
  venuePlans,
  voidInvoice,
} from "@/lib/billing";
import { isMarketplace } from "@/lib/mode";
import { planTiers, setPlanTiers, suggestedTiers, type PlanTier } from "@/lib/plans";
import { applyPaymentHolds } from "@/lib/payment-holds";
import { logAction } from "@/lib/activity";
import { getDb } from "@/lib/db";
import { money } from "@/lib/region";
import { markRefunded, platformRefundsOwed, refundOnline, refundsInFlight } from "@/lib/payments";

export const dynamic = "force-dynamic";

const REASON_ASKED = "Say why (5 to 300 characters): it is kept in the staff activity log with your name.";

/**
 * A marketplace venue's invoices. Venue staff see their own venue's; the
 * platform owner sees every venue's, and what each is on.
 */
export async function GET(req: NextRequest) {
  const admin = await requireAdmin(req);
  if (admin instanceof NextResponse) return admin;
  if (!isMarketplace()) return NextResponse.json({ marketplace: false, invoices: [] });

  // Lazily as well as on the schedule, so the first visit of the month is
  // never looking at last month, and an install without the scheduler still
  // takes long-overdue venues off.
  await issueDueInvoices();
  await applyPaymentHolds();

  if (isOwner(admin)) {
    return NextResponse.json({
      marketplace: true,
      invoices: await listInvoices(),
      plans: await venuePlans(),
      defaultFee: defaultFee(),
      tiers: await planTiers(),
      suggestedTiers: suggestedTiers(),
      canPayOnline: platformAccount() !== null,
      // Paid twice, or after it was voided: owed back from the platform's account.
      refundsOwed: await platformRefundsOwed(),
      refundsInFlight: await refundsInFlight(null),
    });
  }
  return NextResponse.json({
    marketplace: true,
    // A business manager sees every branch's invoices together.
    invoices: await listInvoices(admin.venueIds ?? []),
    // What each of its venues is on, and why: the tiers are no secret.
    plans: await venuePlans(admin.venueIds ?? []),
    tiers: await planTiers(),
    canPayOnline: platformAccount() !== null,
  });
}

/**
 * `{ action: "pay", invoiceId }` — the venue's own staff, or the owner.
 * `{ action: "markPaid" | "void", invoiceId }` and
 * `{ action: "setPlan", venueId, monthlyFee, billingStartsOn }` and
 * `{ action: "setTiers", tiers: [{ name, upTo, monthlyFee }], extraEach }` and
 * `{ action: "refund", paymentId, how: "gateway" | "manual" }` (what is owed
 * back on a payment to the platform) — the owner.
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
    // A venue's invoice: its staff. A business's: its managers.
    const theirs =
      invoice.venueId !== null ? canAccessVenue(admin, invoice.venueId) : isOwner(admin) || invoice.businessId === admin.businessId;
    if (!theirs) return NextResponse.json({ error: "That invoice is not yours to pay." }, { status: 403 });
    const result = await payInvoiceOnline(invoice.id, { name: admin.name, email: admin.email });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: result.status });
    return NextResponse.json({ url: result.url });
  }

  const denied = requireOwner(admin);
  if (denied) return denied;

  if (input.action === "markPaid" || input.action === "void") {
    if (!Number.isInteger(input.invoiceId))
      return NextResponse.json({ error: "invoiceId is required." }, { status: 400 });
    // Money the platform says it received, or forgives: the owner says why, and it is kept in the staff activity log with their name.
    const reason = typeof input.reason === "string" ? input.reason.trim() : "";
    if (reason.length < 5 || reason.length > 300) return NextResponse.json({ error: REASON_ASKED, code: "BILL_REASON_REQUIRED" }, { status: 400 });
    const result =
      input.action === "markPaid" ? await markInvoicePaid(input.invoiceId as number) : await voidInvoice(input.invoiceId as number);
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 409 });
    const inv = result.invoice;
    await logAction(admin, {
      venueId: inv.venueId,
      businessId: inv.venueId === null ? inv.businessId : null,
      action: input.action === "markPaid" ? "invoice.marked_paid" : "invoice.voided",
      detail: `${inv.period} invoice ${inv.id}, ${money(inv.amount)}${inv.venueId === null ? " (business)" : ""}, ${input.action === "markPaid" ? "recorded as paid outside the app" : "voided, nothing is owed"}: ${reason}`,
    });
    return NextResponse.json({ invoice: result.invoice });
  }

  if (input.action === "refund") {
    if (!Number.isInteger(input.paymentId)) return NextResponse.json({ error: "paymentId is required." }, { status: 400 });
    const done =
      input.how === "gateway"
        ? await refundOnline(input.paymentId as number, null, admin.id)
        : await markRefunded(input.paymentId as number, null, admin.id);
    if (!done.ok) return NextResponse.json({ error: done.error }, { status: 409 });
    return NextResponse.json({ payment: done.payment, pending: done.pending, refundsOwed: await platformRefundsOwed() });
  }

  if (input.action === "setPlan") {
    if (!Number.isInteger(input.venueId))
      return NextResponse.json({ error: "venueId is required." }, { status: 400 });
    const venueDenied = denyVenue(admin, input.venueId as number);
    if (venueDenied) return venueDenied;
    const fee = input.monthlyFee === null || input.monthlyFee === "" ? null : Number(input.monthlyFee);
    const start =
      input.billingStartsOn === null || input.billingStartsOn === "" ? null : String(input.billingStartsOn);
    const before = (await getDb().prepare("SELECT monthly_fee, billing_starts_on FROM venues WHERE id = ?").get(input.venueId)) as
      | { monthly_fee: number | string | null; billing_starts_on: string | null }
      | undefined;
    const result = await setVenuePlan(input.venueId as number, { monthlyFee: fee, billingStartsOn: start });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
    const why = typeof input.reason === "string" && input.reason.trim() ? `: ${input.reason.trim().slice(0, 300)}` : "";
    const fmt = (f: number | string | null | undefined) => (f === null || f === undefined ? "the default fee" : money(Number(f)));
    await logAction(admin, {
      venueId: input.venueId as number,
      action: "plan.set",
      detail: `Monthly fee ${fmt(before?.monthly_fee)} → ${fmt(fee)}, billing starts ${before?.billing_starts_on ?? "when let in"} → ${start ?? "when let in"}${why}`,
    });
    return NextResponse.json({ plans: await venuePlans() });
  }

  if (input.action === "setTiers") {
    if (!Array.isArray(input.tiers)) return NextResponse.json({ error: "tiers is required." }, { status: 400 });
    const tiers: PlanTier[] = (input.tiers as Record<string, unknown>[]).map((t) => ({
      name: typeof t?.name === "string" ? t.name : "",
      upTo: t?.upTo === null || t?.upTo === "" || t?.upTo === undefined ? null : Number(t.upTo),
      monthlyFee: Number(t?.monthlyFee),
    }));
    const before = await planTiers();
    const result = await setPlanTiers({ tiers, extraEach: Number(input.extraEach ?? 0) });
    if (!result.ok) return NextResponse.json({ error: result.error }, { status: 400 });
    const describe = (p: { tiers: PlanTier[]; extraEach?: number }) =>
      `${p.tiers.map((t) => `${t.name} ${t.upTo === null ? "any size" : `up to ${t.upTo}`} ${money(t.monthlyFee)}`).join(", ")}; ${money(Number(p.extraEach ?? 0))} for each more`;
    const why = typeof input.reason === "string" && input.reason.trim() ? `: ${input.reason.trim().slice(0, 300)}` : "";
    await logAction(admin, { venueId: null, action: "tiers.set", detail: `Plans by size: ${describe(before)} → ${describe(result.plan)}${why}`.slice(0, 500) });
    return NextResponse.json({ tiers: result.plan, plans: await venuePlans() });
  }

  return NextResponse.json({ error: "Unknown action." }, { status: 400 });
}
