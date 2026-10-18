import Link from "next/link";
import type { Metadata } from "next";
import { findGames } from "@/lib/games";
import { publicLeagues } from "@/lib/leagues";
import { serverT } from "@/lib/locale";
import { currentStorefront } from "@/lib/storefront";
import { publicTournaments } from "@/lib/tournaments";

export const dynamic = "force-dynamic";

export async function generateMetadata(): Promise<Metadata> {
  const t = await serverT();
  return { title: t("play.title") };
}

/**
 * Playing with other people, in one place: a game somebody has a court for,
 * a tournament, a league. One menu item instead of three.
 */
export default async function PlayPage() {
  const t = await serverT();
  const venueIds = (await currentStorefront())?.venueIds;
  const [games, tournaments, leagues] = await Promise.all([
    findGames({ venueIds, limit: 200 }),
    publicTournaments({ venueIds }),
    publicLeagues({ venueIds }),
  ]);
  const upcoming = tournaments.filter((x) => x.status === "open" || x.status === "closed" || x.status === "drawn");
  const cards = [
    { href: "/games", icon: "🤝", title: t("nav.games"), body: t("games.intro"), count: t("play.games", { n: games.length }) },
    { href: "/tournaments", icon: "🏆", title: t("nav.tournaments"), body: t("tour.intro"), count: t("play.tournaments", { n: upcoming.length }) },
    { href: "/leagues", icon: "📊", title: t("nav.leagues"), body: t("leag.intro"), count: t("play.leagues", { n: leagues.length }) },
  ];
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{t("play.title")}</h1>
        <p className="mt-1 text-sm text-slate-600">{t("play.intro")}</p>
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        {cards.map((c) => (
          <Link
            key={c.href}
            href={c.href}
            className="flex flex-col rounded-xl border border-slate-200 bg-white p-5 shadow-sm transition hover:border-teal-500 hover:shadow-md"
          >
            <div className="text-3xl" aria-hidden>
              {c.icon}
            </div>
            <div className="mt-2 text-lg font-semibold">{c.title}</div>
            <p className="mt-1 flex-1 text-sm text-slate-600">{c.body}</p>
            <div className="mt-3 text-sm font-semibold text-teal-700">{c.count} →</div>
          </Link>
        ))}
      </div>
    </div>
  );
}
