import type { CashUp } from "@/lib/cash-up";
import { money } from "@/lib/region";
import type { StaffT } from "@/lib/staff-i18n";
import { CATEGORY_PHRASES, methodText } from "./cash-up-words";

/**
 * A day's cash-up as a sheet (lib/cash-up.ts): what was taken and given
 * back each way, then every receipt and credit note in the order they were
 * written. The same on the screen and on the printout, so the till is
 * counted against one thing.
 */
export function CashUpSheet({ data, t, time }: { data: CashUp; t: StaffT; time: (at: string) => string }) {
  return (
    <div className="space-y-4">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
            <th className="py-1.5 pr-3 font-medium">{t("p8b.cash.method")}</th>
            <th className="py-1.5 pr-3 text-right font-medium">{t("p8b.cash.taken")}</th>
            <th className="py-1.5 pr-3 text-right font-medium">{t("p8b.cash.givenBack")}</th>
            <th className="py-1.5 text-right font-medium">{t("p8b.cash.net")}</th>
          </tr>
        </thead>
        <tbody>
          {data.byMethod.map((m) => (
            <tr key={m.method ?? "none"} className={`border-b border-slate-100 ${m.money ? "" : "text-slate-500"}`}>
              <td className="py-1.5 pr-3">
                {methodText(t, m.method)}
                <span className="ml-1 text-xs text-slate-400">({m.count})</span>
                {!m.money && <span className="block text-xs">{t("p8b.cash.notMoney")}</span>}
              </td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{money(m.taken)}</td>
              <td className="py-1.5 pr-3 text-right tabular-nums">{m.givenBack ? `−${money(m.givenBack)}` : money(0)}</td>
              <td className="py-1.5 text-right font-semibold tabular-nums">{money(m.net)}</td>
            </tr>
          ))}
          {data.byMethod.length === 0 && (
            <tr>
              <td colSpan={4} className="py-4 text-center text-slate-500">
                {t("p8b.cash.nothing")}
              </td>
            </tr>
          )}
        </tbody>
        <tfoot>
          <tr>
            <td className="pt-2 pr-3 font-semibold">{t("p8b.cash.total")}</td>
            <td className="pt-2 pr-3 text-right tabular-nums">{money(data.totals.taken)}</td>
            <td className="pt-2 pr-3 text-right tabular-nums">{data.totals.givenBack ? `−${money(data.totals.givenBack)}` : money(0)}</td>
            <td className="pt-2 text-right text-base font-bold tabular-nums">{money(data.totals.net)}</td>
          </tr>
        </tfoot>
      </table>

      {data.entries.length > 0 && (
        <table className="w-full border-collapse text-xs">
          <thead>
            <tr className="border-b border-slate-200 text-left uppercase tracking-wide text-slate-500">
              <th className="py-1 pr-2 font-medium">{t("p8b.cash.time")}</th>
              <th className="py-1 pr-2 font-medium">{t("p8b.cash.number")}</th>
              <th className="py-1 pr-2 font-medium">{t("p8b.cash.what")}</th>
              <th className="py-1 pr-2 font-medium">{t("p8b.cash.customer")}</th>
              <th className="py-1 pr-2 font-medium">{t("p8b.cash.method")}</th>
              <th className="py-1 pr-2 font-medium">{t("p8b.cash.by")}</th>
              <th className="py-1 text-right font-medium">{t("c.amount")}</th>
            </tr>
          </thead>
          <tbody>
            {data.entries.map((e, i) => (
              <tr key={`${e.number}-${i}`} className="border-b border-slate-100">
                <td className="whitespace-nowrap py-1 pr-2 text-slate-500">{time(e.at)}</td>
                <td className="whitespace-nowrap py-1 pr-2 font-mono">{e.number}</td>
                <td className="py-1 pr-2">
                  {t(CATEGORY_PHRASES[e.category] ?? "p8b.cat.other")}
                  {e.gross < 0 && <span className="ml-1 text-amber-700">{t("p8b.cash.creditNote")}</span>}
                </td>
                <td className="py-1 pr-2">{e.customer}</td>
                <td className="py-1 pr-2">{methodText(t, e.method)}</td>
                <td className="py-1 pr-2 text-slate-500">{e.staffName ?? "—"}</td>
                <td className={`whitespace-nowrap py-1 text-right tabular-nums ${e.gross < 0 ? "text-amber-700" : ""}`}>{e.gross < 0 ? `−${money(-e.gross)}` : money(e.gross)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
