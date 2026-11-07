"use client";

import { useState } from "react";
import { readJson } from "@/lib/read-response";
import { money, shortDate } from "@/lib/region";
import { formatMinute } from "@/lib/interval";
import type { OwedCause, OwedRefund } from "@/lib/counter-refunds";
import type { OwedEntryFee } from "@/lib/entry-fee-refunds";
import type { StaffPhrase } from "@/lib/staff-i18n";
import { useStaffT } from "./StaffLanguage";

const CAUSES: Record<OwedCause, StaffPhrase> = {
  closure: "r9e.owed.cause.closure",
  outage: "r9e.owed.cause.outage",
  rain: "r9e.owed.cause.rain",
  api: "r9e.owed.cause.api",
  class: "r9e.owed.cause.class",
  test: "r10a.owed.cause.test",
  lesson_moved: "clsb.s.owed.cause.lessonMoved",
  moved_cheaper: "p67.owed.cause.movedCheaper",
};

/**
 * Counter payments owed back on bookings the venue cancelled (a closed day, a
 * court out of service, a rain-out, its API key, a class called off;
 * lib/counter-refunds.ts): each handed back at the counter the way it was
 * paid, or given as stored credit, when the customer comes. Whoever settles it
 * is recorded with it, and a payout is in that day's payouts and cash-up.
 */
export function OwedRefunds({ owed, fees = [], onDone, onError }: { owed: OwedRefund[]; fees?: OwedEntryFee[]; onDone: (notice: string) => void; onError: (error: string) => void }) {
  const t = useStaffT();
  const [busy, setBusy] = useState<number | null>(null);
  if (owed.length === 0 && fees.length === 0) return null;

  /** An entry fee taken at the counter, owed back after the tournament was called off or the entrant taken out (lib/entry-fee-refunds.ts). */
  async function settleFee(f: OwedEntryFee) {
    setBusy(-f.id);
    try {
      const res = await fetch("/api/admin/bookings/owed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: f.id, kind: "entry_fee", outcome: "back" }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(t.err(data, t("fx10.fee.failed")));
      onDone(t("fx10.fee.done", { amount: money(f.amount), name: f.name }));
    } catch (err) {
      onError(err instanceof Error ? err.message : t("fx10.fee.failed"));
    } finally {
      setBusy(null);
    }
  }

  async function settle(o: OwedRefund, outcome: "back" | "credit") {
    setBusy(o.id);
    try {
      const res = await fetch("/api/admin/bookings/owed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: o.id, outcome }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(t.err(data, t("r9e.owed.failed")));
      onDone(t(outcome === "back" ? "r9e.owed.doneBack" : "r9e.owed.doneCredit", { amount: money(o.amount), code: o.bookingCode }));
    } catch (err) {
      onError(err instanceof Error ? err.message : t("r9e.owed.failed"));
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
    {owed.length > 0 && (
    <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm" data-testid="owed">
      <p className="font-semibold text-amber-900">{t("r9e.owed.title")}</p>
      <p className="mt-0.5 text-xs text-amber-900">{t("r9e.owed.help")}</p>
      <ul className="mt-2 space-y-2">
        {owed.map((o) => (
          <li key={o.id} className="flex flex-wrap items-center gap-2 text-xs text-amber-950">
            <span>
              {t("r9e.owed.line", {
                code: o.bookingCode,
                name: o.name,
                when: `${shortDate(o.date, t.locale, true)} ${formatMinute(o.startMin, t.locale)}`,
                amount: money(o.amount),
                via: o.via ? t(`c.via.${o.via}`) : t("p8a.day.viaUnrecorded"),
                why: t(CAUSES[o.cause]),
              })}
            </span>
            {o.managerOnly ? (
              <span className="font-medium text-amber-800">{t("r9e.owed.manager")}</span>
            ) : (
              <>
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void settle(o, "back")}
                  className="rounded-md border border-amber-400 bg-white px-2.5 py-1 font-semibold text-amber-900 hover:bg-amber-100 disabled:opacity-50"
                >
                  {t("r9e.owed.back", { amount: money(o.amount) })}
                </button>
                {o.account && (
                  <button
                    type="button"
                    disabled={busy !== null}
                    onClick={() => void settle(o, "credit")}
                    className="rounded-md border border-amber-300 bg-white px-2.5 py-1 font-medium text-amber-900 hover:bg-amber-100 disabled:opacity-50"
                  >
                    {t("r9e.owed.credit", { amount: money(o.amount) })}
                  </button>
                )}
              </>
            )}
          </li>
        ))}
      </ul>
      <p className="mt-2 text-xs font-semibold text-amber-900">{t("r9e.owed.total", { amount: money(owed.reduce((sum, o) => sum + o.amount, 0)) })}</p>
    </div>
    )}
    {fees.length > 0 && (
      <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm" data-testid="owed-fees">
        <p className="font-semibold text-amber-900">{t("fx10.fee.title")}</p>
        <p className="mt-0.5 text-xs text-amber-900">{t("fx10.fee.help")}</p>
        <ul className="mt-2 space-y-2">
          {fees.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center gap-2 text-xs text-amber-950">
              <span>
                {t("fx10.fee.line", {
                  name: f.name,
                  tournament: f.tournamentName,
                  amount: money(f.amount),
                  via: f.via ? t(`c.via.${f.via}`) : t("p8a.day.viaUnrecorded"),
                  why: t(f.cause === "tournament_cancelled" ? "fx10.fee.cause.cancelled" : "fx10.fee.cause.beforeDraw"),
                })}
              </span>
              {f.managerOnly ? (
                <span className="font-medium text-amber-800">{t("r9e.owed.manager")}</span>
              ) : (
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void settleFee(f)}
                  className="rounded-md border border-amber-400 bg-white px-2.5 py-1 font-semibold text-amber-900 hover:bg-amber-100 disabled:opacity-50"
                >
                  {t("r9e.owed.back", { amount: money(f.amount) })}
                </button>
              )}
            </li>
          ))}
        </ul>
        <p className="mt-2 text-xs font-semibold text-amber-900">{t("r9e.owed.total", { amount: money(fees.reduce((sum, f) => sum + f.amount, 0)) })}</p>
      </div>
    )}
    </>
  );
}
