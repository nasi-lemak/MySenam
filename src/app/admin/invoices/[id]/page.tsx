import { notFound } from "next/navigation";
import { cookies } from "next/headers";
import { ADMIN_SESSION_COOKIE, canAccessVenue, getAdminByToken, isOwner } from "@/lib/admin-auth";
import { invoiceById } from "@/lib/billing";
import { getVenue } from "@/lib/store";
import { venueTax } from "@/lib/tax";
import { money } from "@/lib/region";
import { siteName } from "@/lib/site";
import { PrintButton } from "@/components/PrintButton";

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
          description: `${siteName()} — ${l.venueName}, ${invoice.period}${l.planName ? ` (${l.planName}, ${l.resources} courts and rooms)` : ""}`,
          amount: l.amount,
        }))
      : [
          {
            description: `${siteName()} — ${invoice.venueName}, ${invoice.period}${invoice.planName ? ` (${invoice.planName}, ${invoice.resources} courts and rooms)` : ""}`,
            amount: invoice.net,
          },
        ];

  return (
    <article className="mx-auto max-w-2xl space-y-6 rounded-2xl border border-slate-200 bg-white p-8 text-sm shadow-sm print:border-0 print:shadow-none">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">{invoice.tax ? "Tax invoice" : "Invoice"}</h1>
          <p className="mt-1 text-slate-600">
            No. <span className="font-mono font-semibold">{`${invoice.period}-${String(invoice.id).padStart(5, "0")}`}</span>
          </p>
          <p className="text-slate-600">Issued {invoice.issuedOn} · due {invoice.dueOn}</p>
        </div>
        <PrintButton label="Print or save as PDF" />
      </header>

      <div className="grid gap-6 sm:grid-cols-2">
        <section>
          <p className="text-xs uppercase tracking-wide text-slate-500">From</p>
          <p className="font-semibold">{operator.name}</p>
          {operator.registration && <p className="text-slate-600">Registration no. {operator.registration}</p>}
          {invoice.tax?.regNo && (
            <p className="text-slate-600">
              {invoice.tax.name} registration no. {invoice.tax.regNo}
            </p>
          )}
          {operator.address && <p className="whitespace-pre-line text-slate-600">{operator.address}</p>}
          {operator.email && <p className="text-slate-600">{operator.email}</p>}
        </section>
        <section>
          <p className="text-xs uppercase tracking-wide text-slate-500">To</p>
          <p className="font-semibold">{invoice.venueName}</p>
          {venue && <p className="text-slate-600">{venue.address}</p>}
          {venueTaxNo && <p className="text-slate-600">Tax no. {venueTaxNo}</p>}
        </section>
      </div>

      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
            <th className="py-2 pr-3 font-medium">Description</th>
            <th className="py-2 text-right font-medium">Amount</th>
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
                <td className="pt-3 pr-3 text-slate-600">Total before {invoice.tax.name}</td>
                <td className="pt-3 text-right tabular-nums text-slate-600">{money(invoice.net)}</td>
              </tr>
              <tr>
                <td className="pr-3 text-slate-600">
                  {invoice.tax.name} at {invoice.tax.rate}%
                </td>
                <td className="text-right tabular-nums text-slate-600">{money(invoice.tax.amount)}</td>
              </tr>
            </>
          )}
          <tr>
            <td className="pt-2 pr-3 font-semibold">{invoice.tax ? `Total, including ${invoice.tax.name}` : "Total"}</td>
            <td className="pt-2 text-right text-base font-bold tabular-nums">{money(invoice.amount)}</td>
          </tr>
        </tfoot>
      </table>

      <p className="text-slate-600">
        {invoice.status === "paid"
          ? `Paid${invoice.paidAt ? ` on ${invoice.paidAt.slice(0, 10)}` : ""}${invoice.paidVia === "online" ? ", online" : ""}. Thank you.`
          : invoice.status === "void"
            ? "Cancelled: nothing is owed on this invoice."
            : `Please pay by ${invoice.dueOn}.`}
      </p>
    </article>
  );
}
