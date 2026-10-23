"use client";

import { activityIcon } from "@/lib/activity-registry";
import { useCallback, useEffect, useState } from "react";

import type { Court, Venue } from "@/lib/types";
import type { OccupancyReport } from "@/lib/store";
import { intlTag } from "@/lib/region";

/* ---------------- Occupancy tab ---------------- */

export function OccupancyTab({
  venues,
}: {
  venues: (Venue & { courts: Court[] })[];
}) {
  const [venueId, setVenueId] = useState(venues[0]?.id ?? 1);
  const [report, setReport] = useState<OccupancyReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/admin/occupancy?venueId=${venueId}&days=7`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load");
      setReport(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
      setReport(null);
    }
  }, [venueId]);

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
                <th className="px-3 py-2 font-semibold">Court</th>
                {report.days.map((d) => (
                  <th key={d.date} className="px-2 py-2 text-center font-medium text-slate-500">
                    {new Date(`${d.date}T00:00:00Z`).toLocaleDateString(intlTag("en"), {
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
                    const places = report.totalSlotsPerDay * court.capacity;
                    const pct = Math.round((booked / places) * 100);
                    return (
                      <td key={d.date} className="p-1 text-center">
                        <div
                          className={`rounded-md py-1.5 text-xs font-semibold ${heat(pct)}`}
                          title={`${booked}/${places} places booked${cell?.blocked ? `, ${cell.blocked} hours blocked` : ""}`}
                        >
                          {booked > 0 ? `${pct}%` : "·"}
                          {cell?.blocked ? <span className="ml-0.5">⛔</span> : null}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
              <tr className="border-t-2 border-slate-200 bg-slate-50 font-semibold">
                <td className="px-3 py-2">Venue total</td>
                {report.days.map((d) => {
                  const booked = d.perCourt.reduce((s, c) => s + c.booked, 0);
                  const total = report.courts.reduce(
                    (sum, c) => sum + report.totalSlotsPerDay * c.capacity,
                    0
                  );
                  const pct = total > 0 ? Math.round((booked / total) * 100) : 0;
                  return (
                    <td key={d.date} className="px-2 py-2 text-center text-teal-700">
                      {pct}%
                    </td>
                  );
                })}
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
