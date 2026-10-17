import Link from "next/link";
import { redirect } from "next/navigation";
import { listVenues } from "@/lib/store";
import { serverT } from "@/lib/locale";
import { currentStorefront, shows } from "@/lib/storefront";
import { Sport, SPORT_ICONS, SPORTS } from "@/lib/types";
import { sportLabel } from "@/lib/i18n";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const storefront = await currentStorefront();
  // A one-venue storefront is that venue's website: straight to its booking page.
  if (storefront?.venueIds.length === 1) redirect(`/venue/${storefront.venueIds[0]}`);
  const venues = (await listVenues()).filter((v) => shows(storefront, v.id));
  const t = await serverT();
  const sportsOffered = storefront
    ? SPORTS.filter((s) => venues.some((v) => v.courts.some((c) => c.sport === s)))
    : SPORTS;

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
                  <span className="font-semibold text-teal-700">
                    {t("home.fromRate", { rate: minRate })}
                  </span>
                </div>
              </Link>
            );
          })}
        </div>
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
