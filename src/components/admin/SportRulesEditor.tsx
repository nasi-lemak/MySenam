"use client";

import { useCallback, useEffect, useState } from "react";
import { formatHour } from "@/lib/time";
import { MAX_CANCEL_CUTOFF_HOURS, SPORT_LABELS, type Sport } from "@/lib/types";

interface SportPeak {
  weekdayFrom: number;
  weekdayUntil: number;
  weekendFrom: number;
  weekendUntil: number;
}

interface Rules {
  sport: Sport;
  cutoffHours: number | null;
  lateKeep: number | "none" | null;
  peak: SportPeak | null;
}

const CUTOFFS = [0, 1, 2, 3, 6, 12, 24, 48, MAX_CANCEL_CUTOFF_HOURS];
const KEEPS = [0, 25, 50, 75, 100];
const HOURS = Array.from({ length: 25 }, (_, h) => h);

/**
 * A sport's own rules here, over the venue's (lib/sport-rules.ts): when it can
 * be cancelled for free, what a late cancellation keeps, and its peak hours.
 * Anything left as "venue's" follows the venue's settings.
 */
export function SportRulesEditor({ venueId, sports }: { venueId: number; sports: Sport[] }) {
  const [rules, setRules] = useState<Rules[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/sport-rules?venueId=${venueId}`, { cache: "no-store" });
    const data = await res.json();
    if (res.ok) setRules(data.rules);
  }, [venueId]);
  useEffect(() => {
    void load();
  }, [load]);

  const of = (sport: Sport): Rules => rules?.find((r) => r.sport === sport) ?? { sport, cutoffHours: null, lateKeep: null, peak: null };

  async function save(next: Rules) {
    setError(null);
    setNotice(null);
    const res = await fetch("/api/admin/sport-rules", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ venueId, ...next }),
    });
    const data = await res.json();
    if (!res.ok) setError(data.error ?? "Could not save");
    else setNotice(`Saved the rules for ${SPORT_LABELS[next.sport]}.`);
    await load();
  }

  if (!rules || sports.length < 2) return null;
  return (
    <section className="overflow-x-auto rounded-xl border border-slate-200 bg-white p-4 text-sm shadow-sm">
      <h3 className="font-semibold">Rules by sport</h3>
      <p className="mt-1 text-xs text-slate-500">
        Where one sport needs different rules from the rest: tennis cancelled a day ahead while badminton is two hours, or pickleball
        at peak from 5 PM. Anything left on <em>venue&apos;s</em> follows the venue&apos;s settings. Customers see the sport&apos;s
        own rules before they book it.
      </p>
      <table className="mt-2 w-full min-w-[640px] text-xs">
        <thead>
          <tr className="text-left text-slate-500">
            <th className="py-1 pr-2 font-medium">Sport</th>
            <th className="py-1 pr-2 font-medium">Free cancellation until</th>
            <th className="py-1 pr-2 font-medium">Cancelled later, online</th>
            <th className="py-1 font-medium">Peak hours</th>
          </tr>
        </thead>
        <tbody>
          {sports.map((sport) => {
            const r = of(sport);
            const sel = "rounded-md border border-slate-300 px-1.5 py-1 text-xs";
            const peak = r.peak ?? { weekdayFrom: 18, weekdayUntil: 24, weekendFrom: 0, weekendUntil: 24 };
            const hourSel = (key: keyof SportPeak) => (
              <select value={peak[key]} onChange={(e) => save({ ...r, peak: { ...peak, [key]: Number(e.target.value) } })} className={sel}>
                {HOURS.map((h) => (
                  <option key={h} value={h}>
                    {h === 24 ? "midnight" : formatHour(h)}
                  </option>
                ))}
              </select>
            );
            return (
              <tr key={sport} className="border-t border-slate-100 align-top">
                <td className="py-1.5 pr-2 font-medium">{SPORT_LABELS[sport]}</td>
                <td className="py-1.5 pr-2">
                  <select
                    value={r.cutoffHours ?? ""}
                    onChange={(e) => save({ ...r, cutoffHours: e.target.value === "" ? null : Number(e.target.value) })}
                    className={sel}
                  >
                    <option value="">venue&apos;s</option>
                    {CUTOFFS.map((h) => (
                      <option key={h} value={h}>
                        {h === 0 ? "it starts" : `${h} hour${h === 1 ? "" : "s"} before`}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="py-1.5 pr-2">
                  <select
                    value={r.lateKeep === null ? "" : String(r.lateKeep)}
                    onChange={(e) =>
                      save({ ...r, lateKeep: e.target.value === "" ? null : e.target.value === "none" ? "none" : Number(e.target.value) })
                    }
                    className={sel}
                  >
                    <option value="">venue&apos;s</option>
                    <option value="none">not online: call</option>
                    {KEEPS.map((k) => (
                      <option key={k} value={k}>
                        keep {k}%
                      </option>
                    ))}
                  </select>
                </td>
                <td className="py-1.5">
                  {r.peak ? (
                    <span className="inline-flex flex-wrap items-center gap-1">
                      weekdays {hourSel("weekdayFrom")}–{hourSel("weekdayUntil")}, weekends {hourSel("weekendFrom")}–
                      {hourSel("weekendUntil")}
                      <button onClick={() => save({ ...r, peak: null })} className="text-teal-700 underline">
                        venue&apos;s
                      </button>
                    </span>
                  ) : (
                    <button onClick={() => save({ ...r, peak })} className="text-teal-700 underline">
                      venue&apos;s · set its own
                    </button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {error && <p className="mt-2 text-sm font-medium text-red-700">{error}</p>}
      {notice && <p className="mt-2 text-sm font-medium text-emerald-700">{notice}</p>}
    </section>
  );
}
