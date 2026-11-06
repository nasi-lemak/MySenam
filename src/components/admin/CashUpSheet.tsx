import type { CashUp, CashUpPart } from "@/lib/cash-up";
import { money } from "@/lib/region";
import type { StaffT } from "@/lib/staff-i18n";
import { CATEGORY_PHRASES, methodText } from "./cash-up-words";

/**
 * A day's cash-up as a sheet (lib/cash-up.ts): what was taken and given
 * back each way, then every receipt and credit note in the order they were
 * written. The same on the screen and on the printout, so the till is
 * counted against one thing. Test bookings' takings from before the venue
 * went live are shown below in a block of their own, never added into it.
 */
export function CashUpSheet({ data, t, time }: { data: CashUp; t: StaffT; time: (at: string) => string }) {
  return (
    <div className="space-y-4">
      <Part part={data} t={t} time={time} empty />
      <TillsAndDeposits data={data} t={t} time={time} />
      {(data.test?.entries.length ?? 0) > 0 && (
        <section className="space-y-3 rounded-lg border border-slate-300 bg-slate-50 p-3" aria-label={t("r10a.cash.testTitle")}>
          <h4 className="font-semibold">{t("r10a.cash.testTitle")}</h4>
          <p className="text-xs text-slate-600">{t("r10a.cash.testNote")}</p>
          <Part part={data.test} t={t} time={time} />
        </section>
      )}
    </div>
  );
}

function Part({ part, t, time, empty = false }: { part: CashUpPart; t: StaffT; time: (at: string) => string; empty?: boolean }) {
  return (
    <>
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
          {part.byMethod.map((m) => (
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
          {empty && part.byMethod.length === 0 && (
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
            <td className="pt-2 pr-3 text-right tabular-nums">{money(part.totals.taken)}</td>
            <td className="pt-2 pr-3 text-right tabular-nums">{part.totals.givenBack ? `−${money(part.totals.givenBack)}` : money(0)}</td>
            <td className="pt-2 text-right text-base font-bold tabular-nums">{money(part.totals.net)}</td>
          </tr>
        </tfoot>
      </table>

      {part.entries.length > 0 && (
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
            {part.entries.map((e, i) => (
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
    </>
  );
}

/**
 * Beside the takings: what each till should hold (the journal's net plus hire deposits taken less let go of), what was counted
 * and the variance, and the hire deposits held, given back and kept that day by how they were held (lib/cash-up.ts). Deposits
 * are money held for customers, never takings.
 */
function TillsAndDeposits({ data, t, time }: { data: CashUp; t: StaffT; time: (at: string) => string }) {
  const dep = data.deposits;
  const counted = new Map((data.counts ?? []).map((c) => [c.method, c]));
  if (!dep || ((data.expected ?? []).length === 0 && dep.entries.length === 0 && dep.heldTotal === 0)) return null;
  return (
    <div className="space-y-4">
      {data.expected.length > 0 && (
        <section aria-label={t("fx4.cash.expectedTitle")}>
          <h4 className="font-semibold">{t("fx4.cash.expectedTitle")}</h4>
          <table className="mt-1 w-full border-collapse text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="py-1.5 pr-3 font-medium">{t("p8b.cash.method")}</th>
                <th className="py-1.5 pr-3 text-right font-medium">{t("fx4.cash.exp.journal")}</th>
                <th className="py-1.5 pr-3 text-right font-medium">{t("fx4.cash.exp.deposits")}</th>
                <th className="py-1.5 pr-3 text-right font-medium">{t("fx4.cash.exp.expected")}</th>
                <th className="py-1.5 pr-3 text-right font-medium">{t("fx4.cash.exp.counted")}</th>
                <th className="py-1.5 text-right font-medium">{t("fx4.cash.exp.variance")}</th>
              </tr>
            </thead>
            <tbody>
              {data.expected.map((e) => {
                const c = counted.get(e.method);
                return (
                  <tr key={e.method} className="border-b border-slate-100">
                    <td className="py-1.5 pr-3">{methodText(t, e.method)}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{money(e.journalNet)}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{money(e.depositsNet)}</td>
                    <td className="py-1.5 pr-3 text-right font-semibold tabular-nums">{money(e.expected)}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{c ? money(c.counted) : "—"}</td>
                    <td className={`py-1.5 text-right tabular-nums ${c && Math.abs(c.variance) >= 0.005 ? "font-semibold text-red-700" : ""}`}>
                      {!c
                        ? "—"
                        : c.variance < -0.004
                          ? t("fx4.cash.exp.short", { amount: money(-c.variance) })
                          : c.variance > 0.004
                            ? t("fx4.cash.exp.over", { amount: money(c.variance) })
                            : t("fx4.cash.exp.match")}
                      {c?.countedBy && <span className="block text-xs font-normal text-slate-500">{t("fx4.cash.exp.by", { name: c.countedBy })}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}
      <section aria-label={t("fx4.cash.depositsTitle")}>
        <h4 className="font-semibold">{t("fx4.cash.depositsTitle")}</h4>
        <p className="text-xs text-slate-600">{t("fx4.cash.depositsNote")}</p>
        {dep.entries.length === 0 ? (
          <p className="mt-1 text-sm text-slate-500">{t("fx4.cash.dep.none")}</p>
        ) : (
          <>
            <table className="mt-1 w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="py-1.5 pr-3 font-medium">{t("p8b.cash.method")}</th>
                  <th className="py-1.5 pr-3 text-right font-medium">{t("fx4.cash.dep.taken")}</th>
                  <th className="py-1.5 pr-3 text-right font-medium">{t("fx4.cash.dep.givenBack")}</th>
                  <th className="py-1.5 text-right font-medium">{t("fx4.cash.dep.kept")}</th>
                </tr>
              </thead>
              <tbody>
                {dep.byMethod.map((m) => (
                  <tr key={m.method ?? "none"} className="border-b border-slate-100">
                    <td className="py-1.5 pr-3">{methodText(t, m.method)}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{money(m.taken)}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums">{m.givenBack ? `−${money(m.givenBack)}` : money(0)}</td>
                    <td className="py-1.5 text-right tabular-nums">{money(m.kept)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <table className="mt-2 w-full border-collapse text-xs">
              <tbody>
                {dep.entries.map((e, i) => (
                  <tr key={`${e.bookingCode}-${e.event}-${i}`} className="border-b border-slate-100">
                    <td className="whitespace-nowrap py-1 pr-2 text-slate-500">{time(e.at)}</td>
                    <td className="whitespace-nowrap py-1 pr-2 font-mono">{e.bookingCode}</td>
                    <td className="py-1 pr-2">{e.event === "taken" ? t("fx4.cash.dep.takenLine") : t("fx4.cash.dep.returnedLine")}</td>
                    <td className="py-1 pr-2">{e.customer}</td>
                    <td className="py-1 pr-2">{methodText(t, e.method)}</td>
                    <td className="py-1 pr-2 text-slate-500">{e.staffName ?? "—"}</td>
                    <td className="whitespace-nowrap py-1 text-right tabular-nums">
                      {e.event === "taken" ? money(e.amount) : `−${money(e.amount)}`}
                      {e.kept > 0 && (
                        <span className="block text-slate-500">
                          {t("fx4.cash.dep.kept")} {money(e.kept)}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
        {dep.heldTotal > 0 && (
          <p className="mt-1 text-sm font-medium">
            {t("fx4.cash.dep.held", { amount: money(dep.heldTotal) })}
            {dep.held.length > 0 && <span className="font-normal text-slate-600"> ({dep.held.map((h) => `${methodText(t, h.method)} ${money(h.amount)}`).join(", ")})</span>}
          </p>
        )}
      </section>
    </div>
  );
}
