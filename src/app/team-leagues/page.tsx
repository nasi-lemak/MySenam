import { isKnownActivity } from "@/lib/activity-registry";
import { ActivityGlyph } from "@/components/Glyph";
import Link from "next/link";
import type { Metadata } from "next";
import { serverT } from "@/lib/locale";
import { sportLabel } from "@/lib/i18n";
import { publicTeamLeagues } from "@/lib/team-leagues";
import { currentStorefront } from "@/lib/storefront";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await serverT();
  return { title: t("tml.title") };
}

/** Leagues of teams taking teams or under way, at venues customers can reach (lib/team-leagues.ts). */
export default async function TeamLeaguesPage({ searchParams }: { searchParams: Promise<{ sport?: string }> }) {
  const t = await serverT();
  const { sport: raw } = await searchParams;
  const sport = isKnownActivity(raw) ? raw : undefined;
  const storefront = await currentStorefront();
  const list = await publicTeamLeagues({ sport, venueIds: storefront?.venueIds });
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t("tml.title")}</h1>
        <p className="mt-1 text-sm text-slate-600">{t("tml.intro")}</p>
        <p className="mt-2 text-sm">
          <Link href="/teams" className="text-teal-700 underline">
            {t("tm.ui.title")}
          </Link>
        </p>
      </div>
      {list.length === 0 ? (
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-slate-500">{t("tml.none")}</div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {list.map((x) => (
            <Link key={x.id} href={`/team-leagues/${x.id}`} className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-teal-500 hover:shadow-md">
              <div className="text-lg font-semibold">
                <ActivityGlyph sport={x.sport} /> {x.name}
              </div>
              <div className="mt-1 text-sm text-slate-600">
                {x.venueName} · {sportLabel(t, x.sport)}
              </div>
              <div className="mt-2 text-sm text-slate-500">
                {t(x.legs === 2 ? "tml.legs.2" : "tml.legs.1")} · {t("tml.teamsCount", { n: x.teams })} · {t("tml.season", { from: x.startsOn, to: x.endsOn })}
              </div>
              <div className="mt-2 text-sm font-medium text-teal-700">{t(`tml.status.${x.status}`)}</div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
