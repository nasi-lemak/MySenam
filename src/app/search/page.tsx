"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { formatHour, todayISO, addDays } from "@/lib/time";
import {
  CLOSE_HOUR,
  MAX_ADVANCE_DAYS,
  MAX_HOURS_PER_BOOKING,
  OPEN_HOUR,
  Sport,
  SPORTS,
  SPORT_ICONS,
  SPORT_LABELS,
} from "@/lib/types";
import type { SearchResult } from "@/lib/store";

const HOURS = Array.from({ length: CLOSE_HOUR - OPEN_HOUR + 1 }, (_, i) => OPEN_HOUR + i);

function dateLabel(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return d.toLocaleDateString("en-MY", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "UTC",
  });
}

interface ResultGroup {
  key: string;
  venueId: number;
  venueName: string;
  area: string;
  startHour: number;
  endHour: number;
  /** Cheapest first — the Book button targets courts[0]. */
  courts: SearchResult[];
}

/** One row per venue + start time, rather than one per identical court. */
function groupResults(results: SearchResult[]): ResultGroup[] {
  const groups = new Map<string, ResultGroup>();
  for (const r of results) {
    const key = `${r.venue.id}:${r.startHour}`;
    const group = groups.get(key);
    if (group) {
      group.courts.push(r);
    } else {
      groups.set(key, {
        key,
        venueId: r.venue.id,
        venueName: r.venue.name,
        area: r.venue.area,
        startHour: r.startHour,
        endHour: r.endHour,
        courts: [r],
      });
    }
  }
  // results arrive time-then-price ordered, so each group is already cheapest-first
  return [...groups.values()];
}

export default function SearchPage() {
  const today = todayISO();
  const dates = Array.from({ length: MAX_ADVANCE_DAYS + 1 }, (_, i) => addDays(today, i));

  const [sport, setSport] = useState<Sport>("badminton");
  const [date, setDate] = useState(today);
  const [fromHour, setFromHour] = useState(OPEN_HOUR);
  const [toHour, setToHour] = useState(CLOSE_HOUR);
  const [duration, setDuration] = useState(1);
  const [area, setArea] = useState("");
  const [areas, setAreas] = useState<string[]>([]);
  const [results, setResults] = useState<SearchResult[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const search = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        sport,
        date,
        from: String(fromHour),
        to: String(toHour),
        duration: String(duration),
      });
      if (area) params.set("area", area);
      const res = await fetch(`/api/search?${params}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Search failed");
      setResults(data.results);
      setAreas(data.areas);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Search failed");
      setResults(null);
    } finally {
      setLoading(false);
    }
  }, [sport, date, fromHour, toHour, duration, area]);

  useEffect(() => {
    search();
  }, [search]);

  const selectClass =
    "mt-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-teal-500 focus:outline-none";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">Find a court</h1>
        <p className="mt-1 text-sm text-slate-600">
          Search every venue at once — pick a sport and a time, and see what&apos;s free.
        </p>
      </div>

      <div className="space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <div className="flex flex-wrap gap-2">
          {SPORTS.map((s) => (
            <button
              key={s}
              onClick={() => setSport(s)}
              className={`rounded-full px-4 py-1.5 text-sm font-medium transition ${
                s === sport
                  ? "bg-teal-600 text-white shadow"
                  : "bg-white text-slate-600 ring-1 ring-slate-200 hover:ring-teal-400"
              }`}
            >
              {SPORT_ICONS[s]} {SPORT_LABELS[s]}
            </button>
          ))}
        </div>

        <div className="flex gap-2 overflow-x-auto pb-1">
          {dates.map((d) => (
            <button
              key={d}
              onClick={() => setDate(d)}
              className={`shrink-0 rounded-lg border px-3 py-1.5 text-sm transition ${
                d === date
                  ? "border-teal-600 bg-teal-600 text-white shadow"
                  : "border-slate-200 bg-white text-slate-700 hover:border-teal-400"
              }`}
            >
              {d === today ? "Today" : dateLabel(d)}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col text-xs font-medium text-slate-500">
            From
            <select
              value={fromHour}
              onChange={(e) => {
                const v = Number(e.target.value);
                setFromHour(v);
                if (v > toHour) setToHour(v);
              }}
              className={selectClass}
            >
              {HOURS.slice(0, -1).map((h) => (
                <option key={h} value={h}>
                  {formatHour(h)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col text-xs font-medium text-slate-500">
            Until
            <select
              value={toHour}
              onChange={(e) => setToHour(Number(e.target.value))}
              className={selectClass}
            >
              {HOURS.filter((h) => h >= fromHour).map((h) => (
                <option key={h} value={h}>
                  {formatHour(h)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col text-xs font-medium text-slate-500">
            For
            <select
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
              className={selectClass}
            >
              {Array.from({ length: MAX_HOURS_PER_BOOKING }, (_, i) => i + 1).map((d) => (
                <option key={d} value={d}>
                  {d} hour{d > 1 ? "s" : ""}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col text-xs font-medium text-slate-500">
            Area
            <select value={area} onChange={(e) => setArea(e.target.value)} className={selectClass}>
              <option value="">Anywhere</option>
              {areas.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {loading ? (
        <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-slate-500">
          Searching…
        </div>
      ) : results && results.length > 0 ? (
        (() => {
          const groups = groupResults(results);
          return (
            <div>
              <p className="mb-3 text-sm text-slate-600">
                {groups.length} venue slot{groups.length > 1 ? "s" : ""} for{" "}
                <span className="font-medium">{SPORT_LABELS[sport].toLowerCase()}</span> on{" "}
                <span className="font-medium">{dateLabel(date)}</span>
              </p>
              <ul className="space-y-2">
                {groups.map((g) => {
                  const cheapest = g.courts[0];
                  const others = g.courts.length - 1;
                  return (
                    <li
                      key={g.key}
                      className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-teal-400"
                    >
                      <div className="w-32 shrink-0 font-semibold text-teal-700">
                        {formatHour(g.startHour)}
                        <div className="text-xs font-normal text-slate-400">
                          to {formatHour(g.endHour)}
                        </div>
                      </div>
                      <div className="min-w-[12rem] flex-1">
                        <div className="font-medium">{g.venueName}</div>
                        <div className="text-sm text-slate-500">
                          📍 {g.area} · {SPORT_ICONS[cheapest.court.sport]} {cheapest.court.name}
                          {others > 0 && (
                            <span className="text-slate-400">
                              {" "}
                              +{others} more court{others > 1 ? "s" : ""} free
                            </span>
                          )}
                        </div>
                      </div>
                      <div className="text-right">
                        <div className="font-bold">RM{cheapest.totalPrice}</div>
                        {others > 0 && cheapest.totalPrice !== g.courts[g.courts.length - 1].totalPrice && (
                          <div className="text-xs text-slate-400">from</div>
                        )}
                      </div>
                      <Link
                        href={`/venue/${g.venueId}?date=${date}&sport=${cheapest.court.sport}&court=${cheapest.court.id}&hour=${g.startHour}&duration=${g.endHour - g.startHour}`}
                        className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700"
                      >
                        Book
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })()
      ) : (
        <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-slate-500">
          No {SPORT_LABELS[sport].toLowerCase()} courts free in that window. Try a wider time range,
          another day, or a different area.
        </div>
      )}
    </div>
  );
}
