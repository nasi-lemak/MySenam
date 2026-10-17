import Link from "next/link";
import type { Metadata } from "next";
import { serverT } from "@/lib/locale";
import { sportLabel } from "@/lib/i18n";
import { publicLeagues } from "@/lib/leagues";
import { currentStorefront } from "@/lib/storefront";
import { SPORT_ICONS, SPORTS, type Sport } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await serverT();
  return { title: t("leag.title") };
}

/** Leagues taking players, at venues customers can reach. */
export default async function LeaguesPage({ searchParams }: { searchParams: Promise<{ sport?: string }> }) {
  const t = await serverT();
  const { sport: raw } = await searchParams;
  const sport = SPORTS.includes(raw as Sport) ? (raw as Sport) : undefined;
  const storefront = await currentStorefront();
  const list = await publicLeagues({ sport, venueIds: storefront?.venueIds });
  const offered = [...new Set((await publicLeagues({ venueIds: storefront?.venueIds })).map((x) => x.sport))];
  const chip = (on: boolean) =>
    `rounded-full px-3 py-1 text-sm font-medium ${on ? "bg-teal-600 text-white" : "bg-white text-slate-600 ring-1 ring-slate-200 hover:ring-teal-400"}`;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t("leag.title")}</h1>
        <p className="mt-1 text-sm text-slate-600">{t("leag.intro")}</p>
      </div>
      {offered.length > 1 && (
        <nav className="flex flex-wrap gap-2">
          <Link href="/leagues" className={chip(!sport)}>
            {t("games.allSports")}
          </Link>
          {offered.map((s) => (
            <Link key={s} href={`/leagues?sport=${s}`} className={chip(sport === s)}>
              {SPORT_ICONS[s]} {sportLabel(t, s)}
            </Link>
          ))}
        </nav>
      )}
      {list.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-slate-500">{t("leag.none")}</div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {list.map((x) => (
            <Link
              key={x.id}
              href={`/leagues/${x.id}`}
              className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-teal-500 hover:shadow-md"
            >
              <div className="text-lg font-semibold">
                {SPORT_ICONS[x.sport]} {x.name}
              </div>
              <div className="mt-1 text-sm text-slate-600">
                {x.venueName} · 📍 {x.area}
              </div>
              {x.current && (
                <div className="mt-1 text-sm text-slate-500">
                  {x.current.status === "forming"
                    ? t("leag.startsOn", { n: x.current.number, date: x.current.startsOn })
                    : t("leag.running", { n: x.current.number, from: x.current.startsOn, to: x.current.endsOn })}
                </div>
              )}
              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                <span className="rounded-full bg-slate-100 px-2 py-0.5">{x.teamSize === 2 ? t("tour.doubles") : t("tour.singles")}</span>
                <span className="rounded-full bg-slate-100 px-2 py-0.5">{t("leag.boxesOf", { n: x.boxSize })}</span>
                {x.level && <span className="rounded-full bg-slate-100 px-2 py-0.5">{t(`games.level.${x.level}`)}</span>}
                <span className="rounded-full bg-amber-50 px-2 py-0.5 text-amber-800">{t("leag.players", { n: x.players })}</span>
                <span className="font-semibold text-teal-700">{x.fee > 0 ? t("leag.fee", { amount: x.fee.toFixed(2) }) : t("leag.free")}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
