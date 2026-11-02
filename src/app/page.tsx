import { sportsOf } from "@/lib/court-activities";
import { ActivityGlyph } from "@/components/Glyph";
import Link from "next/link";
import { redirect } from "next/navigation";
import { listAreaCounts, listVenuePage, readNear, activitiesByPopularity } from "@/lib/store";
import { HomeNear } from "./HomeNear";
import { QuickSearch } from "./QuickSearch";
import { NoticeBar } from "@/components/NoticeBar";
import { showingFor, siteNotice } from "@/lib/notices";
import { serverT } from "@/lib/locale";
import { currentStorefront } from "@/lib/storefront";
import { sportLabel } from "@/lib/i18n";
import { FILTER_CHIPS, FILTER_ICONS, highlights, readFacilityFilters, type FilterChip } from "@/lib/facilities";
import { Highlights } from "@/components/VenueFacilities";
import { coversFor } from "@/lib/photos";
import { photoAt, srcSet } from "@/lib/photos-shared";

export const dynamic = "force-dynamic";

/** Beyond this many areas, a dropdown rather than a row of buttons. */
const AREA_CHIPS = 12;

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ area?: string; page?: string; near?: string; km?: string; where?: string; has?: string }>;
}) {
  const storefront = await currentStorefront();
  // A one-venue storefront is that venue's website: straight to its booking page.
  if (storefront?.venueIds.length === 1) redirect(`/venue/${storefront.venueIds[0]}`);
  const query = await searchParams;
  const venueIds = storefront?.venueIds;
  const areas = await listAreaCounts({ venueIds });
  // Near somewhere, nearest first; otherwise by area.
  const near = readNear(query.near, query.km);
  const where = near && query.where ? query.where.slice(0, 80) : null;
  // An area nobody has a venue in is no area at all.
  const area = !near && areas.some((a) => a.area === query.area) ? query.area : undefined;
  // One page of venues, never all of them: with thousands, all of them is
  // megabytes of page for somebody who wants the court down the road.
  // Must have: air-con, showers, parking...
  const wanted = readFacilityFilters(query.has);
  const has = FILTER_CHIPS.filter((f) => (wanted.amenities as string[]).includes(f) || (wanted.courts as string[]).includes(f));
  const { venues, total, page, pageSize } = await listVenuePage({
    area,
    venueIds,
    near: near ?? undefined,
    amenities: wanted.amenities,
    courtFilters: wanted.courts,
    page: Number(query.page) || 1,
  });
  // One small picture each, if the venue has one.
  const covers = await coversFor(venues.map((v) => v.id));
  // On a venue's own storefront, its notices; on the marketplace, only the
  // platform's own — no venue's promotion leads the front page.
  const notices = storefront ? await showingFor(storefront.venueIds) : [await siteNotice()].filter((n) => n !== null);
  const t = await serverT();
  // Most booked around here first, for the few buttons; the rest stay one pick away.
  const sportsOffered = await activitiesByPopularity({ venueIds, area });
  const link = (to: { area?: string; page?: number; has?: FilterChip[] }) => {
    const params = new URLSearchParams();
    if (to.area) params.set("area", to.area);
    const keep = to.has ?? has;
    if (keep.length > 0) params.set("has", keep.join(","));
    if (near) {
      params.set("near", `${near.lat},${near.lng}`);
      params.set("km", String(near.km));
      if (where) params.set("where", where);
    }
    if (to.page && to.page > 1) params.set("page", String(to.page));
    const qs = params.toString();
    return qs ? `/?${qs}` : "/";
  };
  const allVenues = areas.reduce((n, a) => n + a.venues, 0);

  return (
    <div className="space-y-10">
      <section
        className={`rounded-2xl bg-gradient-to-br from-teal-600 px-4 py-8 text-white shadow-lg sm:px-6 sm:py-10 ${
          storefront ? "to-teal-800" : "to-emerald-500"
        }`}
      >
        <h1 className="text-3xl font-bold sm:text-4xl">{storefront?.name ?? t("home.heroTitle")}</h1>
        <p className="mt-3 max-w-xl text-teal-50">
          {storefront ? (storefront.tagline ?? t("home.heroTitle")) : t("home.heroBody")}
        </p>
        {notices.length > 0 && (
          <div className="mt-4 space-y-2">
            {notices.slice(0, 3).map((n) => (
              <NoticeBar key={n.id} notice={n} more={t("notice.more")} tone="light" />
            ))}
          </div>
        )}
        {/* The search starts here: tap a sport, a day, a time — straight to what is free. */}
        <QuickSearch sports={sportsOffered} />
      </section>

      <section>
        <h2 className="text-2xl font-bold">{t("home.venuesTitle")}</h2>
        <p className="mt-1 text-slate-600">
          {t("home.venuesIntro")}{" "}
          <Link href="/search" className="font-medium text-teal-700 underline">
            {t("home.venuesSearchLink")}
          </Link>
          .
        </p>
        <div className="mt-4 max-w-2xl">
          <HomeNear value={near ? { ...near, where } : null} />
        </div>
        {!near &&
          areas.length > 1 &&
          (areas.length <= AREA_CHIPS ? (
            <nav className="mt-4 flex flex-wrap gap-2 text-sm">
              {[{ area: undefined, venues: allVenues, label: t("home.allAreas") }, ...areas.map((a) => ({ ...a, label: a.area }))].map(
                (a) => (
                  <Link
                    key={a.label}
                    href={link({ area: a.area })}
                    className={`rounded-full border px-3 py-1 ${
                      a.area === area
                        ? "border-teal-600 bg-teal-600 text-white"
                        : "border-slate-200 bg-white text-slate-700 hover:border-teal-500"
                    }`}
                  >
                    {a.label} <span className="opacity-70">{a.venues}</span>
                  </Link>
                )
              )}
            </nav>
          ) : (
            // Plain GET form: works before any JavaScript has loaded.
            <form action="/" method="get" className="mt-4 flex gap-2 text-sm">
              {has.length > 0 && <input type="hidden" name="has" value={has.join(",")} />}
              <select
                name="area"
                defaultValue={area ?? ""}
                className="rounded-md border border-slate-300 px-2 py-1.5"
                aria-label={t("search.area")}
              >
                <option value="">
                  {t("home.allAreas")} ({allVenues})
                </option>
                {areas.map((a) => (
                  <option key={a.area} value={a.area}>
                    {a.area} ({a.venues})
                  </option>
                ))}
              </select>
              <button type="submit" className="rounded-md bg-teal-600 px-3 py-1.5 font-medium text-white">
                {t("search.area")}
              </button>
            </form>
          ))}
        <nav className="mt-4 flex flex-wrap items-center gap-2 text-sm" aria-label={t("fac.filterTitle")}>
          <span className="text-slate-500">{t("fac.filterTitle")}:</span>
          {FILTER_CHIPS.map((f) => {
            const on = has.includes(f);
            return (
              <Link
                key={f}
                href={link({ area, has: on ? has.filter((x) => x !== f) : [...has, f] })}
                aria-pressed={on}
                className={`rounded-full border px-3 py-1 ${on ? "border-teal-600 bg-teal-600 text-white" : "border-slate-200 bg-white text-slate-700 hover:border-teal-500"}`}
              >
                {FILTER_ICONS[f]} {t(`fac.${f}`)}
              </Link>
            );
          })}
          {has.length > 0 && (
            <Link href={link({ area, has: [] })} className="text-teal-700 underline">
              {t("fac.clear")}
            </Link>
          )}
        </nav>
        {venues.length === 0 && (
          <p className="mt-6 text-slate-500">{near ? t("near.none", { km: near.km }) : t("home.noVenues")}</p>
        )}
        <div className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {venues.map((venue) => {
            const sportsHere = sportsOf(venue.courts);
            const minRate = Math.min(...venue.courts.map((c) => c.offPeakRate));
            const cover = covers.get(venue.id);
            return (
              <Link
                key={venue.id}
                href={
                  near
                    ? `/venue/${venue.id}?near=${near.lat},${near.lng}${where ? `&where=${encodeURIComponent(where)}` : ""}`
                    : `/venue/${venue.id}`
                }
                className="group flex flex-col overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm transition hover:-translate-y-0.5 hover:border-teal-500 hover:shadow-md"
              >
                {/* The same height with a photo or without, so no card looks lesser for having none. */}
                <div
                  className="flex aspect-[16/9] items-center justify-center bg-teal-50 text-4xl"
                  style={cover ? { backgroundColor: cover.color } : undefined}
                >
                  {cover ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={photoAt(cover, 400)}
                      srcSet={srcSet(cover)}
                      sizes="(min-width: 1024px) 33vw, (min-width: 640px) 50vw, 100vw"
                      alt={cover.caption ?? venue.name}
                      loading="lazy"
                      decoding="async"
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <span aria-hidden className="flex gap-2 text-teal-700">
                      {sportsHere.slice(0, 3).map((s) => (
                        <ActivityGlyph key={s} sport={s} />
                      ))}
                    </span>
                  )}
                </div>
                <div className="flex flex-1 flex-col p-5">
                <div className="text-lg font-semibold group-hover:text-teal-700">
                  {venue.name}
                  {venue.access === "members" && (
                    <span className="ml-2 rounded-full bg-violet-100 px-2 py-0.5 align-middle text-xs font-semibold text-violet-700">
                      🎟️ {t("access.membersBadge")}
                    </span>
                  )}
                </div>
                <div className="mt-1 text-sm text-slate-500">
                  📍 {venue.area}
                  {venue.distanceKm !== undefined && ` · ${t("near.away", { km: venue.distanceKm })}`}
                </div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {sportsHere.map((sport) => (
                    <span
                      key={sport}
                      className="rounded-full bg-teal-50 px-2.5 py-0.5 text-xs font-medium text-teal-700"
                    >
                      <ActivityGlyph sport={sport} /> {sportLabel(t, sport)}
                    </span>
                  ))}
                </div>
                <div className="mt-3">
                  <Highlights t={t} items={highlights(venue.courts, venue.amenities)} />
                </div>
                <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-3 text-sm">
                  <span className="text-slate-500">
                    {t.plural("home.courts", venue.courts.length)}
                  </span>
                  {venue.courts.length > 0 && (
                    <span className="font-semibold text-teal-700">
                      {minRate === 0 ? t("price.free") : t("home.fromRate", { rate: minRate })}
                    </span>
                  )}
                </div>
                </div>
              </Link>
            );
          })}
        </div>
        {total > pageSize && (
          <nav className="mt-6 flex items-center justify-between text-sm">
            {page > 1 ? (
              <Link href={link({ area, page: page - 1 })} className="font-medium text-teal-700 hover:underline">
                {t("home.previous")}
              </Link>
            ) : (
              <span />
            )}
            <span className="text-slate-500">
              {t("home.showing", {
                from: (page - 1) * pageSize + 1,
                to: Math.min(page * pageSize, total),
                total,
              })}
            </span>
            {page * pageSize < total ? (
              <Link href={link({ area, page: page + 1 })} className="font-medium text-teal-700 hover:underline">
                {t("home.next")}
              </Link>
            ) : (
              <span />
            )}
          </nav>
        )}
      </section>

      <section className="grid gap-4 rounded-xl border border-slate-200 bg-white p-6 sm:grid-cols-3">
        {(["home.step1", "home.step2", "home.step3"] as const).map((step) => (
          <div key={step}>
            <div className="font-semibold text-teal-700">{t(`${step}Title`)}</div>
            <p className="mt-1 text-sm text-slate-600">{t(`${step}Body`)}</p>
          </div>
        ))}
      </section>
    </div>
  );
}
