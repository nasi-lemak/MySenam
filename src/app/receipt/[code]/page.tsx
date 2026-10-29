import { notFound } from "next/navigation";
import { receiptFor, receiptLineText } from "@/lib/receipts";
import { serverT } from "@/lib/locale";
import { money, region } from "@/lib/region";
import { einvoiceForReceipt, REFUSED_STATUSES } from "@/lib/myinvois";
import { localDateOf } from "@/lib/time";
import { PrintButton } from "@/components/PrintButton";
import { EInvoiceRequest } from "@/components/EInvoiceRequest";

export const dynamic = "force-dynamic";

/**
 * A receipt (a tax invoice where the venue is registered for SST or GST) or
 * a credit note: for a paid booking, or anything else sold. Reached by a
 * signed link (the receipt email, My Booking, the account page, the staff
 * screens); anything else is not found.
 */
export default async function ReceiptPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const t = await serverT();
  const { code } = await params;
  const token = (await searchParams).t;
  const ref = decodeURIComponent(code);
  const receipt = typeof token === "string" ? await receiptFor(ref, token) : null;
  if (!receipt) notFound();
  // Malaysia's e-invoicing: the customer's own, asked for here, where the venue issues them.
  const einvoice = region().country === "MY" && receipt.kind === "receipt" ? await einvoiceForReceipt(ref, receipt.paidAt) : null;

  const net = receipt.tax ? Math.round((receipt.total - receipt.tax.amount) * 100) / 100 : null;
  const credit = receipt.kind === "credit_note";
  const title = credit ? t("receipt.creditNote") : receipt.tax ? t("receipt.taxInvoice") : t("receipt.title");
  return (
    <article className="mx-auto max-w-xl space-y-5 rounded-2xl border border-slate-200 bg-white p-6 text-sm shadow-sm print:border-0 print:shadow-none">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">{title}</h1>
          <p className="mt-1 text-slate-600">
            {t("receipt.no")} <span className="font-mono font-semibold">{receipt.number}</span>
          </p>
          {receipt.credits && <p className="text-slate-600">{t("receipt.credits", { ref: receipt.credits })}</p>}
          {receipt.paidAt && (
            <p className="text-slate-600">
              {t("receipt.date")} {localDateOf(receipt.paidAt)}
            </p>
          )}
        </div>
        <PrintButton label={t("receipt.print")} />
      </header>

      <section>
        <p className="font-semibold">{receipt.venue.name}</p>
        <p className="text-slate-600">{receipt.venue.address}</p>
        <p className="text-slate-600">{receipt.venue.phone}</p>
        {receipt.tax?.regNo && (
          <p className="text-slate-600">{t("receipt.regNo", { tax: receipt.tax.name, no: receipt.tax.regNo })}</p>
        )}
      </section>

      <section>
        <p className="text-xs uppercase tracking-wide text-slate-500">{t("receipt.billedTo")}</p>
        <p className="font-medium">{receipt.customer}</p>
      </section>

      <table className="w-full border-collapse">
        <tbody>
          {receipt.lines.map((line, i) => (
            <tr key={i} className="border-b border-slate-100">
              <td className="py-2 pr-3">{receiptLineText(t, line)}</td>
              <td className="py-2 text-right tabular-nums">{line.amount < 0 ? `−${money(-line.amount)}` : money(line.amount)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          {receipt.tax && net !== null && (
            <>
              <tr>
                <td className="pt-3 pr-3 text-slate-600">{t("receipt.net", { tax: receipt.tax.name })}</td>
                <td className="pt-3 text-right tabular-nums text-slate-600">{money(net)}</td>
              </tr>
              <tr>
                <td className="pr-3 text-slate-600">{t("receipt.taxLine", { tax: receipt.tax.name, rate: receipt.tax.rate })}</td>
                <td className="text-right tabular-nums text-slate-600">{money(receipt.tax.amount)}</td>
              </tr>
            </>
          )}
          <tr>
            <td className="pt-2 pr-3 font-semibold">
              {credit
                ? receipt.tax
                  ? t("receipt.creditTotalIncl", { tax: receipt.tax.name })
                  : t("receipt.creditTotal")
                : receipt.tax
                  ? t("receipt.totalIncl", { tax: receipt.tax.name })
                  : t("receipt.total")}
            </td>
            <td className="pt-2 text-right text-base font-bold tabular-nums">{money(receipt.total)}</td>
          </tr>
        </tfoot>
      </table>

      {receipt.paidVia && !credit && <p className="text-slate-600">{t("receipt.paidVia", { via: receipt.paidVia })}</p>}
      {receipt.passTax && <p className="text-slate-600">{t("receipt.passPaid", { tax: receipt.passTax })}</p>}
      {receipt.note && (
        <p className="text-slate-600">
          {receipt.note.startsWith("receipt.") ? t(receipt.note as Parameters<typeof t>[0], { tax: receipt.taxName }) : receipt.note}
        </p>
      )}
      {receipt.cancelled && <p className="font-medium text-amber-700">{t("receipt.cancelled")}</p>}
      {receipt.creditNote && (
        <p>
          <a href={receipt.creditNote.path} className="font-medium text-teal-700 underline">
            {t("receipt.seeCreditNote", { no: receipt.creditNote.number })}
          </a>
        </p>
      )}
      {einvoice?.einvoice ? (
        <>
          <p className="rounded-lg border border-slate-200 p-3 text-slate-700">
            {t("einv.yours", { code: einvoice.einvoice.codeNumber })}:{" "}
            {einvoice.einvoice.outcomeUnknown
              ? t("ei10.status.unknown")
              : einvoice.einvoice.status === "rejected"
                ? t("ei7.status.rejected")
                : einvoice.einvoice.status === "cancelled"
                  ? t("ei7.status.cancelled")
                  : t(`einv.status.${einvoice.einvoice.status}`)}
            .
            {einvoice.einvoice.link && (
              <>
                {" "}
                <a href={einvoice.einvoice.link} target="_blank" rel="noreferrer" className="font-medium text-teal-700 underline">
                  {t("einv.view")}
                </a>
              </>
            )}
          </p>
          {/* One LHDN refused or cancelled, nothing sent in its place: the customer may ask again while the month is open. */}
          {einvoice.available && REFUSED_STATUSES.includes(einvoice.einvoice.status) && typeof token === "string" && (
            <>
              <p className="text-slate-600">{t("ei7.askAgain")}</p>
              <EInvoiceRequest refCode={ref} token={token} />
            </>
          )}
        </>
      ) : (
        einvoice?.available && typeof token === "string" && <EInvoiceRequest refCode={ref} token={token} />
      )}
    </article>
  );
}
