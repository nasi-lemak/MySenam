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
} from "@/lib/types";
import type { SearchResult } from "@/lib/store";
import { useT } from "@/components/Language";
import { translateError } from "@/lib/i18n";
import { INTL_TAGS, sportLabel } from "@/lib/i18n";
import type { T } from "@/lib/i18n";
import { NearPicker, type NearChoice } from "@/components/NearPicker";
import { Highlights } from "@/components/VenueFacilities";
import { FILTER_CHIPS, FILTER_ICONS, highlights, type FilterChip } from "@/lib/facilities";
import { photoAt, type Photo } from "@/lib/photos-shared";

// Every hour a booking could start at, across all venues. Each venue's own
// trading hours narrow this further when the search runs.
const HOURS = Array.from({ length: CLOSE_HOUR - OPEN_HOUR }, (_, i) => OPEN_HOUR + i);

function dateLabel(t: T, date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  return d.toLocaleDateString(INTL_TAGS[t.locale], {
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
  distanceKm?: number;
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
        distanceKm: r.distanceKm,
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
  const t = useT();
  const today = todayISO();
  const dates = Array.from({ length: MAX_ADVANCE_DAYS + 1 }, (_, i) => addDays(today, i));

  const [sport, setSport] = useState<Sport>("badminton");
  const [date, setDate] = useState(today);
  const [fromHour, setFromHour] = useState(OPEN_HOUR);
  const [toHour, setToHour] = useState(CLOSE_HOUR - 1);
  const [duration, setDuration] = useState(1);
  const [area, setArea] = useState("");
  const [near, setNear] = useState<NearChoice | null>(null);
  const [has, setHas] = useState<FilterChip[]>([]);
  const [covers, setCovers] = useState<Record<string, Photo>>({});
  const [areas, setAreas] = useState<string[]>([]);
  const [results, setResults] = useState<SearchResult[] | null>(null);
  // A whole marketplace is too many courts to search at once; the server says
  // so, and the page asks for an area instead of showing nothing.
  const [needsArea, setNeedsArea] = useState(false);
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
      // Near somewhere is where; an area on top of it would only narrow it oddly.
      if (near) {
        params.set("near", `${near.lat.toFixed(5)},${near.lng.toFixed(5)}`);
        params.set("km", String(near.km));
      } else if (area) params.set("area", area);
      if (has.length > 0) params.set("has", has.join(","));
      const res = await fetch(`/api/search?${params}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(translateError(t, data) || t("search.failed"));
      setResults(data.results);
      setCovers(data.covers ?? {});
      setAreas(data.areas);
      setNeedsArea(Boolean(data.needsArea));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("search.failed"));
      setResults(null);
    } finally {
      setLoading(false);
    }
  }, [sport, date, fromHour, toHour, duration, area, near, has, t]);

  useEffect(() => {
    search();
  }, [search]);

  const selectClass =
    "mt-1 rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-teal-500 focus:outline-none";

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t("search.title")}</h1>
        <p className="mt-1 text-sm text-slate-600">
          {t("search.intro")}
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
              {SPORT_ICONS[s]} {sportLabel(t, s)}
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
              {d === today ? t("search.today") : dateLabel(t, d)}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-end gap-3">
          <label className="flex flex-col text-xs font-medium text-slate-500">
            {t("search.from")}
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
            {t("search.until")}
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
            {t("search.for")}
            <select
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
              className={selectClass}
            >
              {Array.from({ length: MAX_HOURS_PER_BOOKING }, (_, i) => i + 1).map((d) => (
                <option key={d} value={d}>
                  {t.plural("search.hours", d)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col text-xs font-medium text-slate-500">
            {t("search.area")}
            <select value={area} onChange={(e) => setArea(e.target.value)} className={selectClass} disabled={near !== null}>
              <option value="">{t("search.anywhere")}</option>
              {areas.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </label>
        </div>
        <NearPicker value={near} onChange={setNear} />
        <div className="flex flex-wrap items-center gap-2 text-sm" role="group" aria-label={t("fac.filterTitle")}>
          <span className="text-slate-500">{t("fac.filterTitle")}:</span>
          {FILTER_CHIPS.map((f) => {
            const on = has.includes(f);
            return (
              <button
                key={f}
                type="button"
                aria-pressed={on}
                onClick={() => setHas(on ? has.filter((x) => x !== f) : [...has, f])}
                className={`rounded-full border px-3 py-1 ${on ? "border-teal-600 bg-teal-600 text-white" : "border-slate-200 bg-white text-slate-700 hover:border-teal-500"}`}
              >
                {FILTER_ICONS[f]} {t(`fac.${f}`)}
              </button>
            );
          })}
        </div>
      </div>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {loading ? (
        <div className="rounded-xl border border-slate-200 bg-white p-10 text-center text-slate-500">
          {t("search.working")}
        </div>
      ) : needsArea ? (
        <div className="rounded-xl border border-teal-200 bg-teal-50 p-6 text-center text-teal-800">
          {near ? t("near.tooMany") : t("search.needsArea")}
        </div>
      ) : results && results.length > 0 ? (
        (() => {
          const groups = groupResults(results);
          return (
            <div>
              <p className="mb-3 text-sm text-slate-600">
                {t.plural("search.count", groups.length)}{" "}
                <span className="font-medium">{sportLabel(t, sport).toLowerCase()}</span>{" "}
                {t("search.on")} <span className="font-medium">{dateLabel(t, date)}</span>
              </p>
              <ul className="space-y-2">
                {groups.map((g) => {
                  const cheapest = g.courts[0];
                  // The server sends one court per venue and time, and counts the rest.
                  const others = cheapest.alsoFree ?? g.courts.length - 1;
                  return (
                    <li
                      key={g.key}
                      className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-teal-400"
                    >
                      <div className="w-32 shrink-0 font-semibold text-teal-700">
                        {formatHour(g.startHour)}
                        <div className="text-xs font-normal text-slate-400">
                          {t("search.to", { time: formatHour(g.endHour) })}
                        </div>
                      </div>
                      {covers[g.venueId] && (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img
                          src={photoAt(covers[g.venueId], 400)}
                          alt=""
                          width={64}
                          height={48}
                          loading="lazy"
                          decoding="async"
                          className="h-12 w-16 shrink-0 rounded-md object-cover"
                          style={{ backgroundColor: covers[g.venueId].color }}
                        />
                      )}
                      <div className="min-w-[12rem] flex-1">
                        <div className="font-medium">{g.venueName}</div>
                        <div className="text-sm text-slate-500">
                          📍 {g.area}
                          {g.distanceKm !== undefined && ` · ${t("near.away", { km: g.distanceKm })}`} ·{" "}
                          {SPORT_ICONS[cheapest.court.sport]} {cheapest.court.name}
                          {others > 0 && (
                            <span className="text-slate-400">
                              {" "}
                              {t.plural("search.moreCourts", others)}
                            </span>
                          )}
                        </div>
                        <Highlights t={t} items={highlights([cheapest.court], cheapest.venue.amenities ?? [])} />
                      </div>
                      <div className="text-right">
                        <div className="font-bold">RM{cheapest.totalPrice}</div>
                        {others > 0 && cheapest.pricesVary && (
                          <div className="text-xs text-slate-400">{t("search.fromPrice")}</div>
                        )}
                      </div>
                      <Link
                        href={`/venue/${g.venueId}?date=${date}&sport=${cheapest.court.sport}&court=${cheapest.court.id}&hour=${g.startHour}&duration=${g.endHour - g.startHour}`}
                        className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700"
                      >
                        {t("search.book")}
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
          {near ? t("near.none", { km: near.km }) : t("search.none", { sport: sportLabel(t, sport).toLowerCase() })}
        </div>
      )}
    </div>
  );
}
