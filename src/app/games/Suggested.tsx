"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { activityIcon } from "@/lib/activity-registry";
import { sportLabel, type T } from "@/lib/i18n";
import { formatHour } from "@/lib/time";
import { shortDate } from "@/lib/region";
import type { ExclusionCode, GameMatch, GameRecommendations, Reason } from "@/lib/matchmaking";

/** One reason a game was suggested, in the reader's language. */
export function reasonText(t: T, r: Reason): string {
  const vars = { ...(r.vars ?? {}) } as Record<string, string | number>;
  if (typeof vars.sport === "string") vars.sport = sportLabel(t, vars.sport);
  return t(`match.reason.${r.code}`, vars);
}

/**
 * Games suggested for the signed-in player, best first, each with why: the
 * reasons are the points it scored (lib/matchmaking.ts), and what was left
 * out is counted by why.
 */
export function Suggested({ t, refreshKey, join }: { t: T; refreshKey: number; join: (g: GameMatch) => React.ReactNode }) {
  const [rec, setRec] = useState<GameRecommendations | null>(null);
  useEffect(() => {
    fetch("/api/games/recommended?limit=6", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then(setRec);
  }, [refreshKey]);
  if (!rec) return null;
  const out = Object.entries(rec.excluded) as [ExclusionCode, number][];
  return (
    <section className="space-y-3 rounded-xl border border-indigo-200 bg-indigo-50/40 p-4" data-testid="suggested">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold text-indigo-950">{t("match.title")}</h2>
        <Link href="/games/preferences" className="text-sm text-indigo-700 underline">
          {t("games.preferences")}
        </Link>
      </div>
      <p className="text-sm text-slate-600">
        {t("match.intro")} {!rec.basis.hasPoint && !rec.basis.area && Object.keys(rec.basis.levels).length === 0 && t("match.setUp")}
      </p>
      {rec.stopped === "NO_SHOWS" ? (
        <p className="text-sm text-amber-800">{t("match.noShows")}</p>
      ) : rec.games.length === 0 ? (
        <p className="text-sm text-slate-500">{t("match.none")}</p>
      ) : (
        <ul className="space-y-2">
          {rec.games.map((g) => (
            <li key={g.id} className="rounded-lg bg-white p-3 text-sm shadow-sm" data-testid={`suggested-${g.id}`}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <div className="font-medium">
                    {activityIcon(g.sport)} {shortDate(g.date, t.locale, true)}, {formatHour(g.startHour)}–{formatHour(g.endHour)} · {g.venueName}
                  </div>
                  <ul className="mt-1 flex flex-wrap gap-1.5" aria-label={t("match.points", { n: g.match.score })}>
                    {g.match.reasons.map((r) => (
                      <li key={r.code} className={`rounded-full px-2 py-0.5 text-xs ${r.points < 0 ? "bg-amber-50 text-amber-800" : "bg-indigo-50 text-indigo-800"}`}>
                        {reasonText(t, r)}
                      </li>
                    ))}
                  </ul>
                </div>
                <div className="text-right">
                  <div className="font-bold">{g.share > 0 ? t("games.share", { amount: g.share.toFixed(2) }) : t("games.free")}</div>
                  <div className="mt-1">{join(g)}</div>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
      {out.length > 0 && (
        <p className="text-xs text-slate-500">
          {t("match.leftOut")} {out.map(([code, n]) => t(`match.out.${code}`, { n })).join(" · ")}
        </p>
      )}
    </section>
  );
}
