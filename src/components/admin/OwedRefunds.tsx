"use client";

import { useState } from "react";
import { readJson } from "@/lib/read-response";
import { money, shortDate } from "@/lib/region";
import { formatMinute } from "@/lib/interval";
import type { OwedCause, OwedRefund } from "@/lib/counter-refunds";
import { COUNTER_METHODS, type CounterMethod } from "@/lib/types";
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
  customer_cancelled: "rf74.owed.cause.customer",
  place_withdrawn: "rf74.owed.cause.place",
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
  // The way a customer agreed to be handed it where that is not the way they paid (a customer's cancellation only): by row, "" is as paid.
  const [handBy, setHandBy] = useState<Record<number, CounterMethod | "">>({});
  if (owed.length === 0 && fees.length === 0) return null;
  // Entry fees, and (ADR 0068) the refund of a counter-sold pass or membership, whose credit note is written already and is not cash paid.
  const entryFees = fees.filter((f) => f.kind === "entry");
  const saleRefunds = fees.filter((f) => f.kind !== "entry");

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
      onDone(t(f.kind === "entry" ? "fx10.fee.done" : "m68.owed.done", { amount: money(f.amount), name: f.name }));
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
        body: JSON.stringify({ id: o.id, outcome, ...(outcome === "back" && o.byCustomer && handBy[o.id] ? { via: handBy[o.id] } : {}) }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(t.err(data, t("r9e.owed.failed")));
      const other = outcome === "back" && o.byCustomer && handBy[o.id] && handBy[o.id] !== o.via ? handBy[o.id] : null;
      onDone(
        other
          ? t("rf74.owed.doneVia", { amount: money(o.amount), code: o.bookingCode, via: t(`c.via.${other}`) })
          : t(outcome === "back" ? "r9e.owed.doneBack" : "r9e.owed.doneCredit", { amount: money(o.amount), code: o.bookingCode })
      );
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
            <span className="basis-full text-amber-900" data-testid="owed-detail">
              {[
                t("rf74.owed.status"),
                t("rf74.owed.arose", { date: shortDate(o.owedSince.slice(0, 10), t.locale, true) }),
                ...(o.creditNote ? [t("rf74.owed.note", { note: o.creditNote })] : []),
                ...(o.byCustomer
                  ? [o.notifiedAt ? t("rf74.owed.told", { date: shortDate(o.notifiedAt.slice(0, 10), t.locale, true) }) : t(o.hasEmail ? "rf74.owed.notToldEmail" : "rf74.owed.notToldNoEmail")]
                  : []),
              ].join(" · ")}
              <br />
              {t("rf74.owed.action", { amount: money(o.amount), via: o.via ? t(`c.via.${o.via}`) : t("p8a.day.viaUnrecorded") })}
            </span>
            {o.managerOnly ? (
              <span className="font-medium text-amber-800">{t("r9e.owed.manager")}</span>
            ) : (
              <>
                {o.byCustomer && (
                  <label className="flex items-center gap-1 text-amber-900">
                    {t("rf74.owed.viaLabel")}
                    <select
                      value={handBy[o.id] ?? ""}
                      disabled={busy !== null}
                      onChange={(e) => setHandBy({ ...handBy, [o.id]: e.target.value as CounterMethod | "" })}
                      className="rounded-md border border-amber-300 bg-white px-1 py-0.5"
                    >
                      <option value="">{o.via ? t("rf74.owed.viaAsPaid", { via: t(`c.via.${o.via}`) }) : t("rf74.owed.viaAsPaidNone")}</option>
                      {COUNTER_METHODS.filter((m) => m !== o.via).map((m) => (
                        <option key={m} value={m}>
                          {t(`c.via.${m}`)}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
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
    {entryFees.length > 0 && (
      <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm" data-testid="owed-fees">
        <p className="font-semibold text-amber-900">{t("fx10.fee.title")}</p>
        <p className="mt-0.5 text-xs text-amber-900">{t("fx10.fee.help")}</p>
        <ul className="mt-2 space-y-2">
          {entryFees.map((f) => (
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
        <p className="mt-2 text-xs font-semibold text-amber-900">{t("r9e.owed.total", { amount: money(entryFees.reduce((sum, f) => sum + f.amount, 0)) })}</p>
      </div>
    )}
    {saleRefunds.length > 0 && (
      <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm" data-testid="owed-sales">
        <p className="font-semibold text-amber-900">{t("m68.owed.title")}</p>
        <p className="mt-0.5 text-xs text-amber-900">{t("m68.owed.help")}</p>
        <ul className="mt-2 space-y-2">
          {saleRefunds.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center gap-2 text-xs text-amber-950">
              <span>
                {t(f.kind === "pass" ? "m68.owed.linePass" : "m68.owed.lineMembership", {
                  name: f.name,
                  what: f.what,
                  amount: money(f.amount),
                  via: f.via ? t(`c.via.${f.via}`) : t("p8a.day.viaUnrecorded"),
                  note: f.creditNote ?? "",
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
        <p className="mt-2 text-xs font-semibold text-amber-900">{t("r9e.owed.total", { amount: money(saleRefunds.reduce((sum, f) => sum + f.amount, 0)) })}</p>
      </div>
    )}
    </>
  );
}
