"use client";

import { readJson } from "@/lib/read-response";
import { activity, activityFilters, activityKeys, findActivities } from "@/lib/activity-registry";
import { ActivityGlyph } from "@/components/Glyph";
import { ACTIVITY_CATEGORIES } from "@/lib/activity-catalogue";
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { formatHour, todayISO, addDays } from "@/lib/time";
import { CLOSE_HOUR, MAX_ADVANCE_DAYS, MAX_COURT_HOURS, MAX_VENUE_AHEAD_DAYS, OPEN_HOUR, Sport } from "@/lib/types";
import { usualMinutes } from "@/lib/booking-rules";
import { formatMinute } from "@/lib/interval";
import { lengthLabel } from "@/lib/length-label";
import type { SearchResult, SearchSort } from "@/lib/store";
import { useT } from "@/components/Language";
import { translateError } from "@/lib/i18n";
import { sportLabel } from "@/lib/i18n";
import type { T } from "@/lib/i18n";
import { NearPicker, type NearChoice } from "@/components/NearPicker";
import { DAY_PARTS, dayPartOf, type DayPart } from "@/lib/day-parts";
import { Highlights } from "@/components/VenueFacilities";
import { FILTER_ICONS, highlights, type AmenityFilter, type CourtFilter } from "@/lib/facilities";
import { photoAt, type Photo } from "@/lib/photos-shared";
import { money, shortDate } from "@/lib/region";
import { NeedsLabel, TakingPicker, takingParam, useTaking, type Person } from "@/components/WhoTakesPart";

// Every hour a booking could start at, across all venues. Each venue's own
// trading hours narrow this further when the search runs.
const chipClass = (on: boolean) =>
  `rounded-full px-4 py-1.5 text-sm font-medium transition ${
    on ? "bg-teal-600 text-white shadow" : "bg-white text-slate-600 ring-1 ring-slate-200 hover:ring-teal-400"
  }`;

const HOURS = Array.from({ length: CLOSE_HOUR - OPEN_HOUR }, (_, i) => OPEN_HOUR + i);

function dateLabel(t: T, date: string): string {
  return shortDate(date, t.locale, true);
}

interface ResultGroup {
  key: string;
  venueId: number;
  venueName: string;
  area: string;
  distanceKm?: number;
  startMin: number;
  endMin: number;
  /** Cheapest first — the Book button targets courts[0]. */
  courts: SearchResult[];
}

/** One row per venue + start time, rather than one per identical court. */
function groupResults(results: SearchResult[]): ResultGroup[] {
  const groups = new Map<string, ResultGroup>();
  for (const r of results) {
    const key = `${r.venue.id}:${r.startMin}`;
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
        startMin: r.startMin,
        endMin: r.endMin,
        courts: [r],
      });
    }
  }
  // results arrive time-then-price ordered, so each group is already cheapest-first
  return [...groups.values()];
}

/** Where a search starts: from the address, so the home page can hand one over. */
export interface SearchStart {
  sport?: Sport;
  date?: string;
  fromHour?: number;
  toHour?: number;
  near?: NearChoice | null;
}

/** The facilities anybody may ask for, whatever the activity; the court ones come from the activity. */
const AMENITY_CHIPS = ["showers", "parking", "surau", "transit"] as const satisfies readonly AmenityFilter[];
type SearchChip = CourtFilter | (typeof AMENITY_CHIPS)[number];
const isCourtChip = (f: SearchChip): f is CourtFilter => !(AMENITY_CHIPS as readonly string[]).includes(f);

/** How long a search can ask for: an hour, an hour and a half, then whole hours. */
/** Lengths to search for, in minutes; each court's own rules decide whether it takes one. */
const DURATIONS = [30, 45, 60, 75, 90, 120, 150, 180, ...Array.from({ length: MAX_COURT_HOURS - 3 }, (_, i) => (i + 4) * 60)];

export default function SearchClient({
  start = {},
  sports = activityKeys(),
  classes = [],
}: {
  start?: SearchStart;
  /** The sports somebody here offers, so nobody searches for one nobody has. */
  sports?: Sport[];
  /** Activities offered only as classes: found on the Classes page, not here. */
  classes?: Sport[];
}) {
  const t = useT();
  const today = todayISO();
  const dates = Array.from({ length: MAX_ADVANCE_DAYS + 1 }, (_, i) => addDays(today, i));

  // A sport asked for in the address stays on offer, to say honestly that nothing was found.
  const known = sports.length > 0 ? sports : activityKeys();
  const offered = start.sport && !known.includes(start.sport) ? [...known, start.sport] : known;
  const [sport, setSportOnly] = useState<Sport>(start.sport ?? offered[0]);
  // Two weeks as buttons; further, up to the furthest any venue takes bookings, by picking a day.
  const lastDay = addDays(today, MAX_VENUE_AHEAD_DAYS);
  const [date, setDate] = useState(start.date && start.date >= today && start.date <= lastDay ? start.date : today);
  const [fromHour, setFromHour] = useState(start.fromHour ?? OPEN_HOUR);
  const [toHour, setToHour] = useState(start.toHour ?? CLOSE_HOUR - 1);
  // How long, in minutes.
  const [duration, setDuration] = useState(usualMinutes(start.sport ?? offered[0]));
  // A sport's usual game comes with it: padel's 90 minutes.
  const setSport = (s: Sport) => {
    setSportOnly(s);
    setDuration(usualMinutes(s));
    // Floodlit means nothing in a pool: a filter the new activity has no use for goes.
    setHas((was) => was.filter((f) => !isCourtChip(f) || activityFilters(s).includes(f)));
  };
  // Morning, afternoon or evening is one tap; "Custom" opens the hour pickers.
  const [custom, setCustom] = useState(dayPartOf(fromHour, toHour) === null);
  const part = custom ? null : dayPartOf(fromHour, toHour);
  // On a phone the narrower filters fold away until asked for.
  const [moreOpen, setMoreOpen] = useState(false);
  const [area, setArea] = useState("");
  const [near, setNear] = useState<NearChoice | null>(start.near ?? null);
  const [has, setHas] = useState<SearchChip[]>([]);
  const [covers, setCovers] = useState<Record<string, Photo>>({});
  const [sortChoice, setSort] = useState<SearchSort>("soonest");
  // Nearest means nothing without somewhere to be near.
  const sort: SearchSort = sortChoice === "nearest" && !near ? "soonest" : sortChoice;
  const [areas, setAreas] = useState<string[]>([]);
  const [results, setResults] = useState<SearchResult[] | null>(null);
  // A whole marketplace is too many courts to search at once; the server says
  // so, and the page asks for an area instead of showing nothing.
  const [needsArea, setNeedsArea] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Who is taking part, for an account signed in: this tab only (components/WhoTakesPart.tsx).
  const { chosen, setChosen, signedIn, people } = useTaking();
  const taking = takingParam(chosen);

  const search = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({
        sport,
        date,
        from: String(fromHour),
        to: String(toHour),
        minutes: String(duration),
      });
      // Near somewhere is where; an area on top of it would only narrow it oddly.
      if (near) {
        params.set("near", `${near.lat.toFixed(5)},${near.lng.toFixed(5)}`);
        params.set("km", String(near.km));
      } else if (area) params.set("area", area);
      if (has.length > 0) params.set("has", has.join(","));
      if (sort !== "soonest") params.set("sort", sort);
      if (taking) params.set("taking", taking);
      const res = await fetch(`/api/search?${params}`, { cache: "no-store" });
      const data = await readJson(res);
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
  }, [sport, date, fromHour, toHour, duration, area, near, has, sort, taking, t]);

  useEffect(() => {
    search();
  }, [search]);

  // The venue page says how far it is, from wherever the search was near.
  const nearQuery = near
    ? `&near=${near.lat.toFixed(5)},${near.lng.toFixed(5)}${near.where ? `&where=${encodeURIComponent(near.where)}` : ""}`
    : "";
  const bookHref = (r: SearchResult) => kindHref(r, r.court.id, r.court.heading ?? null);
  // To the venue's grid at that time, with the heading shown: one kind picked to book, or none to look at them all.
  const kindHref = (r: SearchResult, courtId: number | null, heading: string | null) =>
    `/venue/${r.venue.id}?date=${date}&sport=${r.court.sport}${courtId === null ? "" : `&court=${courtId}`}&start=${r.startMin}&minutes=${r.endMin - r.startMin}${
      heading ? `&heading=${encodeURIComponent(heading)}` : ""
    }${nearQuery}`;

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
        <ActivityChooser t={t} offered={offered} classes={classes} sport={sport} onPick={setSport} />

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
          <label className="flex shrink-0 items-center gap-1 text-sm text-slate-600">
            {t("search.laterDay")}
            <input
              type="date"
              min={today}
              max={lastDay}
              value={date}
              onChange={(e) => e.target.value && setDate(e.target.value)}
              className={`rounded-lg border px-2 py-1 text-sm ${dates.includes(date) ? "border-slate-200" : "border-teal-600 ring-1 ring-teal-600"}`}
            />
          </label>
        </div>

        <div className="flex flex-wrap gap-2" role="group" aria-label={t("quick.time")}>
          {(Object.keys(DAY_PARTS) as DayPart[]).map((k) => (
            <button
              key={k}
              type="button"
              aria-pressed={part === k}
              onClick={() => {
                setCustom(false);
                setFromHour(DAY_PARTS[k][0]);
                setToHour(DAY_PARTS[k][1]);
              }}
              className={chipClass(part === k)}
            >
              {t(`quick.time.${k}`)}
            </button>
          ))}
          <button type="button" aria-pressed={custom} onClick={() => setCustom(true)} className={chipClass(custom)}>
            {t("search.customTime")}
          </button>
        </div>

        <div className="flex flex-wrap items-end gap-3">
          {custom && (
            <>
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
                      {formatHour(h, t.locale)}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col text-xs font-medium text-slate-500">
                {t("search.until")}
                <select value={toHour} onChange={(e) => setToHour(Number(e.target.value))} className={selectClass}>
                  {HOURS.filter((h) => h >= fromHour).map((h) => (
                    <option key={h} value={h}>
                      {formatHour(h, t.locale)}
                    </option>
                  ))}
                </select>
              </label>
            </>
          )}
          <label className="flex flex-col text-xs font-medium text-slate-500">
            {t("search.for")}
            <select
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value))}
              className={selectClass}
            >
              {DURATIONS.map((d) => (
                <option key={d} value={d}>
                  {lengthLabel(t, d)}
                </option>
              ))}
            </select>
          </label>
          <label className={`${moreOpen ? "flex" : "hidden sm:flex"} flex-col text-xs font-medium text-slate-500`}>
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
        <button
          type="button"
          aria-expanded={moreOpen}
          onClick={() => setMoreOpen(!moreOpen)}
          className="text-sm font-medium text-teal-700 underline sm:hidden"
        >
          {moreOpen
            ? t("search.fewerFilters")
            : (area && !near ? 1 : 0) + has.length > 0
              ? t("search.moreFiltersOn", { n: (area && !near ? 1 : 0) + has.length })
              : t("search.moreFilters")}
        </button>
        <div
          className={`${moreOpen ? "flex" : "hidden sm:flex"} flex-wrap items-center gap-2 text-sm`}
          role="group"
          aria-label={t("fac.filterTitle")}
        >
          <span className="text-slate-500">{t("fac.filterTitle")}:</span>
          {[...activityFilters(sport), ...AMENITY_CHIPS].map((f) => {
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
        {signedIn && <TakingPicker t={t} people={people} chosen={chosen} onChange={setChosen} />}
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
      ) : results && results.length > 0 && sort !== "soonest" ? (
        <div>
          <SortBar t={t} sort={sort} onSort={setSort} near={near !== null} />
          <VenueResults t={t} results={results} covers={covers} bookHref={bookHref} kindHref={kindHref} people={people} />
        </div>
      ) : results && results.length > 0 ? (
        (() => {
          const groups = groupResults(results);
          return (
            <div>
              <SortBar t={t} sort={sort} onSort={setSort} near={near !== null} />
              <p className="mb-3 text-sm text-slate-600">
                {t.plural("search.count", groups.length)}{" "}
                <span className="font-medium">{sportLabel(t, sport).toLowerCase()}</span>{" "}
                {t("search.on")} <span className="font-medium">{dateLabel(t, date)}</span>
              </p>
              <ul className="space-y-2">
                {groups.map((g) => {
                  const cheapest = g.courts[0];
                  // The server sends one court per venue and time, and counts the rest;
                  // kinds listed under their heading below are not counted again.
                  const listed = (cheapest.groups ?? []).flatMap((x) => x.kinds).filter((k) => k.free && k.courtId !== cheapest.court.id).length;
                  const others = Math.max((cheapest.alsoFree ?? g.courts.length - 1) - listed, 0);
                  return (
                    <li
                      key={g.key}
                      className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition hover:border-teal-400"
                    >
                      <div className="w-32 shrink-0 font-semibold text-teal-700">
                        {formatMinute(g.startMin, t.locale)}
                        <div className="text-xs font-normal text-slate-400">
                          {t("search.to", { time: formatMinute(g.endMin, t.locale) })}
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
                        <div className="font-medium">
                          {g.venueName}
                          {cheapest.venue.access === "members" && (
                          <span className="ml-2 rounded-full bg-violet-100 px-2 py-0.5 text-xs font-semibold text-violet-700">
                            🎟️ {t("access.membersBadge")}
                          </span>
                        )}
                        </div>
                        <div className="text-sm text-slate-500">
                          📍 {g.area}
                          {g.distanceKm !== undefined && ` · ${t("near.away", { km: g.distanceKm })}`} ·{" "}
                          <ActivityGlyph sport={cheapest.court.sport} /> {cheapest.court.heading ? `${cheapest.court.heading} · ${cheapest.court.name}` : cheapest.court.name}
                          {cheapest.needs && <NeedsLabel t={t} needs={cheapest.needs} lines={cheapest.eligibility} people={people} />}
                          {others > 0 && (
                            <span className="text-slate-400">
                              {" "}
                              {t.plural("search.moreCourts", others)}
                            </span>
                          )}
                        </div>
                        <Highlights t={t} items={highlights([cheapest.court], cheapest.venue.amenities ?? [])} />
                        <KindGroups t={t} result={cheapest} href={kindHref} people={people} />
                      </div>
                      <div className="text-right">
                        <div className="font-bold">{money(cheapest.totalPrice)}</div>
                        {cheapest.court.perPlayer && <div className="text-xs text-slate-400">{t("search.perPlayer")}</div>}
                        {others > 0 && cheapest.pricesVary && (
                          <div className="text-xs text-slate-400">{t("search.fromPrice")}</div>
                        )}
                      </div>
                      <Link
                        href={bookHref(cheapest)}
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

/** Soonest, nearest or cheapest; nearest only once there is somewhere to be near. */
function SortBar({ t, sort, onSort, near }: { t: T; sort: SearchSort; onSort: (s: SearchSort) => void; near: boolean }) {
  const options: SearchSort[] = near ? ["soonest", "nearest", "cheapest"] : ["soonest", "cheapest"];
  return (
    <div className="mb-3 flex flex-wrap items-center gap-2 text-sm" role="group" aria-label={t("search.sort")}>
      <span className="text-slate-500">{t("search.sort")}:</span>
      {options.map((o) => (
        <button
          key={o}
          type="button"
          aria-pressed={sort === o}
          onClick={() => onSort(o)}
          className={`rounded-full border px-3 py-1 ${sort === o ? "border-teal-600 bg-teal-600 text-white" : "border-slate-200 bg-white text-slate-700 hover:border-teal-500"}`}
        >
          {t(`search.sort.${o}`)}
        </button>
      ))}
    </div>
  );
}

/** A link to the venue's grid at a result's time, with a heading shown: a kind picked (`courtId`), or none. */
type KindHref = (r: SearchResult, courtId: number | null, heading: string | null) => string;

/**
 * Kinds of kit under one heading at a result's venue and time: the heading,
 * then each kind as itself, with its own price and places left (never added
 * up) and what its rules ask for first; a free one goes straight to booking
 * it, and the heading to the venue's grid with all of them.
 */
function KindGroups({
  t,
  result,
  href,
  withTime = false,
  people = [],
}: {
  t: T;
  result: SearchResult;
  href: KindHref;
  withTime?: boolean;
  /** Who the account manages, to name each one's status. */
  people?: Person[];
}) {
  if (!result.groups || result.groups.length === 0) return null;
  return (
    <div className="mt-2 space-y-1.5">
      {result.groups.map((g) => (
        <div key={g.heading} className="text-sm" data-testid={`group-${g.heading}`}>
          <span className="font-medium text-slate-700">
            {t("grp.choose", { heading: g.heading })}
            {withTime && ` · ${formatMinute(result.startMin, t.locale)}`}
          </span>
          <ul className="mt-1 flex flex-wrap gap-1.5">
            {g.kinds.map((k) => {
              const words = (
                <>
                  {k.name} · {money(k.totalPrice)}
                  {k.capacity > 1 ? ` ${t("grp.each")}` : k.perPlayer ? ` ${t("search.perPlayer")}` : ""}
                  {k.free ? (k.placesLeft !== null ? ` · ${t.plural("grp.left", k.placesLeft)}` : "") : ` · ${t("grp.full")}`}
                </>
              );
              return (
                <li key={k.courtId} data-testid={`kind-${k.courtId}`}>
                  {k.free ? (
                    <Link
                      href={href(result, k.courtId, g.heading)}
                      className="inline-block rounded-lg border border-teal-200 bg-teal-50 px-2 py-0.5 text-teal-800 hover:border-teal-500"
                    >
                      {words}
                    </Link>
                  ) : (
                    <span className="inline-block rounded-lg border border-slate-200 bg-slate-50 px-2 py-0.5 text-slate-400">{words}</span>
                  )}
                  {k.needs && <NeedsLabel t={t} needs={k.needs} lines={k.eligibility} people={people} />}
                </li>
              );
            })}
          </ul>
          <Link href={href(result, null, g.heading)} className="text-xs font-medium text-teal-700 underline">
            {t("grp.seeAll", { heading: g.heading })}
          </Link>
        </div>
      ))}
    </div>
  );
}

/**
 * One row per venue, in the order the server sent its best hour — nearest or
 * cheapest — with every free start time under it, each straight to booking.
 */
function VenueResults({
  t,
  results,
  covers,
  bookHref,
  kindHref,
  people,
}: {
  t: T;
  results: SearchResult[];
  covers: Record<string, Photo>;
  bookHref: (r: SearchResult) => string;
  kindHref: KindHref;
  people: Person[];
}) {
  const venues = new Map<number, SearchResult[]>();
  for (const r of results) venues.set(r.venue.id, [...(venues.get(r.venue.id) ?? []), r]);
  return (
    <>
      <p className="mb-3 text-sm text-slate-600">{t.plural("search.venues", venues.size)}</p>
      <ul className="space-y-2">
        {[...venues.values()].map((slots) => {
          const first = slots[0];
          const times = [...slots].sort((a, b) => a.startMin - b.startMin);
          const from = Math.min(...slots.map((s) => s.totalPrice));
          const cover = covers[first.venue.id];
          return (
            <li key={first.venue.id} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex flex-wrap items-center gap-3">
                {cover && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={photoAt(cover, 400)}
                    alt=""
                    width={64}
                    height={48}
                    loading="lazy"
                    decoding="async"
                    className="h-12 w-16 shrink-0 rounded-md object-cover"
                    style={{ backgroundColor: cover.color }}
                  />
                )}
                <div className="min-w-[12rem] flex-1">
                  <div className="font-medium">
                    {first.venue.name}
                    {first.venue.access === "members" && (
                          <span className="ml-2 rounded-full bg-violet-100 px-2 py-0.5 text-xs font-semibold text-violet-700">
                            🎟️ {t("access.membersBadge")}
                          </span>
                        )}
                  </div>
                  <div className="text-sm text-slate-500">
                    📍 {first.venue.area}
                    {first.distanceKm !== undefined && ` · ${t("near.away", { km: first.distanceKm })}`}
                    {first.needs && <NeedsLabel t={t} needs={first.needs} lines={first.eligibility} people={people} />}
                  </div>
                  <Highlights t={t} items={highlights([first.court], first.venue.amenities ?? [])} />
                  <KindGroups t={t} result={first} href={kindHref} withTime people={people} />
                </div>
                <div className="text-right text-sm">
                  <span className="text-slate-400">{t("search.fromPrice")}</span> <span className="font-bold">{money(from)}</span>
                </div>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                {times.map((r) => (
                  <Link
                    key={r.startMin}
                    href={bookHref(r)}
                    className="rounded-lg border border-teal-200 bg-teal-50 px-2.5 py-1 text-sm font-medium text-teal-800 hover:border-teal-500"
                  >
                    {formatMinute(r.startMin, t.locale)}{" "}
                    <span className="font-normal text-teal-700">
                      · {money(r.totalPrice)}
                      {r.court.perPlayer && ` ${t("search.perPlayer")}`}
                    </span>
                  </Link>
                ))}
              </div>
            </li>
          );
        })}
      </ul>
    </>
  );
}

/**
 * What to search for: the activities somebody here offers, grouped by kind,
 * and a box that finds one by any of its names or the words people use for it
 * here ("takraw", "spin", "bulu tangkis").
 */
function ActivityChooser({
  t,
  offered,
  classes,
  sport,
  onPick,
}: {
  t: T;
  offered: Sport[];
  classes: Sport[];
  sport: Sport;
  onPick: (s: Sport) => void;
}) {
  const [query, setQuery] = useState("");
  const matches = query.trim() ? findActivities(query) : [];
  const found = matches.filter((k) => offered.includes(k));
  const asClasses = matches.filter((k) => classes.includes(k));
  // Every activity offered, each in its kind and in the catalogue's order: a
  // rare one is as easy to find as a popular one.
  const groups = ACTIVITY_CATEGORIES.map((cat) => ({
    cat,
    keys: offered.filter((k) => activity(k).category === cat),
  })).filter((g) => g.keys.length > 0);
  const pick = (k: Sport) => {
    onPick(k);
    setQuery("");
  };
  return (
    <div className="space-y-2">
      <label className="block text-xs font-medium text-slate-500">
        {t("search.find")}
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && found.length > 0) {
              e.preventDefault();
              pick(found[0]);
            }
          }}
          placeholder={t("search.findHint")}
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:border-teal-500 focus:outline-none sm:max-w-sm"
        />
      </label>
      {query.trim() !== "" &&
        (found.length > 0 ? (
          <div className="flex flex-wrap gap-2" role="group" aria-label={t("search.find")}>
            {found.slice(0, 6).map((k) => (
              <button key={k} type="button" onClick={() => pick(k)} className={chipClass(k === sport)}>
                <ActivityGlyph sport={k} /> {sportLabel(t, k)}
              </button>
            ))}
          </div>
        ) : asClasses.length === 0 ? (
          <p className="text-sm text-slate-500">{t("search.findNone")}</p>
        ) : null)}
      {(query.trim() ? asClasses : classes).length > 0 && (
        <p className="text-sm text-slate-600">
          {t("search.asClasses", { what: (query.trim() ? asClasses : classes).map((k) => sportLabel(t, k)).join(", ") })}{" "}
          <Link href="/classes" className="font-medium text-teal-700 underline">
            {t("search.seeClasses")}
          </Link>
        </p>
      )}
      {groups.map(({ cat, keys }) => (
        <div key={cat} className="flex flex-wrap items-center gap-2" role="group" aria-label={t(`activity.cat.${cat}`)}>
          {groups.length > 1 && <span className="w-full text-xs font-medium uppercase tracking-wide text-slate-400">{t(`activity.cat.${cat}`)}</span>}
          {keys.map((k) => (
            <button key={k} type="button" aria-pressed={k === sport} onClick={() => pick(k)} className={chipClass(k === sport)}>
              <ActivityGlyph sport={k} /> {sportLabel(t, k)}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}
