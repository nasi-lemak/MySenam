"use client";

import { readJson } from "@/lib/read-response";
import { activityIcon } from "@/lib/activity-registry";
import type { CreditPosition } from "@/lib/reports";
import { useCallback, useEffect, useRef, useState } from "react";
import { CoachPayoutsPanel } from "./CoachPayoutsPanel";
import { CustomerReportPanel } from "./CustomerReportPanel";
import { formatHour } from "@/lib/time";
import { PAID_VIA_LABELS } from "@/lib/types";
import { sportLabel } from "@/lib/i18n";
import type { StaffPhrase, StaffT } from "@/lib/staff-i18n";
import { useStaffT } from "./StaffLanguage";
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
const RANGES: [StaffPhrase, () => { from: string; to: string }][] = [
  ["rpt.range.last30", () => ({ from: daysAgo(29), to: todayLocal() })],
  ["rpt.range.thisMonth", () => ({ from: monthStart(0), to: todayLocal() })],
  // The month the accountant asks for at the start of the next (X1-8): its first day to its last.
  ["p8b.rpt.lastMonth", () => lastMonth()],
  ["rpt.range.last3", () => ({ from: monthStart(2), to: todayLocal() })],
];

/** Last calendar month as the venue's staff count it (from their today), first day to last, as YYYY-MM-DD. */
export function lastMonth(today: string = todayLocal()): { from: string; to: string } {
  const [y, m] = today.split("-").map(Number);
  const from = new Date(Date.UTC(y, m - 2, 1));
  const to = new Date(Date.UTC(y, m - 1, 0));
  return { from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
}

const ringgit = (n: number) => {
  const r = Math.round(n * 100) / 100;
  const cents = Number.isInteger(r) ? 0 : 2;
  return money(r.toLocaleString(intlTag("en"), { minimumFractionDigits: cents, maximumFractionDigits: cents }));
};

/** A phrase split around one placeholder, so a value can be set in its own element wherever the language puts it. */
function around(t: StaffT, phrase: StaffPhrase, name: string): [string, string] {
  const [before, after = ""] = t(phrase, { [name]: "\u0000" }).split("\u0000");
  return [before, after];
}

/**
 * What the owner asks at the end of a month.
 *
 * Two colours do all the work and they mean one thing each: teal is money in
 * hand, amber is money still owed. Both are direct-labelled and carry a legend,
 * so nothing here is readable only by colour.
 */
export function ReportsTab({ venues }: { venues: ManagedVenue[] }) {
  const t = useStaffT();
  const [venueId, setVenueId] = useState(venues[0]?.id ?? 1);
  const [range, setRange] = useState(() => RANGES[0][1]());
  const [data, setData] = useState<{
    report: VenueReport;
    wallet: CreditPosition | null;
    venueCredit?: CreditPosition | null;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The latest venue and period asked for: an answer for one asked for earlier that arrives later is
  // dropped, so a venue's figures never show under another venue's name.
  const asked = useRef(0);
  const load = useCallback(async () => {
    const mine = ++asked.current;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/admin/reports?venueId=${venueId}&from=${range.from}&to=${range.to}`,
        { cache: "no-store" }
      );
      const body = await readJson(res);
      if (mine !== asked.current) return;
      if (!res.ok) throw new Error(t.err(body, t("rpt.failed")));
      setData(body);
    } catch (err) {
      if (mine !== asked.current) return;
      setError(err instanceof Error ? err.message : t("rpt.failed"));
      setData(null);
    } finally {
      if (mine === asked.current) setBusy(false);
    }
  }, [venueId, range, t]);

  useEffect(() => {
    load();
  }, [load]);

  const report = data?.report;
  const peakHour = report
    ? report.byHour.reduce((best, h) => (h.hours > best.hours ? h : best), report.byHour[0])
    : null;
  const monthPeak = report ? Math.max(1, ...report.byMonth.map((m) => m.expected)) : 1;
  const hourPeak = report ? Math.max(1, ...report.byHour.map((h) => h.hours)) : 1;
  const perHour = around(t, "rpt.perHour", "amount");
  const sharedFloors = around(t, "rpt.sharedFloors", "pct");

  return (
    <div className="space-y-5">
      {/* Filters, one row, above everything they change. */}
      <div className="flex flex-wrap items-end gap-2">
        <select aria-label={t("q8b.l.venue")}
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
          aria-label={t("c.from")}
          onChange={(e) => setRange({ ...range, from: e.target.value })}
          className="rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
        />
        <input
          type="date"
          value={range.to}
          aria-label={t("c.until")}
          min={range.from}
          onChange={(e) => setRange({ ...range, to: e.target.value })}
          className="rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
        />
        {RANGES.map(([label, make]) => (
          <button
            key={label}
            onClick={() => setRange(make())}
            className="rounded-lg border border-slate-300 px-3 py-2 text-xs font-medium text-slate-600 hover:border-teal-500 hover:text-teal-700"
          >
            {t(label)}
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
          {t("rpt.working")}
        </div>
      ) : report ? (
        <>
          {/* The four numbers the month is judged on. */}
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
                {t("rpt.collected")}
              </div>
              <div className="mt-1 text-3xl font-bold tracking-tight text-teal-700">
                {ringgit(report.revenue.collected)}
              </div>
              <div className="mt-0.5 text-xs text-slate-500">
                {t("rpt.ofBooked", { amount: ringgit(report.revenue.expected) })}
              </div>
              {report.revenue.tax && (
                <div className="mt-0.5 text-xs text-slate-600">
                  {t("rpt.includingTax", { tax: report.revenue.tax.name, amount: ringgit(report.revenue.tax.amount) })}
                </div>
              )}
              {report.collectedBy.length > 0 && (
                <ul className="mt-2 space-y-0.5 text-xs text-slate-600">
                  {report.collectedBy.map((c) => (
                    <li key={c.via} className="flex justify-between gap-2">
                      <span>{c.via in PAID_VIA_LABELS ? t(`c.via.${c.via as keyof typeof PAID_VIA_LABELS}`) : t("rpt.notRecorded")}</span>
                      <span className="font-medium">{ringgit(c.amount)}</span>
                    </li>
                  ))}
                </ul>
              )}
              {report.counterSales.sales > 0 && (
                <div className="mt-2 border-t border-slate-100 pt-2 text-xs text-slate-600">
                  {t("rpt.counterSales")} <span className="font-medium">{ringgit(report.counterSales.total)}</span> ({report.counterSales.sales})
                </div>
              )}
              {report.testTakings.bookings > 0 && (
                <div className="mt-2 border-t border-slate-100 pt-2 text-xs text-slate-600">
                  {t.plural("r10a.rpt.tests", report.testTakings.bookings, { amount: ringgit(report.testTakings.collected) })}
                </div>
              )}
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
                {t("rpt.stillOwed")}
              </div>
              <div
                className={`mt-1 text-3xl font-bold tracking-tight ${
                  report.revenue.outstanding > 0 ? "text-amber-700" : "text-slate-400"
                }`}
              >
                {ringgit(report.revenue.outstanding)}
              </div>
              <div className="mt-0.5 text-xs text-slate-500">
                {t("rpt.acrossBookings", { n: report.bookings.confirmed })}
              </div>
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
                {t("rpt.howFull")}
              </div>
              <div className="mt-1 text-3xl font-bold tracking-tight text-slate-900">
                {percent(report.utilisation.courts.percent)}
              </div>
              <div className="mt-0.5 text-xs text-slate-500">
                {t("rpt.floor", {
                  sold: report.utilisation.courts.soldHours.toLocaleString(intlTag(t.locale)),
                  sellable: report.utilisation.courts.sellableHours.toLocaleString(intlTag(t.locale)),
                })}
              </div>
              {report.utilisation.courts.sellableHours > 0 && (
                <div className="mt-1 text-xs text-slate-500">
                  {perHour[0]}
                  <span className="font-semibold text-slate-700">{ringgit(report.utilisation.revenuePerHour)}</span>
                  {perHour[1]}
                </div>
              )}
              {report.utilisation.shared.sellableHours > 0 && (
                <div className="mt-1 text-xs text-slate-500">
                  {sharedFloors[0]}
                  <span className="font-semibold text-slate-700">
                    {percent(report.utilisation.shared.percent)}
                  </span>
                  {sharedFloors[1]}
                </div>
              )}
            </div>
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="text-xs font-medium uppercase tracking-wide text-slate-500">
                {t("rpt.cancelledNoShows")}
              </div>
              <div className="mt-1 text-3xl font-bold tracking-tight text-slate-900">
                {report.bookings.cancelled + report.bookings.noShows}
              </div>
              <div className="mt-0.5 text-xs text-slate-500">
                {t("rpt.cancelledBreakdown", { cancelled: report.bookings.cancelled, noShows: report.bookings.noShows })}
              </div>
            </div>
          </div>

          {/* Money by month. Only earns a chart once there is more than one. */}
          {report.byMonth.length > 1 && (
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h3 className="text-sm font-semibold">{t("rpt.takenByMonth")}</h3>
                <div className="flex items-center gap-3 text-xs text-slate-600">
                  <span className="flex items-center gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-sm bg-teal-600" /> {t("rpt.collected")}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="h-2.5 w-2.5 rounded-sm bg-amber-600" /> {t("rpt.stillOwed")}
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
                        title={t("rpt.monthTitle", { month: m.month, collected: ringgit(m.collected), owed: ringgit(owed), hours: m.hours })}
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
              <h3 className="text-sm font-semibold">{t("rpt.hoursByTime")}</h3>
              <p className="mt-0.5 text-xs text-slate-500">
                {t("rpt.wherePeak")}
              </p>
              <div className="mt-4 flex h-32 items-end gap-0.5">
                {report.byHour.map((h) => (
                  <div
                    key={h.hour}
                    className="group relative flex flex-1 flex-col justify-end"
                    style={{ height: "100%" }}
                    title={t("rpt.hourTitle", { hour: formatHour(h.hour, t.locale), n: h.hours })}
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
                <span>{formatHour(report.byHour[0]?.hour ?? 0, t.locale)}</span>
                {peakHour && peakHour.hours > 0 && (
                  <span className="font-medium text-teal-700">
                    {t("rpt.busiest", { hour: formatHour(peakHour.hour, t.locale), n: peakHour.hours })}
                  </span>
                )}
                <span>{formatHour(report.byHour[report.byHour.length - 1]?.hour ?? 0, t.locale)}</span>
              </div>
            </div>

            {/* What the venue still owes people. Numbers, not a chart. */}
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <h3 className="text-sm font-semibold">{t("rpt.stillOwe")}</h3>
              <p className="mt-0.5 text-xs text-slate-500">
                {t("rpt.stillOweIntro")}
              </p>
              <dl className="mt-3 space-y-2 text-sm">
                {[
                  [
                    t("rpt.passEntries"),
                    t("rpt.passHours", { n: report.liabilities.passEntriesUnspent }),
                    t("rpt.acrossPasses", { n: report.liabilities.passesLive }),
                  ],
                  [
                    t("rpt.memberships"),
                    `${report.liabilities.membershipsActive}`,
                    t("rpt.lapsing", { n: report.liabilities.membershipsExpiringSoon }),
                  ],
                  ...(data?.venueCredit
                    ? ([
                        [
                          t("rpt.venueCredit"),
                          ringgit(data.venueCredit.balance),
                          t("rpt.venueCreditNote", { n: data.venueCredit.customers }),
                        ],
                      ] as [string, string, string][])
                    : ([] as [string, string, string][])),
                  ...(data?.wallet
                    ? ([
                        [
                          data.venueCredit ? t("rpt.walletAny") : t("rpt.walletAll"),
                          ringgit(data.wallet.balance),
                          t("rpt.heldBy", { n: data.wallet.customers }),
                        ],
                      ] as [string, string, string][])
                    : ([] as [string, string, string][])),
                  // Customers below nothing after a chargeback: what they owe, kept apart, never netted or counted as income.
                  ...(
                    [
                      [data?.venueCredit, t("rpt.owedHere")],
                      [data?.wallet, data?.venueCredit ? t("rpt.owedAny") : t("rpt.owed")],
                    ] as [CreditPosition | null | undefined, string][]
                  )
                    .filter(([c]) => !!c && c.overdrawn.customers > 0)
                    .map(
                      ([c, label]) =>
                        [
                          label,
                          ringgit(c!.overdrawn.owing),
                          t("rpt.overdrawnNote", { n: c!.overdrawn.customers }),
                        ] as [string, string, string]
                    ),
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
                  {t.plural("rpt.closedDays", report.closedDays)}
                </p>
              )}
            </div>
          </div>

          {/* Per court: a ratio against a limit, so a meter each. */}
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <h3 className="text-sm font-semibold">{t("rpt.courtWork")}</h3>
            <div className="mt-3 space-y-2.5">
              {report.byCourt.map((c) => (
                <div key={c.courtId} className="flex flex-wrap items-center gap-3 text-sm">
                  <div className="w-44 shrink-0">
                    {activityIcon(c.sport)} {c.courtName}
                  </div>
                  <div
                    className="h-3 min-w-[8rem] flex-1 overflow-hidden rounded-full bg-slate-100"
                    title={t("rpt.courtTitle", { hours: c.hours, sellable: c.sellableHours })}
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
                  {c.inUseHours > c.hours && c.sellableHours > 0 && (
                    <div
                      className="w-24 shrink-0 text-right text-xs text-slate-500 tabular-nums"
                      title={t("rpt.inUseTitle")}
                    >
                      {t("rpt.inUse", { pct: percent(Math.min(1, c.inUseHours / c.sellableHours)) })}
                    </div>
                  )}
                  <div className="w-24 shrink-0 text-right text-slate-500 tabular-nums">
                    {ringgit(c.expected)}
                  </div>
                </div>
              ))}
              {report.byCourt.length === 0 && (
                <p className="text-sm text-slate-500">{t("rpt.noCourts")}</p>
              )}
            </div>
          </div>

          {/* More than a couple of measures per row: a table, not more colours. */}
          <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
            <table className="w-full min-w-[520px] text-sm">
              <thead>
                <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                  {(["rpt.col.sport", "rpt.col.bookings", "rpt.col.hours", "rpt.col.booked", "rpt.col.collected"] as const).map((h) => (
                    <th key={h} className="px-3 py-2 font-semibold">
                      {t(h)}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {report.bySport.map((s) => (
                  <tr key={s.sport} className="border-b border-slate-100 last:border-0">
                    <td className="px-3 py-2">
                      {activityIcon(s.sport)} {sportLabel(t.customer, s.sport)}
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
                      {t("rpt.nothingBooked", { venue: report.venueName, from: report.from, to: report.to })}
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
        <span className="font-semibold">{t("rpt.download", { from: range.from, to: range.to })}</span>
        {(["bookings", "payments", "journal", "summary"] as const).map((kind) => (
          <a
            key={kind}
            href={`/api/admin/export?venueId=${venueId}&from=${range.from}&to=${range.to}&kind=${kind}`}
            className="rounded-md border border-slate-300 px-3 py-1 font-medium text-teal-700 hover:border-teal-500"
          >
            {t(`rpt.export.${kind}`)}
          </a>
        ))}
      </div>
      <CustomerReportPanel venueId={venueId} from={range.from} to={range.to} />
      <CoachPayoutsPanel venueId={venueId} from={range.from} to={range.to} />
      <ActivityPanel venueId={venueId} from={range.from} to={range.to} />
    </div>
  );
}
