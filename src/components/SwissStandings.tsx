import type { T } from "@/lib/i18n";
import { formatMinute } from "@/lib/interval";
import { bakuNote, showPoints, showValue, tiebreakValue } from "@/lib/swiss-columns";
import type { Match, TournamentDetail } from "@/lib/tournaments";

/**
 * A Swiss event for anybody (docs/features/tournaments.md#swiss-tournaments): the table after the rounds played, ranked by points and
 * the event's published tie-breaks, and every round's pairings with why each was made and its results. Names as the page shows them
 * (a declared minor by first name and initial).
 */
export function SwissStandings({ t, x, names }: { t: T; x: TournamentDetail; names: Map<number, string> }) {
  const s = x.swiss;
  if (!s) return null;
  const played = s.rounds.filter((r) => r.complete).length;
  const tally = x.rules.scoring.kind === "tally";
  /** A pairing's points as it was made: the real points, and the virtual ones of an accelerated round where there were any. */
  const halves = x.rules.scoring.pointsInHalves === true;
  const pts = (real: number | null, virtual?: number) => (virtual ? `${showPoints(real ?? 0, halves)} + ${showPoints(virtual, halves)} ${t("swiss.ui.accelShort")}` : showPoints(real ?? 0, halves));
  // The event's other tie-breaks as columns, in the order they are applied (Buchholz and wins are columns already; who beat whom has no number).
  const extra = s.tiebreaks.filter((k) => k !== "buchholz" && k !== "wins" && k !== "head_to_head");
  const result = (m: Match) =>
    m.status === "walkover"
      ? t("tour.walkover")
      : m.status === "retired"
        ? `${m.score ?? ""} (${t("tour.retired")})`
        : m.status === "done" && m.winner === null
          ? `${m.score ?? ""} (${t("tour.drawn")})`
          : m.status === "done"
            ? (m.score ?? "")
            : m.status === "bye" && m.winner === null
              ? t("swiss.ui.nobody")
              : "";
  return (
    <section className="space-y-4">
      <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="font-semibold">{t("swiss.ui.title", { played, total: s.roundsTotal })}</h2>
        <p className="mt-1 text-xs text-slate-500">{t("swiss.ui.rules", { list: s.tiebreaks.map((k) => t(`swiss.ui.tb.${k}`)).join(", ") })}</p>
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[20rem] text-sm">
            <thead className="text-xs text-slate-500">
              <tr>
                <th className="w-8 text-left font-medium">#</th>
                <th className="text-left font-medium" />
                <th className="w-8 font-medium">{t("tour.played")}</th>
                <th className="w-8 font-medium">{t("tour.won")}</th>
                {tally && <th className="w-8 font-medium">{t("tour.drawnShort")}</th>}
                <th className="w-8 font-medium">{t("tour.lost")}</th>
                <th className="w-12 font-medium">{t("swiss.ui.points")}</th>
                <th className="w-12 font-medium">{t("swiss.ui.buchholz")}</th>
                {extra.map((k) => (
                  <th key={k} scope="col" className="px-1 font-medium" title={t(`swiss.ui.tb.${k}`)}>
                    {t(`swiss.ui.tbs.${k}`)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {s.standings.map((l) => (
                <tr key={l.entryId} className={l.out ? "text-slate-400" : ""}>
                  <td className="py-0.5">{l.rank > 0 ? l.rank : "–"}</td>
                  <td>
                    {names.get(l.entryId)}
                    {l.out && (
                      <span className="ml-1 text-xs">
                        ({t(`tour.out.${l.out}`)}
                        {l.resultsVoid ? `, ${t("tour.resultsVoid")}` : ""})
                      </span>
                    )}
                    {l.byes > 0 && <span className="ml-1 text-xs text-slate-500">({t("swiss.ui.byes", { n: l.byes })})</span>}
                  </td>
                  <td className="text-center">{l.played}</td>
                  <td className="text-center">{l.won}</td>
                  {tally && <td className="text-center">{l.drawn}</td>}
                  <td className="text-center">{l.lost}</td>
                  <td className="text-center font-medium">{showPoints(l.points, halves)}</td>
                  <td className="text-center">{showValue(tiebreakValue(l, "buchholz", halves))}</td>
                  {extra.map((k) => (
                    <td key={k} className="px-1 text-center tabular-nums">
                      {showValue(tiebreakValue(l, k, halves))}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {s.acceleration && s.acceleration.method === "baku" && (
        <p className="mt-2 text-xs text-slate-500">{t(bakuNote(s.acceleration).half ? "swb.ui.accel" : "swb.ui.accelFull", bakuNote(s.acceleration).params)}</p>
      )}
        {s.acceleration && s.acceleration.method !== "baku" && <p className="mt-2 text-xs text-slate-500">{t("swiss.ui.accel", { rounds: s.acceleration.rounds, group: s.acceleration.group })}</p>}
        {s.nextRound !== null && <p className="mt-2 text-xs text-slate-500">{t("swiss.ui.next", { n: s.nextRound })}</p>}
      </div>
      {[...s.rounds].reverse().map((r) => {
        const matches = x.matches.filter((m) => m.stage === "group" && m.round === r.round).sort((a, b) => a.position - b.position);
        return (
          <details key={r.round} open={r === s.rounds[s.rounds.length - 1]} className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <summary className="cursor-pointer font-semibold">
              {t("swiss.ui.round", { n: r.round })} {r.complete && <span className="ml-1 text-xs font-normal text-slate-500">({t("swiss.ui.done")})</span>}
            </summary>
            <ul className="mt-2 divide-y divide-slate-100 text-sm">
              {matches.map((m) => {
                const note = r.notes.find((n) => n.a === m.a && n.b === m.b);
                return (
                  <li key={m.id} className="flex flex-wrap gap-x-3 py-1.5">
                    {m.status === "bye" && m.b === null ? (
                      <span className="flex-1">{t("swiss.ui.bye", { name: names.get(m.a!) ?? "" })}</span>
                    ) : (
                      <>
                        <span className="w-36 shrink-0 text-slate-500">
                          {m.date && m.minute !== null ? `${m.date} ${formatMinute(m.minute, t.locale)}, ${m.courtName ?? ""}` : ""}
                        </span>
                        <span className="flex-1">
                          {names.get(m.a!)} v {names.get(m.b!)}
                          {note && (
                            <span className="ml-1 text-xs text-slate-500">
                              ({pts(note.aPoints, note.aVirtual)}–{pts(note.bPoints, note.bVirtual)}
                              {note.float ? `, ${t("swiss.ui.float")}` : ""})
                            </span>
                          )}
                        </span>
                        <span className="text-slate-600">{result(m)}</span>
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          </details>
        );
      })}
    </section>
  );
}
