"use client";

import { readJson } from "@/lib/read-response";
import { useEffect, useState } from "react";
import type { CustomerReport } from "@/lib/customer-report";
import { money } from "@/lib/region";
import { useStaffT } from "./StaffLanguage";

/**
 * Who the customers were in the period (lib/customer-report.ts): how many,
 * how many new, the best ones, the regulars who have stopped coming, and how
 * often people did not turn up.
 */
export function CustomerReportPanel({ venueId, from, to }: { venueId: number; from: string; to: string }) {
  const t = useStaffT();
  const [report, setReport] = useState<CustomerReport | null>(null);

  useEffect(() => {
    let live = true;
    fetch(`/api/admin/reports/customers?venueId=${venueId}&from=${from}&to=${to}`, { cache: "no-store" })
      .then((res) => (res.ok ? readJson(res) : null))
      .then((data) => live && setReport(data?.report ?? null))
      .catch(() => live && setReport(null));
    return () => {
      live = false;
    };
  }, [venueId, from, to]);

  if (!report) return null;
  const tile = "rounded-lg border border-slate-200 bg-white px-3 py-2";
  return (
    <section className="space-y-3">
      <h3 className="text-base font-bold">{t("cust.title")}</h3>
      <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
        <div className={tile}>
          <div className="text-xs text-slate-500">{t("cust.title")}</div>
          <div className="text-xl font-bold tabular-nums">{report.customers}</div>
          <div className="text-xs text-slate-500">{t("cust.each", { n: report.perCustomer })}</div>
        </div>
        <div className={tile}>
          <div className="text-xs text-slate-500">{t("cust.newHere")}</div>
          <div className="text-xl font-bold tabular-nums">{report.newCustomers}</div>
          <div className="text-xs text-slate-500">{t("cust.cameBack", { n: report.returning })}</div>
        </div>
        <div className={tile}>
          <div className="text-xs text-slate-500">{t("cust.noShows")}</div>
          <div className="text-xl font-bold tabular-nums">{report.noShowRate}%</div>
          <div className="text-xs text-slate-500">{t("cust.ofPlayed", { n: report.noShows })}</div>
        </div>
        <div className={tile}>
          <div className="text-xs text-slate-500">{t("cust.lateCancels")}</div>
          <div className="text-xl font-bold tabular-nums">{report.lateCancels}</div>
        </div>
      </div>

      {report.top.length > 0 && (
        <div>
          <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{t("cust.best")}</h4>
          <table className="mt-1 w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs text-slate-500">
                <th className="py-1 pr-2 font-medium">{t("cust.col.customer")}</th>
                <th className="py-1 pr-2 text-right font-medium">{t("cust.col.bookings")}</th>
                <th className="py-1 pr-2 text-right font-medium">{t("cust.col.hours")}</th>
                <th className="py-1 pr-2 text-right font-medium">{t("cust.col.spent")}</th>
                <th className="py-1 font-medium">{t("cust.col.since")}</th>
              </tr>
            </thead>
            <tbody>
              {report.top.map((c) => (
                <tr key={c.phone} className="border-b border-slate-100">
                  <td className="py-1 pr-2">
                    {c.name} <span className="text-slate-500">{c.phone}</span>
                  </td>
                  <td className="py-1 pr-2 text-right tabular-nums">{c.bookings}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{c.hours}</td>
                  <td className="py-1 pr-2 text-right tabular-nums">{money(c.spent)}</td>
                  <td className="py-1 text-slate-500">{c.since}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-500">{t("cust.lapsedTitle")}</h4>
        {report.lapsed.length === 0 ? (
          <p className="mt-1 text-sm text-slate-500">{t("cust.noneLapsed", { date: report.lapsedSince })}</p>
        ) : (
          <>
            <p className="mt-1 text-xs text-slate-500">
              {t("cust.lapsedIntro", { date: report.lapsedSince })}
            </p>
            <ul className="mt-1 divide-y divide-slate-100 text-sm">
              {report.lapsed.map((c) => (
                <li key={c.phone} className="flex flex-wrap justify-between gap-2 py-1">
                  <span>
                    {c.name}{" "}
                    <a href={`tel:${c.phone}`} className="text-slate-500 underline">
                      {c.phone}
                    </a>
                  </span>
                  <span className="text-slate-500">
                    {t("cust.lapsedRow", { n: c.bookings, date: c.last })}
                  </span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </section>
  );
}
