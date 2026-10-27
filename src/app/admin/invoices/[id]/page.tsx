import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { ADMIN_SESSION_COOKIE, canAccessVenue, getAdminByToken, isOwner } from "@/lib/admin-auth";
import { invoiceById } from "@/lib/billing";
import { getVenue } from "@/lib/store";
import { localDateOf } from "@/lib/time";
import { venueTax } from "@/lib/tax";
import { money } from "@/lib/region";
import { siteName } from "@/lib/site";
import { PrintButton } from "@/components/PrintButton";
import { staffServerT } from "@/lib/staff-locale";

export const dynamic = "force-dynamic";

/**
 * A platform invoice to a venue, to print or save: a tax invoice, with the
 * operator's SST or GST number and the tax on top of the fees, once the
 * operator is registered (MYSENAM_TAX_*); a plain invoice before then. For
 * the venue's (or business's) own staff and the platform's owners only.
 */
export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const token = (await cookies()).get(ADMIN_SESSION_COOKIE)?.value;
  const admin = token ? await getAdminByToken(token) : null;
  const invoice = admin ? await invoiceById(Number((await params).id)) : null;
  if (!admin || !invoice) notFound();
  const allowed =
    isOwner(admin) ||
    (invoice.venueId !== null && canAccessVenue(admin, invoice.venueId)) ||
    (invoice.businessId !== null && admin.businessId === invoice.businessId);
  if (!allowed) notFound();
  const t = await staffServerT();

  const venue = invoice.venueId !== null ? await getVenue(invoice.venueId) : null;
  // The venue's own tax number, where it has one: a registered buyer may want it on the invoice.
  const venueTaxNo = invoice.venueId !== null ? (await venueTax(invoice.venueId)).regNo : null;
  const operator = {
    name: process.env.OPERATOR_NAME?.trim() || siteName(),
    registration: process.env.OPERATOR_REG_NO?.trim() || null,
    address: process.env.OPERATOR_ADDRESS?.trim() || null,
    email: process.env.OPERATOR_EMAIL?.trim() || null,
  };
  const lines =
    invoice.lines.length > 0
      ? invoice.lines.map((l) => ({
          description: l.planName
            ? t("bill.inv.linePlan", { site: siteName(), venue: l.venueName, period: invoice.period, plan: l.planName, n: String(l.resources) })
            : `${siteName()} — ${l.venueName}, ${invoice.period}`,
          amount: l.amount,
        }))
      : [
          {
            description: invoice.planName
              ? t("bill.inv.linePlan", { site: siteName(), venue: invoice.venueName, period: invoice.period, plan: invoice.planName, n: String(invoice.resources) })
              : `${siteName()} — ${invoice.venueName}, ${invoice.period}`,
            amount: invoice.net,
          },
        ];

  return (
    <article className="mx-auto max-w-2xl space-y-6 rounded-2xl border border-slate-200 bg-white p-8 text-sm shadow-sm print:border-0 print:shadow-none">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">{invoice.tax ? t("bill.taxInvoice") : t("bill.invoice")}</h1>
          <p className="mt-1 text-slate-600">
            {t("bill.inv.no")} <span className="font-mono font-semibold">{`${invoice.period}-${String(invoice.id).padStart(5, "0")}`}</span>
          </p>
          <p className="text-slate-600">{t("bill.inv.issuedDue", { issued: invoice.issuedOn, due: invoice.dueOn })}</p>
        </div>
        <PrintButton label={t("bill.inv.print")} />
      </header>

      <div className="grid gap-6 sm:grid-cols-2">
        <section>
          <p className="text-xs uppercase tracking-wide text-slate-500">{t("bill.inv.from")}</p>
          <p className="font-semibold">{operator.name}</p>
          {operator.registration && <p className="text-slate-600">{t("bill.inv.regNo", { no: operator.registration })}</p>}
          {invoice.tax?.regNo && (
            <p className="text-slate-600">{t("bill.inv.taxRegNo", { tax: invoice.tax.name, no: invoice.tax.regNo })}</p>
          )}
          {operator.address && <p className="whitespace-pre-line text-slate-600">{operator.address}</p>}
          {operator.email && <p className="text-slate-600">{operator.email}</p>}
        </section>
        <section>
          <p className="text-xs uppercase tracking-wide text-slate-500">{t("bill.inv.to")}</p>
          <p className="font-semibold">{invoice.venueName}</p>
          {venue && <p className="text-slate-600">{venue.address}</p>}
          {venueTaxNo && <p className="text-slate-600">{t("bill.inv.taxNo", { no: venueTaxNo })}</p>}
        </section>
      </div>

      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
            <th className="py-2 pr-3 font-medium">{t("bill.inv.description")}</th>
            <th className="py-2 text-right font-medium">{t("c.amount")}</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i} className="border-b border-slate-100">
              <td className="py-2 pr-3">{l.description}</td>
              <td className="py-2 text-right tabular-nums">{money(l.amount)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          {invoice.tax && (
            <>
              <tr>
                <td className="pt-3 pr-3 text-slate-600">{t("bill.inv.totalBefore", { tax: invoice.tax.name })}</td>
                <td className="pt-3 text-right tabular-nums text-slate-600">{money(invoice.net)}</td>
              </tr>
              <tr>
                <td className="pr-3 text-slate-600">{t("bill.inv.taxAt", { tax: invoice.tax.name, rate: invoice.tax.rate })}</td>
                <td className="text-right tabular-nums text-slate-600">{money(invoice.tax.amount)}</td>
              </tr>
            </>
          )}
          <tr>
            <td className="pt-2 pr-3 font-semibold">{invoice.tax ? t("bill.inv.totalIncl", { tax: invoice.tax.name }) : t("c.total")}</td>
            <td className="pt-2 text-right text-base font-bold tabular-nums">{money(invoice.amount)}</td>
          </tr>
        </tfoot>
      </table>

      <p className="text-slate-600">
        {invoice.status === "paid"
          ? invoice.paidAt
            ? t(invoice.paidVia === "online" ? "bill.inv.paidOnOnline" : "bill.inv.paidOn", { date: localDateOf(invoice.paidAt) })
            : t(invoice.paidVia === "online" ? "bill.inv.paidOnline" : "bill.inv.paid")
          : invoice.status === "void"
            ? t("bill.inv.void")
            : t("bill.inv.payBy", { due: invoice.dueOn })}
      </p>
    </article>
  );
}
