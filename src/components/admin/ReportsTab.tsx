"use client";

import { useCallback, useEffect, useState } from "react";
import { formatHour } from "@/lib/time";
import { PAID_VIA_LABELS, SPORT_ICONS, SPORT_LABELS } from "@/lib/types";
import type { PaidVia } from "@/lib/types";
import type { VenueReport } from "@/lib/reports";
import { percent, todayLocal } from "./shared";
import { ActivityPanel } from "./ActivityPanel";
import type { ManagedVenue } from "./shared";
import { money, intlTag } from "@/lib/region";

/* ---------------- Reports tab ---------------- */

/** First day of the month `back` months before this one, as YYYY-MM-DD. */
function monthStart(back: number): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
  return d.toISOString().slice(0, 10);
}

/** Today, less `back` days, as YYYY-MM-DD. */
function daysAgo(back: number): string {
  const d = new Date(`${todayLocal()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

/**
 * The first range is the default, and it is 30 days rather than a calendar
 * quarter on purpose: a quarter that is two-thirds empty averages a good month
 * down to nothing, which reads as "this venue is dead" on the first screen
 * anybody opens.
 */
const RANGES: [string, () => { from: string; to: string }][] = [
  ["Last 30 days", () => ({ from: daysAgo(29), to: todayLocal() })],
  ["This month", () => ({ from: monthStart(0), to: todayLocal() })],
  ["Last 3 months", () => ({ from: monthStart(2), to: todayLocal() })],
];

const ringgit = (n: number) => {
  const r = Math.round(n * 100) / 100;
  const cents = Number.isInteger(r) ? 0 : 2;
  return money(r.toLocaleString(intlTag("en"), { minimumFractionDigits: cents, maximumFractionDigits: cents }));
};

/**
 * What the owner asks at the end of a month.
 *
 * Two colours do all the work and they mean one thing each: teal is money in
 * hand, amber is money still owed. Both are direct-labelled and carry a legend,
 * so nothing here is readable only by colour.
 */
export function ReportsTab({ venues }: { venues: ManagedVenue[] }) {
  const [venueId, setVenueId] = useState(venues[0]?.id ?? 1);
  const [range, setRange] = useState(() => RANGES[0][1]());
  const [data, setData] = useState<{
    report: VenueReport;
    wallet: { customers: number; balance: number } | null;
    venueCredit?: { customers: number; balance: number } | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/reports?venueId=${venueId}&from=${range.from}&to=${range.to}`,
        { cache: "no-store" }
      );
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? "Could not build the report");
      setData(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not build the report");
      setData(null);
    } finally {
      setBusy(false);
    }
  }, [venueId, range]);

  useEffect(() => {
    load();
  }, [load]);

  const report = data?.report;
  const peakHour = report
    ? report.byHour.reduce((best, h) => (h.hours > best.hours ? h : best), report.byHour[0])
    : null;
  const monthPeak = report ? Math.max(1, ...report.byMonth.map((m) => m.expected)) : 1;
  const hourPeak = report ? Math.max(1, ...report.byHour.map((h) => h.hours)) : 1;

  return (
    <div className="space-y-5">
      {/* Filters, one row, above everything they change. */}
      <div className="flex flex-wrap items-end gap-2">
        <select
          value={venueId}
          onChange={(e) => setVenueId(Number(e.target.value))}
          className="rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
        >
          {venues.map((v) => (
            <option key={v.id} value={v.id}>
              {v.name}
            </option>
          ))}
        </select>
        <input
          type="date"
          value={range.from}
          onChange={(e) => setRange({ ...range, from: e.target.value })}
          className="rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
        />
        <input
          type="date"
          value={range.to}
          onChange={(e) => setRange({ ...range, to: e.target.value })}
          className="rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
        />
        {RANGES.map(([label, make]) => (
          <button
            key={label}
            onClick={() => setRange(make())}
            className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-medium text-slate-600 hover:border-teal-500 hover:text-teal-700"
          >
            {label}
          </button>
        ))}
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {busy && !report ? (
        <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-slate-500">
          Working it out…
        </div>
      ) : report ? (
        <>
          {/* The four numbers the month is judged on. */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Collected
              </div>
              <div className="mt-1 text-3xl font-bold tracking-tight text-teal-700">
                {ringgit(report.revenue.collected)}
              </div>
              <div className="mt-0.5 text-xs text-slate-500">
                of {ringgit(report.revenue.expected)} booked
              </div>
              {report.revenue.tax && (
                <div className="mt-0.5 text-xs text-slate-600">
                  including {report.revenue.tax.name} of {ringgit(report.revenue.tax.amount)}
                </div>
              )}
              {report.collectedBy.length > 0 && (
                <ul className="mt-2 space-y-0.5 text-xs text-slate-600">
                  {report.collectedBy.map((c) => (
                    <li key={c.via} className="flex justify-between gap-2">
                      <span>{c.via in PAID_VIA_LABELS ? PAID_VIA_LABELS[c.via as PaidVia] : "Not recorded"}</span>
                      <span className="font-medium">{ringgit(c.amount)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {report.counterSales.sales > 0 && (
                <div className="mt-2 border-t border-slate-100 pt-2 text-xs text-slate-600">
                  Plus counter sales: <span className="font-medium">{ringgit(report.counterSales.total)}</span> ({report.counterSales.sales})
                </div>
              )}
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Still owed
              </div>
              <div
                className={`mt-1 text-3xl font-bold tracking-tight ${
                  report.revenue.outstanding > 0 ? "text-amber-700" : "text-slate-400"
                }`}
              >
                {ringgit(report.revenue.outstanding)}
              </div>
              <div className="mt-0.5 text-xs text-slate-500">
                across {report.bookings.confirmed} bookings
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
                How full
              </div>
              <div className="mt-1 text-3xl font-bold tracking-tight text-slate-900">
                {percent(report.utilisation.courts.percent)}
              </div>
              <div className="mt-0.5 text-xs text-slate-500">
                courts —{" "}
                {report.utilisation.courts.soldHours.toLocaleString(intlTag("en"))} of{" "}
                {report.utilisation.courts.sellableHours.toLocaleString(intlTag("en"))} hours
              </div>
              {report.utilisation.shared.sellableHours > 0 && (
                <div className="mt-1 text-xs text-slate-500">
                  <span className="font-semibold text-slate-700">
                    {percent(report.utilisation.shared.percent)}
                  </span>{" "}
                  of the shared floors and pools
                </div>
              )}
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
                Cancelled &amp; no-shows
              </div>
              <div className="mt-1 text-3xl font-bold tracking-tight text-slate-900">
                {report.bookings.cancelled + report.bookings.noShows}
              </div>
              <div className="mt-0.5 text-xs text-slate-500">
                {report.bookings.cancelled} cancelled · {report.bookings.noShows} never turned up
              </div>
            </div>
          </div>

          {/* Money by month. Only earns a chart once there is more than one. */}
          {report.byMonth.length > 1 && (
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-sm font-semibold">Taken by month</h3>
                <div className="flex items-center gap-3 text-xs text-slate-600">
                  <span className="flex items-center gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-sm bg-teal-600" /> Collected
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-sm bg-amber-600" /> Still owed
                  </span>
                </div>
              </div>

              <div className="mt-4 flex items-end gap-3 overflow-x-auto pb-1">
                {report.byMonth.map((m) => {
                  const owed = m.expected - m.collected;
                  const height = (v: number) => Math.round((v / monthPeak) * 132);
                  return (
                    <div key={m.month} className="flex w-16 shrink-0 flex-col items-center">
                      <div className="text-xs font-semibold text-slate-700">
                        {m.expected > 0 ? ringgit(m.expected) : "—"}
                      </div>
                      <div
                        className="mt-1 flex w-full flex-col justify-end"
                        style={{ height: 140 }}
                        title={`${m.month}: ${ringgit(m.collected)} collected, ${ringgit(owed)} owed, ${m.hours} hours`}
                      >
                        {owed > 0 && (
                          <div
                            className="w-full rounded-t bg-amber-600"
                            style={{ height: Math.max(3, height(owed)) }}
                          />
                        )}
                        {m.collected > 0 && (
                          <div
                            className={`w-full bg-teal-600 ${owed > 0 ? "mt-0.5 rounded-b" : "rounded"}`}
                            style={{ height: Math.max(3, height(m.collected)) }}
                          />
                        )}
                        {m.expected === 0 && (
                          <div className="w-full rounded-sm bg-slate-100" style={{ height: 3 }} />
                        )}
                      </div>
                      <div className="mt-1.5 text-xs text-slate-500">{m.month.slice(5)}</div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="grid gap-4 lg:grid-cols-2">
            {/* When the place is actually busy. One hue; the peak is the point. */}
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <h3 className="text-sm font-semibold">Hours sold, by time of day</h3>
              <p className="mt-0.5 text-xs text-slate-500">
                Where peak really is — worth checking your peak rate against.
              </p>
              <div className="mt-4 flex h-32 items-end gap-0.5">
                {report.byHour.map((h) => (
                  <div
                    key={h.hour}
                    className="group relative flex flex-1 flex-col justify-end"
                    style={{ height: "100%" }}
                    title={`${formatHour(h.hour)} — ${h.hours} hours sold`}
                  >
                    <div
                      className={`w-full rounded-t ${
                        peakHour && h.hour === peakHour.hour && h.hours > 0
                          ? "bg-teal-700"
                          : "bg-teal-600"
                      } ${h.hours === 0 ? "bg-slate-100" : ""}`}
                      style={{
                        height: `${h.hours === 0 ? 2 : Math.max(4, (h.hours / hourPeak) * 100)}%`,
                      }}
                    />
                    <span className="pointer-events-none absolute -top-5 left-1/2 hidden -translate-x-1/2 whitespace-nowrap rounded bg-slate-900 px-1.5 py-0.5 text-[10px] font-medium text-white group-hover:block">
                      {h.hours}
                    </span>
                  </div>
                ))}
              </div>
              <div className="mt-1.5 flex justify-between text-xs text-slate-500">
                <span>{formatHour(report.byHour[0]?.hour ?? 0)}</span>
                {peakHour && peakHour.hours > 0 && (
                  <span className="font-medium text-teal-700">
                    busiest {formatHour(peakHour.hour)} · {peakHour.hours} hrs
                  </span>
                )}
                <span>{formatHour(report.byHour[report.byHour.length - 1]?.hour ?? 0)}</span>
              </div>
            </div>

            {/* What the venue still owes people. Numbers, not a chart. */}
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <h3 className="text-sm font-semibold">What you still owe</h3>
              <p className="mt-0.5 text-xs text-slate-500">
                Sold and not yet used. These are hours and visits people can still come and take.
              </p>
              <dl className="mt-3 space-y-2 text-sm">
                {[
                  [
                    "Unspent pass entries",
                    `${report.liabilities.passEntriesUnspent} hours`,
                    `across ${report.liabilities.passesLive} live passes`,
                  ],
                  [
                    "Memberships running",
                    `${report.liabilities.membershipsActive}`,
                    `${report.liabilities.membershipsExpiringSoon} lapse within a month`,
                  ],
                  ...(data?.venueCredit
                    ? ([
                        [
                          "Stored credit sold here",
                          ringgit(data.venueCredit.balance),
                          `held by ${data.venueCredit.customers} customers, spendable only here`,
                        ],
                      ] as [string, string, string][])
                    : ([] as [string, string, string][])),
                  ...(data?.wallet
                    ? ([
                        [
                          data.venueCredit ? "Stored credit (any venue, owed by the platform)" : "Stored credit (all venues)",
                          ringgit(data.wallet.balance),
                          `held by ${data.wallet.customers} customers`,
                        ],
                      ] as [string, string, string][])
                    : ([] as [string, string, string][])),
                ].map(([label, value, note]) => (
                  <div
                    key={label}
                    className="flex items-baseline justify-between gap-3 border-b border-slate-100 pb-2 last:border-0"
                  >
                    <div>
                      <dt className="font-medium text-slate-700">{label}</dt>
                      <dd className="text-xs text-slate-500">{note}</dd>
                    </div>
                    <div className="shrink-0 font-semibold text-slate-900">{value}</div>
                  </div>
                ))}
              </dl>
              {report.closedDays > 0 && (
                <p className="mt-3 text-xs text-slate-500">
                  {report.closedDays === 1
                    ? "1 closed day in this period is"
                    : `${report.closedDays} closed days in this period are`}{" "}
                  left out of the sellable hours.
                </p>
              )}
            </div>
          </div>

          {/* Per court: a ratio against a limit, so a meter each. */}
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <h3 className="text-sm font-semibold">How hard each court worked</h3>
            <div className="mt-3 space-y-2.5">
              {report.byCourt.map((c) => (
                <div key={c.courtId} className="flex flex-wrap items-center gap-3 text-sm">
                  <div className="w-44 shrink-0">
                    {SPORT_ICONS[c.sport]} {c.courtName}
                  </div>
                  <div
                    className="h-3 min-w-[8rem] flex-1 overflow-hidden rounded-full bg-slate-100"
                    title={`${c.hours} of ${c.sellableHours} sellable hours`}
                  >
                    <div
                      className="h-full rounded-full bg-teal-600"
                      style={{
                        width:
                          c.hours === 0
                            ? 0
                            : `max(3px, ${Math.min(100, c.utilisation * 100)}%)`,
                      }}
                    />
                  </div>
                  <div className="w-14 shrink-0 text-right font-semibold tabular-nums">
                    {percent(c.utilisation)}
                  </div>
                  <div className="w-24 shrink-0 text-right text-slate-500 tabular-nums">
                    {ringgit(c.expected)}
                  </div>
                </div>
              ))}
              {report.byCourt.length === 0 && (
                <p className="text-sm text-slate-500">This venue has no courts yet.</p>
              )}
            </div>
          </div>

          {/* More than a couple of measures per row: a table, not more colours. */}
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  {["Sport", "Bookings", "Hours", "Booked", "Collected"].map((h) => (
                    <th key={h} className="px-3 py-2 font-semibold">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.bySport.map((s) => (
                  <tr key={s.sport} className="border-b border-slate-100 last:border-0">
                    <td className="px-3 py-2">
                      {SPORT_ICONS[s.sport]} {SPORT_LABELS[s.sport]}
                    </td>
                    <td className="px-3 py-2 tabular-nums">{s.bookings}</td>
                    <td className="px-3 py-2 tabular-nums">{s.hours}</td>
                    <td className="px-3 py-2 tabular-nums">{ringgit(s.expected)}</td>
                    <td className="px-3 py-2 font-medium tabular-nums text-teal-700">
                      {ringgit(s.collected)}
                    </td>
                  </tr>
                ))}
                {report.bySport.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-3 py-6 text-center text-slate-500">
                      Nothing was booked at {report.venueName} between {report.from} and{" "}
                      {report.to}.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </>
      ) : null}
      {/* For the accountant: every booking, and every payment taken online, as a spreadsheet. */}
      <div className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm">
        <span className="font-semibold">Download for your accountant ({range.from} to {range.to}):</span>
        {(["bookings", "payments", "journal", "summary"] as const).map((kind) => (
          <a
            key={kind}
            href={`/api/admin/export?venueId=${venueId}&from=${range.from}&to=${range.to}&kind=${kind}`}
            className="rounded-md border border-slate-300 px-3 py-1 font-medium text-teal-700 hover:border-teal-500"
          >
            {
              {
                bookings: "Bookings (CSV)",
                payments: "Online payments (CSV)",
                journal: "Sales journal: every receipt and credit note (CSV)",
                summary: "Sales summary by category and payment (CSV)",
              }[kind]
            }
          </a>
        ))}
      </div>
      <ActivityPanel venueId={venueId} from={range.from} to={range.to} />
    </div>
  );
}
