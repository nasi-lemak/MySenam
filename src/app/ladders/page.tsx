import { isKnownActivity } from "@/lib/activity-registry";
import { ActivityGlyph } from "@/components/Glyph";
import Link from "next/link";
import type { Metadata } from "next";
import { serverT } from "@/lib/locale";
import { sportLabel } from "@/lib/i18n";
import { publicLadders } from "@/lib/ladders";
import { currentStorefront } from "@/lib/storefront";
import { type Sport } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await serverT();
  return { title: t("ldp.title") };
}

/** Ladders taking players, at venues customers can reach. */
export default async function LaddersPage({ searchParams }: { searchParams: Promise<{ sport?: string }> }) {
  const t = await serverT();
  const { sport: raw } = await searchParams;
  const sport = isKnownActivity(raw) ? (raw as Sport) : undefined;
  const storefront = await currentStorefront();
  const list = await publicLadders({ sport, venueIds: storefront?.venueIds });
  const offered = [...new Set((await publicLadders({ venueIds: storefront?.venueIds })).map((x) => x.sport))];
  const chip = (on: boolean) =>
    `rounded-full px-3 py-1 text-sm font-medium ${on ? "bg-teal-600 text-white" : "bg-white text-slate-600 ring-1 ring-slate-200 hover:ring-teal-400"}`;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t("ldp.title")}</h1>
        <p className="mt-1 text-sm text-slate-600">{t("ldp.intro")}</p>
      </div>
      {offered.length > 1 && (
        <nav className="flex flex-wrap gap-2">
          <Link href="/ladders" className={chip(!sport)}>
            {t("games.allSports")}
          </Link>
          {offered.map((s) => (
            <Link key={s} href={`/ladders?sport=${s}`} className={chip(sport === s)}>
              <ActivityGlyph sport={s} /> {sportLabel(t, s)}
            </Link>
          ))}
        </nav>
      )}
      {list.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-slate-500">{t("ldp.none")}</div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {list.map((x) => (
            <Link key={x.id} href={`/ladders/${x.id}`} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-teal-500 hover:shadow-md">
              <div className="text-lg font-semibold">
                <ActivityGlyph sport={x.sport} /> {x.name}
              </div>
              <div className="mt-1 text-sm text-slate-600">
                {x.venueName} · 📍 {x.area}
              </div>
              <div className="mt-3 flex flex-wrap gap-2 text-xs">
                {x.kind === "teams" ? (
                  <span className="rounded-full bg-slate-100 px-2 py-0.5">{t("lad2.ui.audienceTeams")}</span>
                ) : (
                  <>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5">{x.teamSize === 2 ? t("tour.doubles") : t("tour.singles")}</span>
                    <span className="rounded-full bg-slate-100 px-2 py-0.5">{t(`ldp.audience.${x.audience}`)}</span>
                  </>
                )}
                {x.who !== "anyone" && <span className="rounded-full bg-fuchsia-50 px-2 py-0.5 font-medium text-fuchsia-800">{t(`who.badge.${x.who}`)}</span>}
                {x.level && <span className="rounded-full bg-slate-100 px-2 py-0.5">{t(`games.level.${x.level}`)}</span>}
                <span className="rounded-full bg-amber-50 px-2 py-0.5 text-amber-800">{t("ldp.players", { n: x.players })}</span>
                <span className="rounded-full bg-slate-100 px-2 py-0.5">{t("ldp.cardRule", { reach: x.settings.reach })}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
