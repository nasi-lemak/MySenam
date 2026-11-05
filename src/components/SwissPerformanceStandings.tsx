import type { T } from "@/lib/i18n";
import type { TournamentDetail } from "@/lib/tournaments";

/**
 * A counted event played in Swiss rounds, for anybody (docs/features/tournaments.md#swiss-for-performance-events): the standing across the
 * rounds, the rule that adds the placings up, and when the next round's groups are formed. Names as the page shows them (a declared minor by
 * first name and initial). The groups themselves, with each round's counts, are listed by the page below.
 */
export function SwissPerformanceStandings({ t, x, names }: { t: T; x: TournamentDetail; names: Map<number, string> }) {
  const s = x.performance?.swiss;
  if (!s) return null;
  const played = s.rounds.filter((r) => r.complete).length;
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="font-semibold">{t("swpf.ui.title", { played, total: s.roundsTotal })}</h2>
      <p className="mt-1 text-xs text-slate-500">{s.cumulative === "best_n" ? t("swpf.ui.rule.bestN", { n: s.bestN ?? 0 }) : t("swpf.ui.rule.sum")}</p>
      {s.standings.some((l) => l.placings.length > 0) && (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[16rem] text-sm">
            <thead className="text-xs text-slate-500">
              <tr>
                <th scope="col" className="w-10 text-left font-medium">
                  {t("tour.rank")}
                </th>
                <th scope="col" className="text-left font-medium" />
                <th scope="col" className="w-14 text-right font-medium">
                  {t("swpf.ui.total")}
                </th>
                <th scope="col" className="pl-3 text-left font-medium">
                  {t("swpf.ui.placings")}
                </th>
              </tr>
            </thead>
            <tbody>
              {s.standings.map((l) => (
                <tr key={l.entryId} className={l.rank === null ? "text-slate-400" : ""}>
                  <td>{l.rank ?? "—"}</td>
                  <td className="pr-2">{names.get(l.entryId)}</td>
                  <td className="text-right font-medium tabular-nums">{l.rank === null ? "—" : l.total}</td>
                  <td className="pl-3 text-slate-600">{l.placings.join(", ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {s.nextRound !== null && <p className="mt-2 text-xs text-slate-500">{t("swpf.ui.next", { n: s.nextRound })}</p>}
    </div>
  );
}
