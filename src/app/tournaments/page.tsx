import { activityIcon, isKnownActivity } from "@/lib/activity-registry";
import Link from "next/link";
import type { Metadata } from "next";
import { serverT } from "@/lib/locale";
import { sportLabel } from "@/lib/i18n";
import { currentStorefront } from "@/lib/storefront";
import { formatHour } from "@/lib/time";
import { publicTournaments } from "@/lib/tournaments";
import { type Sport } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await serverT();
  return { title: t("tour.title") };
}

/** Tournaments coming up, or just played, at venues customers can reach. */
export default async function TournamentsPage({ searchParams }: { searchParams: Promise<{ sport?: string }> }) {
  const t = await serverT();
  const { sport: raw } = await searchParams;
  const sport = isKnownActivity(raw) ? (raw as Sport) : undefined;
  const storefront = await currentStorefront();
  const list = await publicTournaments({ sport, venueIds: storefront?.venueIds });
  const offered = [...new Set((await publicTournaments({ venueIds: storefront?.venueIds })).map((x) => x.sport))];
  const chip = (on: boolean) =>
    `rounded-full px-3 py-1 text-sm font-medium ${on ? "bg-teal-600 text-white" : "bg-white text-slate-600 ring-1 ring-slate-200 hover:ring-teal-400"}`;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t("tour.title")}</h1>
        <p className="mt-1 text-sm text-slate-600">{t("tour.intro")}</p>
      </div>
      {offered.length > 1 && (
        <nav className="flex flex-wrap gap-2">
          <Link href="/tournaments" className={chip(!sport)}>
            {t("games.allSports")}
          </Link>
          {offered.map((s) => (
            <Link key={s} href={`/tournaments?sport=${s}`} className={chip(sport === s)}>
              {activityIcon(s)} {sportLabel(t, s)}
            </Link>
          ))}
        </nav>
      )}
      {list.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-slate-500">{t("tour.none")}</div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {list.map((x) => (
            <Link
              key={x.id}
              href={`/tournaments/${x.id}`}
              className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-teal-500 hover:shadow-md"
            >
              <div className="flex items-start justify-between gap-2">
                <div className="text-lg font-semibold">
                  {activityIcon(x.sport)} {x.name}
                </div>
                <span className="shrink-0 rounded-full bg-teal-50 px-2 py-0.5 text-xs font-medium text-teal-700">
                  {t(`tour.status.${x.status}`)}
                </span>
              </div>
              <div className="mt-1 text-sm text-slate-600">
                {x.venueName} · 📍 {x.area}
              </div>
              <div className="mt-1 text-sm text-slate-500">
                {t("tour.when", { from: x.startsOn, to: x.endsOn, start: formatHour(x.startHour, t.locale), end: formatHour(x.endHour, t.locale) })}
              </div>
              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                {x.category !== "open" && (
                  <span className="rounded-full bg-fuchsia-50 px-2 py-0.5 font-medium text-fuchsia-800">{t(`cat.${x.category}`)}</span>
                )}
                <span className="rounded-full bg-slate-100 px-2 py-0.5">{x.entryKind === "team" ? t("tour.teams") : x.teamSize === 2 ? t("tour.doubles") : t("tour.singles")}</span>
                <span className="rounded-full bg-slate-100 px-2 py-0.5">
                  {x.format === "groups" ? t("tour.groups") : x.format === "round_robin" ? t("tour.roundRobin") : x.format === "performance" ? t("tour.performance") : t("tour.knockout")}
                </span>
                {x.level && <span className="rounded-full bg-slate-100 px-2 py-0.5">{t(`games.level.${x.level}`)}</span>}
                <span className="rounded-full bg-amber-50 px-2 py-0.5 text-amber-800">
                  {t("tour.entries", { entered: x.entered, max: x.maxEntries })}
                </span>
                <span className="font-semibold text-teal-700">
                  {x.entryFee > 0 ? t("tour.fee", { amount: x.entryFee.toFixed(2) }) : t("tour.free")}
                </span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
