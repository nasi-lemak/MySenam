"use client";

import { useEffect, useState } from "react";
import type { CoachPayout } from "@/lib/coach-schedule";
import { money } from "@/lib/region";
import { useStaffT } from "./StaffLanguage";

/** What each coach is owed for the period: their fee on lessons that went ahead (lib/coach-schedule.ts). */
export function CoachPayoutsPanel({ venueId, from, to }: { venueId: number; from: string; to: string }) {
  const t = useStaffT();
  const [payouts, setPayouts] = useState<CoachPayout[] | null>(null);
  useEffect(() => {
    setPayouts(null);
    void fetch(`/api/admin/coach-payouts?venueId=${venueId}&from=${from}&to=${to}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { payouts: [] }))
      .then((d) => setPayouts(d.payouts ?? []))
      .catch(() => setPayouts([]));
  }, [venueId, from, to]);
  if (!payouts || payouts.length === 0) return null;
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 text-sm shadow-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold">{t("cpay.title")}</h3>
        <a href={`/api/admin/coach-payouts?venueId=${venueId}&from=${from}&to=${to}&format=csv`} className="font-medium text-teal-700 underline">
          {t("cpay.csv")}
        </a>
      </div>
      <p className="mt-1 text-xs text-slate-500">
        {t("cpay.intro")}
      </p>
      <table className="mt-2 w-full text-left">
        <thead className="text-xs text-slate-500">
          <tr>
            <th className="py-1">{t("cpay.coach")}</th>
            <th className="py-1 text-right">{t("cpay.lessons")}</th>
            <th className="py-1 text-right">{t("cpay.hours")}</th>
            <th className="py-1 text-right">{t("cpay.feesPaid")}</th>
            <th className="py-1 text-right">{t("cpay.feesUnpaid")}</th>
            <th className="py-1 text-right">{t("cpay.noShows")}</th>
            <th className="py-1 text-right">{t("cpay.lateCancels")}</th>
          </tr>
        </thead>
        <tbody>
          {payouts.map((p) => (
            <tr key={p.coachId} className="border-t border-slate-100">
              <td className="py-1 font-medium">{p.coach}</td>
              <td className="py-1 text-right tabular-nums">{p.lessons}</td>
              <td className="py-1 text-right tabular-nums">{p.hours}</td>
              <td className="py-1 text-right tabular-nums">{money(p.paidFees)}</td>
              <td className="py-1 text-right tabular-nums">{money(p.unpaidFees)}</td>
              <td className="py-1 text-right tabular-nums">
                {p.noShows}
                {p.noShows > 0 && ` (${money(p.noShowFees)})`}
              </td>
              <td className="py-1 text-right tabular-nums">
                {p.lateCancels}
                {p.lateCancels > 0 && ` (${money(p.lateCancelFees)})`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
