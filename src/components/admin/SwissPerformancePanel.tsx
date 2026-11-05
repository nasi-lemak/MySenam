"use client";

import { useState } from "react";
import { formatMinute } from "@/lib/interval";
import type { RegroupPreview } from "@/lib/swiss-performances";
import type { TournamentDetail } from "@/lib/tournaments";
import { ManagerOnly, useStaffMay } from "./StaffMay";
import { useStaffT } from "./StaffLanguage";

type Call = (url: string, body: object) => Promise<{ ok: boolean; data: Record<string, unknown> }>;

/**
 * A counted event played in Swiss rounds, as the organiser runs it (docs/features/tournaments.md#swiss-for-performance-events, ADR 0038):
 * the standing across the rounds with the rule that adds the placings up and what separated anybody level, every round's groups (formed
 * from the standing the round before left), and what a correction put in doubt: a later round whose groups the corrected standings would
 * form differently is flagged, nobody is moved, and a manager keeps the groups or groups the round again (with a preview) while nobody has
 * climbed it. The counts themselves are entered in the groups below, as for any counted event.
 */
export function SwissPerformancePanel({ tn, names, base, call }: { tn: TournamentDetail; names: Map<number, string>; base: string; call: Call }) {
  const t = useStaffT();
  const runs = useStaffMay()("tournamentRun");
  const s = tn.performance?.swiss;
  const [error, setError] = useState<string | null>(null);
  const [reason, setReason] = useState<Record<number, string>>({});
  const [preview, setPreview] = useState<RegroupPreview | null>(null);
  if (!s) return null;
  const button = "rounded-md border border-slate-300 px-2 py-1 text-xs font-medium hover:border-teal-500 disabled:opacity-40";
  const name = (id: number | null) => (id === null ? "" : (names.get(id) ?? "?"));
  const latest = s.rounds[s.rounds.length - 1];
  const blockedWhy = s.blocked?.startsWith("NO_TIME") ? t("sw3.pf.noTime") : null;
  async function run(body: object, then?: (data: Record<string, unknown>) => void) {
    setError(null);
    const done = await call(base, body);
    if (!done.ok) setError(String(done.data.error ?? ""));
    else then?.(done.data);
  }
  const why = (r: number) => (reason[r] ?? "").trim();
  const separation = (l: (typeof s.standings)[number]) =>
    !l.tie
      ? null
      : l.tie.by === "seed"
        ? t("sw3.pf.tie.seed", { name: name(l.tie.above), ahead: l.tie.ahead ?? "–", behind: l.tie.behind ?? "–" })
        : t("sw3.pf.tie.countback", { name: name(l.tie.above), ahead: l.tie.ahead ?? "–", behind: l.tie.behind ?? "–" });

  return (
    <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 text-sm shadow-sm" aria-label={t("sw3.pf.title")}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold">{t("sw3.pf.title")}</h3>
        <span className="text-xs text-slate-500">{t("sw3.pf.roundsGrouped", { grouped: s.rounds.length, total: s.roundsTotal })}</span>
      </div>
      <p className="text-xs text-slate-500">{s.cumulative === "best_n" ? t("sw3.pf.rule.bestN", { n: s.bestN ?? 0 }) : t("sw3.pf.rule.sum")}</p>
      <p className="text-xs text-slate-500">{t("sw3.pf.groupingNote")}</p>
      {error && <p className="text-red-700">{error}</p>}

      {blockedWhy && tn.status === "drawn" && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3">
          <p className="font-medium text-amber-900">{t("sw3.pf.notGrouped", { n: (latest?.round ?? 0) + 1 })}</p>
          <p className="mt-1 text-xs text-amber-900">{blockedWhy}</p>
          <ManagerOnly may="tournamentRun">
            <button onClick={() => void run({ action: "swiss_pair" })} className={`mt-2 ${button}`}>
              {t("sw3.pf.groupNext", { n: (latest?.round ?? 0) + 1 })}
            </button>
          </ManagerOnly>
        </div>
      )}

      {s.review.map((r) => (
        <div key={r.round} className="rounded-lg border border-amber-300 bg-amber-50 p-3" role="group" aria-label={t("sw3.pf.review.title", { n: r.round })}>
          <p className="font-medium text-amber-900">{t("sw3.pf.review.title", { n: r.round })}</p>
          <p className="mt-1 text-xs text-amber-900">{t("sw3.pf.review.body", { prev: r.round - 1, count: r.moves.length })}</p>
          <ul className="mt-1 list-disc pl-4 text-xs text-amber-900">
            {r.moves.map((m) => (
              <li key={m.entryId}>{t("sw3.pf.review.move", { name: name(m.entryId), from: m.from, to: m.to })}</li>
            ))}
          </ul>
          <ManagerOnly may="tournamentRun">
            <label className="mt-2 flex flex-col text-xs font-medium text-slate-600">
              {t("sw3.pf.reason")}
              <input value={reason[r.round] ?? ""} onChange={(e) => setReason({ ...reason, [r.round]: e.target.value })} maxLength={300} className="w-full max-w-md rounded border border-slate-300 px-2 py-1 text-sm font-normal text-slate-900" />
            </label>
            <div className="mt-2 flex flex-wrap gap-2">
              <button disabled={why(r.round).length < 3} onClick={() => void run({ action: "swiss_keep_grouping", round: r.round, reason: why(r.round) })} className={button}>
                {t("sw3.pf.keep")}
              </button>
              <button onClick={() => void run({ action: "swiss_regroup", round: r.round, preview: true }, (data) => setPreview(data.preview as RegroupPreview))} className={button}>
                {t("sw3.pf.regroupPreview")}
              </button>
            </div>
            {preview && preview.round === r.round && (
              <div className="mt-2 rounded border border-teal-200 bg-teal-50 p-2 text-xs" aria-live="polite">
                <ul className="list-disc pl-4">
                  {preview.moves.map((m) => (
                    <li key={m.entryId}>{t("sw3.pf.review.move", { name: name(m.entryId), from: m.from, to: m.to })}</li>
                  ))}
                </ul>
                {preview.dropped.length > 0 && <p className="mt-1">{t("sw3.pf.regroup.dropped", { names: preview.dropped.map(name).join(", ") })}</p>}
                {preview.cleared.length > 0 && <p className="mt-1">{t("sw3.pf.regroup.cleared", { rounds: preview.cleared.join(", ") })}</p>}
                <button
                  disabled={why(r.round).length < 3}
                  onClick={() =>
                    window.confirm(t("sw3.pf.regroup.confirm", { n: r.round })) &&
                    void run({ action: "swiss_regroup", round: r.round, token: preview.token, reason: why(r.round) }, () => setPreview(null))
                  }
                  className={`mt-2 ${button}`}
                >
                  {t("sw3.pf.regroup.go", { n: r.round })}
                </button>
              </div>
            )}
          </ManagerOnly>
        </div>
      ))}

      <div className="overflow-x-auto">
        <table className="w-full min-w-[22rem]">
          <thead className="text-xs text-slate-500">
            <tr>
              <th scope="col" className="w-8 text-left font-medium">
                #
              </th>
              <th scope="col" className="text-left font-medium">
                {t("sw.player")}
              </th>
              <th scope="col" className="w-14 font-medium">
                {t("sw3.pf.total")}
              </th>
              <th scope="col" className="text-left font-medium">
                {t("sw3.pf.placings")}
              </th>
              <th scope="col" className="text-left font-medium">
                {t("sw3.tb.separated")}
              </th>
            </tr>
          </thead>
          <tbody>
            {s.standings.map((l) => (
              <tr key={l.entryId} className={`align-top ${l.out ? "text-slate-400" : ""}`}>
                <td className="py-0.5">{l.rank ?? "–"}</td>
                <td>
                  {name(l.entryId)}
                  {l.out && <span className="ml-1 text-xs">({t(l.resultsVoid ? "sw.outVoid" : "sw.out", { reason: t(`tn.out.${l.out}`) })})</span>}
                </td>
                <td className="text-center font-medium">{l.placings.length > 0 ? l.total : "–"}</td>
                <td className="text-xs">{l.placings.join(", ")}</td>
                <td className={`text-xs ${l.tie?.by === "seed" ? "text-amber-800" : "text-slate-600"}`}>
                  {l.tie?.by === "seed" ? <span aria-hidden="true">⚠ </span> : null}
                  {separation(l)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {[...s.rounds].reverse().map((r) => (
        <details key={r.round} open={r === latest} className="rounded-lg border border-slate-200 p-3">
          <summary className="cursor-pointer font-medium">
            {t("sw3.pf.round", { n: r.round })} {r.complete ? <span className="text-xs font-normal text-emerald-700">✓ {t("sw3.pf.complete")}</span> : null}
          </summary>
          <ul className="mt-2 space-y-1">
            {r.heats.map((h) => {
              const m = tn.matches.find((x) => x.id === h.matchId);
              const place = (id: number) => r.notes.find((n) => n.heat === h.heat)?.members.find((x) => x.id === id)?.place ?? null;
              return (
                <li key={h.matchId}>
                  <span className="font-medium">{t("sw3.pf.group", { n: h.heat })}</span>{" "}
                  <span className="text-xs text-slate-500">{m?.date ? `${m.date} ${m.minute !== null ? formatMinute(m.minute, t.locale) : ""} ${m.courtName ?? ""}` : t("sw.noCourt")}</span>
                  <div className="text-xs">
                    {h.entryIds.map((id, i) => (
                      <span key={id} className="mr-2">
                        {i + 1}. {name(id)}
                        {place(id) !== null ? ` (${t("sw3.pf.wasPlace", { n: place(id)! })})` : ""}
                      </span>
                    ))}
                  </div>
                </li>
              );
            })}
          </ul>
        </details>
      ))}
      {runs && tn.status === "drawn" && s.nextRound !== null && !blockedWhy && (
        <button onClick={() => void run({ action: "swiss_pair" })} className={button}>
          {t("sw3.pf.groupNext", { n: s.nextRound })}
        </button>
      )}
    </section>
  );
}
