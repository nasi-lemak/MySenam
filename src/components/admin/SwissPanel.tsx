"use client";

import { useState } from "react";
import { formatMinute } from "@/lib/interval";
import type { TournamentDetail } from "@/lib/tournaments";
import { useStaffMay, ManagerOnly } from "./StaffMay";
import { useStaffT } from "./StaffLanguage";

type Call = (url: string, body: object) => Promise<{ ok: boolean; data: Record<string, unknown> }>;

/**
 * A Swiss event as the organiser runs it (docs/features/tournaments.md#swiss-tournaments): the table with its published tie-breaks, every
 * round's pairings and why each was made, and what the organiser may do between rounds: pair the next round where it could not be
 * paired by itself, close the round with matches undecided (a walkover to a side, or neither came), or end the event after the last round
 * paired. Results are entered in the matches list below, as for any tournament.
 */
export function SwissPanel({ tn, names, base, call }: { tn: TournamentDetail; names: Map<number, string>; base: string; call: Call }) {
  const t = useStaffT();
  const runs = useStaffMay()("tournamentRun");
  const s = tn.swiss;
  const [closing, setClosing] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);
  if (!s) return null;
  const latest = s.rounds[s.rounds.length - 1];
  const open = latest ? tn.matches.filter((m) => m.stage === "group" && m.round === latest.round && m.status === "scheduled" && m.a !== null && m.b !== null) : [];
  const button = "rounded-md border border-slate-300 px-2 py-1 text-xs font-medium hover:border-teal-500";
  const name = (id: number | null) => (id === null ? "" : (names.get(id) ?? "?"));
  async function run(body: object) {
    setError(null);
    const done = await call(base, body);
    if (!done.ok) setError(String(done.data.error ?? ""));
  }
  const blockedWhy = s.blocked?.startsWith("NO_TIME") ? t("sw.blocked.noTime") : s.blocked?.startsWith("NO_PAIRING") ? t("sw.blocked.noPairing") : null;
  const complete = latest?.complete ?? false;
  return (
    <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 text-sm shadow-sm" aria-label={t("sw.title")}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold">{t("sw.title")}</h3>
        <span className="text-xs text-slate-500">{t("sw.roundsPaired", { paired: s.rounds.length, total: s.roundsTotal })}</span>
      </div>
      <p className="text-xs text-slate-500">{t("sw.rulesNote", { list: s.tiebreaks.map((k) => t(`sw.tb.${k}`)).join(", "), bye: s.byePoints })}</p>
      <p className="text-xs text-slate-500">{t("sw.pairingNote")}</p>
      {error && <p className="text-red-700">{error}</p>}
      {blockedWhy && tn.status === "drawn" && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3">
          <p className="font-medium text-amber-900">{t("sw.notPaired", { n: (latest?.round ?? 0) + 1 })}</p>
          <p className="mt-1 text-xs text-amber-900">{blockedWhy}</p>
          <ManagerOnly may="tournamentRun">
            <div className="mt-2 flex flex-wrap gap-2">
              <button onClick={() => void run({ action: "swiss_pair" })} className={button}>
                {t("sw.pairAgain", { n: (latest?.round ?? 0) + 1 })}
              </button>
              <button
                onClick={() => window.confirm(t("sw.endConfirm", { n: latest?.round ?? 0 })) && void run({ action: "swiss_end" })}
                className={button}
              >
                {t("sw.endEarly", { n: latest?.round ?? 0 })}
              </button>
            </div>
          </ManagerOnly>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[22rem]">
          <thead className="text-xs text-slate-500">
            <tr>
              <th className="w-8 text-left font-medium">#</th>
              <th className="text-left font-medium">{t("sw.player")}</th>
              <th className="w-12 font-medium">{t("sw.record")}</th>
              <th className="w-10 font-medium">{t("sw.pts")}</th>
              <th className="w-12 font-medium">{t("sw.buch")}</th>
              <th className="w-12 font-medium">{t("sw.median")}</th>
            </tr>
          </thead>
          <tbody>
            {s.standings.map((l) => (
              <tr key={l.entryId} className={l.out ? "text-slate-400" : ""}>
                <td className="py-0.5">{l.rank > 0 ? l.rank : "–"}</td>
                <td>
                  {name(l.entryId)}
                  {l.out && <span className="ml-1 text-xs">({t(l.resultsVoid ? "sw.outVoid" : "sw.out", { reason: t(`tn.out.${l.out}`) })})</span>}
                  {l.byes > 0 && <span className="ml-1 text-xs text-slate-500">({t("sw.byes", { n: l.byes })})</span>}
                </td>
                <td className="text-center">
                  {l.won}–{l.drawn}–{l.lost}
                </td>
                <td className="text-center font-medium">{l.points}</td>
                <td className="text-center">{l.buchholz}</td>
                <td className="text-center">{l.medianBuchholz}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {[...s.rounds].reverse().map((r) => {
        const matches = tn.matches.filter((m) => m.stage === "group" && m.round === r.round).sort((a, b) => a.position - b.position);
        return (
          <details key={r.round} open={r === latest} className="rounded-lg border border-slate-200 p-3">
            <summary className="cursor-pointer font-medium">
              {t("sw.round", { n: r.round })} {r.complete ? <span className="text-xs font-normal text-emerald-700">✓ {t("sw.complete")}</span> : null}
            </summary>
            <ul className="mt-2 space-y-1">
              {matches.map((m) => {
                const note = r.notes.find((n) => n.a === m.a && n.b === m.b) ?? r.notes.find((n) => n.kind === "bye" && n.a === m.a && m.b === null);
                return (
                  <li key={m.id} className="flex flex-wrap gap-x-2">
                    {m.status === "bye" && m.b === null ? (
                      <span>
                        {t("sw.bye", { name: name(m.a) })} <span className="text-xs text-slate-500">{t("sw.byeWhy", { pts: note?.aPoints ?? 0 })}</span>
                      </span>
                    ) : (
                      <>
                        <span className="text-xs text-slate-500">{m.date ? `${m.date} ${m.minute !== null ? formatMinute(m.minute, t.locale) : ""} ${m.courtName ?? ""}` : t("sw.noCourt")}</span>
                        <span className={m.winner === m.a ? "font-semibold" : ""}>{name(m.a)}</span>
                        <span className="text-slate-400">{t("tn.versus")}</span>
                        <span className={m.winner === m.b ? "font-semibold" : ""}>{name(m.b)}</span>
                        {note && (
                          <span className="text-xs text-slate-500">
                            ({note.aPoints}–{note.bPoints}
                            {note.float ? `, ${t("sw.float")}` : ""})
                          </span>
                        )}
                        {m.status !== "scheduled" && (
                          <span className="text-xs text-emerald-700">
                            ✓ {m.status === "walkover" ? t("tn.st.walkover") : m.status === "bye" ? t("sw.nobody") : m.status === "retired" ? t("tn.st.retired", { score: m.score ?? "" }) : (m.score ?? "")}
                          </span>
                        )}
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
          </details>
        );
      })}
      {runs && tn.status === "drawn" && latest && open.length > 0 && (
        <details className="rounded-lg border border-amber-200 bg-amber-50 p-3">
          <summary className="cursor-pointer font-medium text-amber-900">{t("sw.closeRound", { n: latest.round })}</summary>
          <p className="mt-1 text-xs text-amber-900">{t("sw.closeNote")}</p>
          <ul className="mt-2 space-y-2">
            {open.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center gap-2">
                <span>
                  {name(m.a)} {t("tn.versus")} {name(m.b)}
                </span>
                <select
                  aria-label={t("sw.closeAnswer", { a: name(m.a), b: name(m.b) })}
                  value={closing[m.id] ?? ""}
                  onChange={(e) => setClosing({ ...closing, [m.id]: e.target.value })}
                  className="rounded border border-slate-300 px-1 py-1 text-xs"
                >
                  <option value="">{t("sw.choose")}</option>
                  <option value={String(m.a)}>{t("sw.walkoverTo", { name: name(m.a) })}</option>
                  <option value={String(m.b)}>{t("sw.walkoverTo", { name: name(m.b) })}</option>
                  <option value="none">{t("sw.neither")}</option>
                </select>
              </li>
            ))}
          </ul>
          <button
            disabled={open.some((m) => !closing[m.id])}
            onClick={() =>
              window.confirm(t("sw.closeConfirm", { n: latest.round })) &&
              void run({ action: "swiss_close_round", round: latest.round, resolutions: open.map((m) => ({ matchId: m.id, winner: closing[m.id] === "none" ? null : Number(closing[m.id]) })) })
            }
            className="mt-2 rounded-md bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
          >
            {t("sw.closeSubmit", { n: latest.round })}
          </button>
        </details>
      )}
      {runs && tn.status === "drawn" && s.nextRound !== null && !blockedWhy && complete && (
        <button onClick={() => void run({ action: "swiss_pair" })} className={button}>
          {t("sw.pairAgain", { n: s.nextRound })}
        </button>
      )}
    </section>
  );
}
