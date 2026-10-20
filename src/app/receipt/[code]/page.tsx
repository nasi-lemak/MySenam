import { notFound } from "next/navigation";
import { receiptFor } from "@/lib/receipts";
import { serverT } from "@/lib/locale";
import { money } from "@/lib/region";
import { PrintButton } from "@/components/PrintButton";

export const dynamic = "force-dynamic";

/**
 * A paid booking's receipt, or its tax invoice where the venue is registered
 * for SST or GST. Reached by the signed link in the receipt email and on My
 * Booking; anything else is not found.
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
  const receipt = typeof token === "string" ? await receiptFor(decodeURIComponent(code), token) : null;
  if (!receipt) notFound();

  const net = receipt.tax ? Math.round((receipt.total - receipt.tax.amount) * 100) / 100 : null;
  return (
    <article className="mx-auto max-w-xl space-y-5 rounded-2xl border border-slate-200 bg-white p-6 text-sm shadow-sm print:border-0 print:shadow-none">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-bold">{receipt.tax ? t("receipt.taxInvoice") : t("receipt.title")}</h1>
          <p className="mt-1 text-slate-600">
            {t("receipt.no")} <span className="font-mono font-semibold">{receipt.code}</span>
          </p>
          {receipt.paidAt && (
            <p className="text-slate-600">
              {t("receipt.date")} {receipt.paidAt.slice(0, 10)}
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
              <td className="py-2 pr-3">{line.description}</td>
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
              {receipt.tax ? t("receipt.totalIncl", { tax: receipt.tax.name }) : t("receipt.total")}
            </td>
            <td className="pt-2 text-right text-base font-bold tabular-nums">{money(receipt.total)}</td>
          </tr>
        </tfoot>
      </table>

      {receipt.paidVia && <p className="text-slate-600">{t("receipt.paidVia", { via: receipt.paidVia })}</p>}
      {receipt.cancelled && <p className="font-medium text-amber-700">{t("receipt.cancelled")}</p>}
    </article>
  );
}
