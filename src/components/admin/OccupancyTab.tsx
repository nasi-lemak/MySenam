"use client";

import { readJson } from "@/lib/read-response";
import { activityIcon } from "@/lib/activity-registry";
import { useCallback, useEffect, useState } from "react";

import type { Court, Venue } from "@/lib/types";
import type { OccupancyReport } from "@/lib/store";
import { intlTag } from "@/lib/region";
import { useStaffT } from "./StaffLanguage";

/* ---------------- Occupancy tab ---------------- */

export function OccupancyTab({
  venues,
}: {
  venues: (Venue & { courts: Court[] })[];
}) {
  const t = useStaffT();
  const [venueId, setVenueId] = useState(venues[0]?.id ?? 1);
  const [report, setReport] = useState<OccupancyReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/admin/occupancy?venueId=${venueId}&days=7`, {
        cache: "no-store",
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(t.err(data, t("occ.loadFailed")));
      setReport(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("occ.loadFailed"));
      setReport(null);
    }
  }, [venueId, t]);

  useEffect(() => {
    load();
  }, [load]);

  function heat(pct: number): string {
    if (pct === 0) return "bg-white text-slate-400";
    if (pct < 25) return "bg-teal-50 text-teal-700";
    if (pct < 50) return "bg-teal-100 text-teal-800";
    if (pct < 75) return "bg-teal-300 text-teal-900";
    return "bg-teal-600 text-white";
  }

  return (
    <div className="space-y-4">
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

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {report && (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full min-w-[700px] text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left">
                <th className="px-3 py-2 font-semibold">{t("occ.court")}</th>
                {report.days.map((d) => (
                  <th key={d.date} className="px-2 py-2 text-center font-medium text-slate-500">
                    {new Date(`${d.date}T00:00:00Z`).toLocaleDateString(intlTag(t.locale), {
                      weekday: "short",
                      day: "numeric",
                      timeZone: "UTC",
                    })}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {report.courts.map((court) => (
                <tr key={court.id} className="border-b border-slate-100 last:border-0">
                  <td className="whitespace-nowrap px-3 py-2 font-medium">
                    {activityIcon(court.sport)} {court.name}
                  </td>
                  {report.days.map((d) => {
                    const cell = d.perCourt.find((c) => c.courtId === court.id);
                    const booked = cell?.booked ?? 0;
                    // What could have been sold, after places taken out of service (lib/store.ts, getOccupancy).
                    const places = cell?.sellable ?? report.totalSlotsPerDay * court.capacity;
                    const pct = places > 0 ? Math.round((booked / places) * 100) : 0;
                    return (
                      <td key={d.date} className="p-1 text-center">
                        <div
                          className={`rounded-md py-1.5 text-xs font-semibold ${heat(pct)}`}
                          title={cell?.blocked ? t("occ.cellBlocked", { booked, places, out: cell.blocked }) : t("occ.cell", { booked, places })}
                        >
                          {booked > 0 ? `${pct}%` : "·"}
                          {cell?.blocked ? <span className="ml-0.5">⛔</span> : null}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
              {/* The venue's totals as the reports measure them (B11): the courts' floor once, shared facilities apart. */}
              {(["courts", "shared"] as const).map((kind, i) =>
                report.days.some((d) => d.totals?.[kind]) ? (
                  <tr
                    key={kind}
                    className={`bg-slate-50 font-semibold ${i === 0 || !report.days.some((d) => d.totals?.courts) ? "border-t-2 border-slate-200" : ""}`}
                  >
                    <td className="whitespace-nowrap px-3 py-2">{t(kind === "courts" ? "occ5.floor" : "occ5.shared")}</td>
                    {report.days.map((d) => {
                      const total = d.totals?.[kind];
                      const sold = Math.round((total?.soldHours ?? 0) * 10) / 10;
                      const sellable = Math.round((total?.sellableHours ?? 0) * 10) / 10;
                      return (
                        <td
                          key={d.date}
                          className="px-2 py-2 text-center text-teal-700"
                          title={t(kind === "courts" ? "occ5.floorTitle" : "occ5.sharedTitle", { sold, sellable })}
                        >
                          {Math.round((total?.percent ?? 0) * 100)}%
                        </td>
                      );
                    })}
                  </tr>
                ) : null
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
