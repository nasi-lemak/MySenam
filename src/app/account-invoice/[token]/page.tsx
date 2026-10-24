import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { accountById, invoiceByToken, invoiceLines } from "@/lib/accounts";
import { getVenue } from "@/lib/store";
import { venueTax } from "@/lib/tax";
import { money } from "@/lib/region";
import { formatHour } from "@/lib/time";
import { PAID_VIA_LABELS } from "@/lib/types";
import { PrintButton } from "@/components/PrintButton";
import { translator } from "@/lib/i18n";
import { currentSiteName } from "@/lib/locale";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { robots: { index: false, follow: false } };

/**
 * A venue's invoice to a company or school account (lib/accounts.ts), to
 * print or save: every booking charged to the account in the month, who
 * booked it and what it cost. Reached by the link emailed to the account,
 * which is the key to it; staff open the same link from the dashboard. In
 * the account's language, as its email was, whoever opens it.
 */
export default async function AccountInvoicePage({ params }: { params: Promise<{ token: string }> }) {
  const invoice = await invoiceByToken((await params).token);
  if (!invoice) notFound();
  const [account, venue, lines, tax] = await Promise.all([
    accountById(invoice.accountId, true),
    getVenue(invoice.venueId),
    invoiceLines(invoice.id),
    venueTax(invoice.venueId),
  ]);
  if (!account || !venue) notFound();
  const t = translator(account.locale, await currentSiteName());
  const taxed = invoice.taxAmount > 0;
  const via = invoice.paidVia ? PAID_VIA_LABELS[invoice.paidVia] : null;

  return (
    <article lang={account.locale === "zh" ? "zh-Hans" : account.locale} className="mx-auto max-w-3xl space-y-6 rounded-2xl border border-slate-200 bg-white p-8 text-sm shadow-sm print:border-0 print:shadow-none">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold">{taxed ? t("receipt.taxInvoice") : t("ainv.title")}</h1>
          <p className="mt-1 text-slate-600">
            {t("receipt.no")} <span className="font-mono font-semibold">{invoice.number}</span> · {invoice.period}
          </p>
          <p className="text-slate-600">{t("ainv.issued", { issued: invoice.issuedOn, due: invoice.dueOn })}</p>
        </div>
        <PrintButton label={t("receipt.print")} />
      </header>

      <div className="grid gap-6 sm:grid-cols-2">
        <section>
          <p className="text-xs uppercase tracking-wide text-slate-500">{t("ainv.from")}</p>
          <p className="font-semibold">{venue.name}</p>
          <p className="text-slate-600">{venue.address}</p>
          {tax.regNo && <p className="text-slate-600">{t("receipt.regNo", { tax: tax.name, no: tax.regNo })}</p>}
          {venue.phone && <p className="text-slate-600">{venue.phone}</p>}
        </section>
        <section>
          <p className="text-xs uppercase tracking-wide text-slate-500">{t("ainv.to")}</p>
          <p className="font-semibold">{account.name}</p>
          {account.contact && <p className="text-slate-600">{t("ainv.attn", { name: account.contact })}</p>}
          {account.address && <p className="whitespace-pre-line text-slate-600">{account.address}</p>}
          {account.taxNo && <p className="text-slate-600">{t("ainv.taxNo", { no: account.taxNo })}</p>}
        </section>
      </div>

      <table className="w-full border-collapse">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
            <th className="py-2 pr-3 font-medium">{t("receipt.date")}</th>
            <th className="py-2 pr-3 font-medium">{t("ainv.booking")}</th>
            <th className="py-2 pr-3 font-medium">{t("ainv.bookedBy")}</th>
            <th className="py-2 text-right font-medium">{t("ainv.amount")}</th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l) => (
            <tr key={l.code} className="border-b border-slate-100 align-top">
              <td className="py-2 pr-3 whitespace-nowrap">{l.date}</td>
              <td className="py-2 pr-3">
                {l.courtName}, {formatHour(l.startHour)}–{formatHour(l.endHour)} <span className="font-mono text-xs text-slate-500">{l.code}</span>
              </td>
              <td className="py-2 pr-3">{l.bookedBy}</td>
              <td className="py-2 text-right tabular-nums">{money(l.amount)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          {taxed && (
            <tr>
              <td colSpan={3} className="pt-3 pr-3 text-slate-600">
                {t("ainv.ofWhich", { tax: tax.name })}
              </td>
              <td className="pt-3 text-right tabular-nums text-slate-600">{money(invoice.taxAmount)}</td>
            </tr>
          )}
          <tr>
            <td colSpan={3} className="pt-2 pr-3 font-semibold">
              {taxed ? t("receipt.totalIncl", { tax: tax.name }) : t("receipt.total")}
            </td>
            <td className="pt-2 text-right text-base font-bold tabular-nums">{money(invoice.total)}</td>
          </tr>
        </tfoot>
      </table>

      <p className="text-slate-600">
        {invoice.paidOn
          ? via
            ? t("ainv.paidVia", { date: invoice.paidOn, via: account.locale === "en" ? via.toLowerCase() : via })
            : t("ainv.paid", { date: invoice.paidOn })
          : t("ainv.due", { due: invoice.dueOn, number: invoice.number })}
      </p>
    </article>
  );
}
