"use client";

import { readJson } from "@/lib/read-response";
import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import { useT } from "@/components/Language";
import { sportLabel } from "@/lib/i18n";
import type { RatingFormat } from "@/lib/rating-math";
import type { Board } from "@/lib/ratings";

interface Choices {
  pools: { sport: string; format: RatingFormat }[];
  seasons: number[];
}

/**
 * A venue's public rankings (lib/ratings.ts `venueBoard`), shown only where the venue's manager has published them (the page's layout
 * answers 404 otherwise): only players who chose to be listed, under the name they gave, and teams their captains published, once their
 * rating is no longer provisional. Where the venue chose to, the players not ranked yet are in a section of their own: no rank, not in
 * order, said to be ratings that may move a lot.
 */
export default function RankingsPage() {
  const t = useT();
  const venueId = Number(useParams<{ id: string }>().id);
  const [choices, setChoices] = useState<Choices | null>(null);
  const [rules, setRules] = useState<{ provisionalGames: number; rankAfter?: number; showProvisional?: boolean } | null>(null);
  const [pick, setPick] = useState<{ pool: string; season: string; scope: "venue" | "business" }>({ pool: "", season: "all", scope: "venue" });
  const [board, setBoard] = useState<Board | null>(null);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    void (async () => {
      const res = await fetch(`/api/venues/${venueId}/rankings`, { cache: "no-store" });
      if (!res.ok) return setMissing(true);
      const data = await readJson(res);
      setChoices(data.choices);
      setRules(data.rules);
      if (data.choices.pools[0]) setPick((p) => ({ ...p, pool: `${data.choices.pools[0].sport}|${data.choices.pools[0].format}` }));
    })();
  }, [venueId]);

  const loadBoard = useCallback(async () => {
    if (!pick.pool) return;
    const [sport, format] = pick.pool.split("|");
    const res = await fetch(`/api/venues/${venueId}/rankings?sport=${sport}&format=${format}&season=${pick.season}&scope=${pick.scope}`, { cache: "no-store" });
    if (res.ok) setBoard((await readJson(res)).board);
    else setBoard(null);
  }, [venueId, pick]);
  useEffect(() => {
    void loadBoard();
  }, [loadBoard]);

  if (missing) return <p className="text-sm text-slate-600">{t("rt.board.missing")}</p>;
  if (!choices) return null;
  const input = "rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-teal-500 focus:outline-none";
  const rankAfter = rules?.rankAfter ?? rules?.provisionalGames ?? 0;
  return (
    <div className="max-w-3xl space-y-4">
      <div>
        <Link href={`/venue/${venueId}`} className="text-sm text-teal-700 underline">
          ← {board?.venueName ?? t("rt.board.venue")}
        </Link>
        <h1 className="mt-2 text-2xl font-bold">{t("rt.board.title", { venue: board?.venueName ?? "" })}</h1>
        <p className="mt-1 text-sm text-slate-600">{t("rt.board.intro", { n: rankAfter })}</p>
        <p className="mt-1 text-sm text-slate-600">{t("rk1.note", { n: rankAfter })}</p>
      </div>
      {choices.pools.length === 0 ? (
        <p className="text-sm text-slate-500">{t("rt.board.none")}</p>
      ) : (
        <>
          <div className="flex flex-wrap gap-3">
            <label className="flex flex-col text-xs text-slate-500">
              {t("rt.board.sport")}
              <select value={pick.pool} onChange={(e) => setPick({ ...pick, pool: e.target.value })} className={input} name="pool">
                {choices.pools.map((p) => (
                  <option key={`${p.sport}|${p.format}`} value={`${p.sport}|${p.format}`}>
                    {sportLabel(t, p.sport)}, {t(`rt.format.${p.format}`)}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col text-xs text-slate-500">
              {t("rt.board.season")}
              <select value={pick.season} onChange={(e) => setPick({ ...pick, season: e.target.value })} className={input} name="season">
                <option value="all">{t("rt.board.allTime")}</option>
                {choices.seasons.map((y) => (
                  <option key={y} value={String(y)}>
                    {y}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex flex-col text-xs text-slate-500">
              {t("rt.board.scope")}
              <select value={pick.scope} onChange={(e) => setPick({ ...pick, scope: e.target.value as "venue" | "business" })} className={input} name="scope">
                <option value="venue">{t("rt.board.scope.venue")}</option>
                <option value="business">{t("rt.board.scope.business")}</option>
              </select>
            </label>
          </div>
          {board && board.rows.length === 0 ? (
            <p className="text-sm text-slate-500">{t("rt.board.empty")}</p>
          ) : (
            board && (
              <div className="overflow-x-auto">
                <table className="w-full text-left text-sm" data-testid="rankings">
                  <caption className="sr-only">{t("rt.board.title", { venue: board.venueName })}</caption>
                  <thead className="text-xs text-slate-500">
                    <tr>
                      <th scope="col" className="py-1 pr-3">{t("rt.board.col.rank")}</th>
                      <th scope="col" className="py-1 pr-3">{t("rt.board.col.name")}</th>
                      <th scope="col" className="py-1 pr-3">{t("rt.board.col.rating")}</th>
                      <th scope="col" className="py-1 pr-3">{t("rt.board.col.played")}</th>
                      <th scope="col" className="py-1 pr-3">{t("rt.board.col.record")}</th>
                      <th scope="col" className="py-1">{t("rt.board.col.form")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {board.rows.map((r) => (
                      <tr key={`${r.rank}${r.name}${r.venue ?? ""}`} className="border-t border-slate-100">
                        <td className="py-1.5 pr-3 tabular-nums">{r.rank}</td>
                        <td className="py-1.5 pr-3">
                          {r.name}
                          {r.kind === "team" && <span className="ml-1 text-xs text-slate-500">({t("rt.board.team")})</span>}
                          {pick.scope === "business" && r.venue && <span className="ml-1 text-xs text-slate-500">· {r.venue}</span>}
                        </td>
                        <td className="py-1.5 pr-3 font-semibold tabular-nums">{r.rating}</td>
                        <td className="py-1.5 pr-3 tabular-nums">{r.games}</td>
                        <td className="py-1.5 pr-3 tabular-nums">
                          {r.wins}–{r.draws}–{r.losses}
                        </td>
                        <td className="py-1.5 font-mono tracking-widest">{r.form.join("")}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )
          )}
          {board && board.provisional && board.provisional.length > 0 && (
            <section aria-labelledby="provisional-heading" className="rounded-lg border border-dashed border-slate-300 bg-slate-50 p-3" data-testid="provisional">
              <h2 id="provisional-heading" className="font-semibold text-slate-800">
                {t("rk1.provisional.title", { n: board.rankAfter ?? rankAfter })}
              </h2>
              <p className="mt-1 text-sm text-slate-600">{t("rk1.provisional.intro", { n: board.rankAfter ?? rankAfter })}</p>
              <div className="mt-2 overflow-x-auto">
                <table className="w-full text-left text-sm">
                  <caption className="sr-only">{t("rk1.provisional.caption")}</caption>
                  <thead className="text-xs text-slate-500">
                    <tr>
                      <th scope="col" className="py-1 pr-3">{t("rt.board.col.name")}</th>
                      <th scope="col" className="py-1 pr-3">{t("rt.board.col.rating")}</th>
                      <th scope="col" className="py-1">{t("rt.board.col.played")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {board.provisional.map((r) => (
                      <tr key={`${r.kind}${r.name}`} className="border-t border-slate-200">
                        <td className="py-1.5 pr-3">
                          {r.name}
                          {r.kind === "team" && <span className="ml-1 text-xs text-slate-500">({t("rt.board.team")})</span>}
                        </td>
                        <td className="py-1.5 pr-3 tabular-nums">{r.rating}</td>
                        <td className="py-1.5 tabular-nums">{r.games}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </>
      )}
    </div>
  );
}
