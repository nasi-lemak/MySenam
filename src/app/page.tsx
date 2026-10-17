import Link from "next/link";
import { redirect } from "next/navigation";
import { listAreaCounts, listVenuePage, sportsOfferedAt } from "@/lib/store";
import { serverT } from "@/lib/locale";
import { currentStorefront } from "@/lib/storefront";
import { Sport, SPORT_ICONS } from "@/lib/types";
import { sportLabel } from "@/lib/i18n";

export const dynamic = "force-dynamic";

/** Beyond this many areas, a dropdown rather than a row of buttons. */
const AREA_CHIPS = 12;

export default async function HomePage({
  searchParams,
}: {
  searchParams: Promise<{ area?: string; page?: string }>;
}) {
  const storefront = await currentStorefront();
  // A one-venue storefront is that venue's website: straight to its booking page.
  if (storefront?.venueIds.length === 1) redirect(`/venue/${storefront.venueIds[0]}`);
  const query = await searchParams;
  const venueIds = storefront?.venueIds;
  const areas = await listAreaCounts({ venueIds });
  // An area nobody has a venue in is no area at all.
  const area = areas.some((a) => a.area === query.area) ? query.area : undefined;
  // One page of venues, never all of them: with thousands, all of them is
  // megabytes of page for somebody who wants the court down the road.
  const { venues, total, page, pageSize } = await listVenuePage({
    area,
    venueIds,
    page: Number(query.page) || 1,
  });
  const t = await serverT();
  const sportsOffered = await sportsOfferedAt(venueIds);
  const link = (to: { area?: string; page?: number }) => {
    const params = new URLSearchParams();
    if (to.area) params.set("area", to.area);
    if (to.page && to.page > 1) params.set("page", String(to.page));
    const qs = params.toString();
    return qs ? `/?${qs}` : "/";
  };
  const allVenues = areas.reduce((n, a) => n + a.venues, 0);

  return (
    <div className="space-y-10">
      <section
        className={`rounded-2xl bg-gradient-to-br from-teal-600 px-6 py-12 text-white shadow-lg ${
          storefront ? "to-teal-800" : "to-emerald-500"
        }`}
      >
        <h1 className="text-3xl font-bold sm:text-4xl">{storefront?.name ?? t("home.heroTitle")}</h1>
        <p className="mt-3 max-w-xl text-teal-50">
          {storefront ? (storefront.tagline ?? t("home.heroTitle")) : t("home.heroBody")}
        </p>
        <Link
          href="/search"
          className="mt-6 inline-flex items-center gap-2 rounded-lg bg-white px-5 py-2.5 font-semibold text-teal-700 shadow transition hover:bg-teal-50"
        >
          🔍 {t("home.heroCta")}
        </Link>
        <div className="mt-6 flex flex-wrap gap-3">
          {sportsOffered.map((sport) => (
            <span
              key={sport}
              className="rounded-full bg-white/15 px-4 py-1.5 text-sm font-medium backdrop-blur"
            >
              {SPORT_ICONS[sport]} {sportLabel(t, sport)}
            </span>
          ))}
        </div>
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
        {areas.length > 1 &&
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
        {venues.length === 0 && <p className="mt-6 text-slate-500">{t("home.noVenues")}</p>}
        <div className="mt-6 grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
          {venues.map((venue) => {
            const sportsHere = [...new Set(venue.courts.map((c) => c.sport))] as Sport[];
            const minRate = Math.min(...venue.courts.map((c) => c.offPeakRate));
            return (
              <Link
                key={venue.id}
                href={`/venue/${venue.id}`}
                className="group flex flex-col rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:-translate-y-0.5 hover:border-teal-500 hover:shadow-md"
              >
                <div className="text-lg font-semibold group-hover:text-teal-700">{venue.name}</div>
                <div className="mt-1 text-sm text-slate-500">📍 {venue.area}</div>
                <div className="mt-3 flex flex-wrap gap-2">
                  {sportsHere.map((sport) => (
                    <span
                      key={sport}
                      className="rounded-full bg-teal-50 px-2.5 py-0.5 text-xs font-medium text-teal-700"
                    >
                      {SPORT_ICONS[sport]} {sportLabel(t, sport)}
                    </span>
                  ))}
                </div>
                <div className="mt-4 flex items-center justify-between border-t border-slate-100 pt-3 text-sm">
                  <span className="text-slate-500">
                    {t.plural("home.courts", venue.courts.length)}
                  </span>
                  {venue.courts.length > 0 && (
                    <span className="font-semibold text-teal-700">
                      {t("home.fromRate", { rate: minRate })}
                    </span>
                  )}
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
