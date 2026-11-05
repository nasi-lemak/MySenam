"use client";

import { useState } from "react";
import { formatMinute } from "@/lib/interval";
import type { RoundPreview } from "@/lib/swiss";
import type { TournamentDetail } from "@/lib/tournaments";
import { useStaffMay, ManagerOnly } from "./StaffMay";
import { useStaffT } from "./StaffLanguage";
import { bakuNote, showPoints } from "@/lib/swiss-columns";
import { SwissTiebreaks } from "./SwissTiebreaks";

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
  // The next round as it would be paired (ADR 0038): each pairing with its reason, before it is made.
  const [preview, setPreview] = useState<RoundPreview | null>(null);
  if (!s) return null;
  const latest = s.rounds[s.rounds.length - 1];
  const open = latest ? tn.matches.filter((m) => m.stage === "group" && m.round === latest.round && m.status === "scheduled" && m.a !== null && m.b !== null) : [];
  const button = "rounded-md border border-slate-300 px-2 py-1 text-xs font-medium hover:border-teal-500";
  const name = (id: number | null) => (id === null ? "" : (names.get(id) ?? "?"));
  async function run(body: object) {
    setError(null);
    const done = await call(base, body);
    if (!done.ok) setError(String(done.data.error ?? ""));
    else setPreview(null);
  }
  async function look() {
    setError(null);
    const done = await call(base, { action: "swiss_preview" });
    if (!done.ok) setError(String(done.data.error ?? ""));
    else setPreview(done.data.preview as RoundPreview);
  }
  /** A pairing's points as it was made: the real points, and the virtual ones of an accelerated round where there were any. */
  const halves = tn.rules.scoring.pointsInHalves === true;
  const pts = (real: number | null, virtual?: number) => (virtual ? `${showPoints(real ?? 0, halves)} + ${showPoints(virtual, halves)} ${t("sw3.accelShort")}` : showPoints(real ?? 0, halves));
  const blockedWhy = s.blocked?.startsWith("NO_TIME") ? t("sw.blocked.noTime") : s.blocked?.startsWith("NO_PAIRING") ? t("sw.blocked.noPairing") : null;
  const complete = latest?.complete ?? false;
  return (
    <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 text-sm shadow-sm" aria-label={t("sw.title")}>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold">{t("sw.title")}</h3>
        <span className="text-xs text-slate-500">{t("sw.roundsPaired", { paired: s.rounds.length, total: s.roundsTotal })}</span>
      </div>
      <p className="text-xs text-slate-500">{t("sw.rulesNote", { list: s.tiebreaks.map((k) => t(`sw.tb.${k}`)).join(", "), bye: showPoints(s.byePoints, halves) })}</p>
      <p className="text-xs text-slate-500">{t("sw.pairingNote")}</p>
      {s.acceleration && s.acceleration.method === "baku" && (
        <p className="text-xs text-slate-500">{t(bakuNote(s.acceleration).half ? "swb.accel" : "swb.accelFull", bakuNote(s.acceleration).params)}</p>
      )}
      {s.acceleration && s.acceleration.method !== "baku" && <p className="text-xs text-slate-500">{t("sw3.accel", { rounds: s.acceleration.rounds, group: s.acceleration.group, points: s.acceleration.points })}</p>}
      {error && <p className="text-red-700">{error}</p>}
      {blockedWhy && tn.status === "drawn" && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-3">
          <p className="font-medium text-amber-900">{t("sw.notPaired", { n: (latest?.round ?? 0) + 1 })}</p>
          <p className="mt-1 text-xs text-amber-900">{blockedWhy}</p>
          <ManagerOnly may="tournamentRun">
            <div className="mt-2 flex flex-wrap gap-2">
              <button onClick={() => void look()} className={button}>
                {t("sw3.preview.button", { n: (latest?.round ?? 0) + 1 })}
              </button>
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
                <td className="text-center font-medium">{showPoints(l.points, halves)}</td>
                <td className="text-center">{showPoints(l.buchholz, halves)}</td>
                <td className="text-center">{showPoints(l.medianBuchholz, halves)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <SwissTiebreaks tn={tn} names={names} base={base} call={call} />
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
                        {t("sw.bye", { name: name(m.a) })} <span className="text-xs text-slate-500">{t("sw.byeWhy", { pts: showPoints(note?.aPoints ?? 0, halves) })}</span>
                      </span>
                    ) : (
                      <>
                        <span className="text-xs text-slate-500">{m.date ? `${m.date} ${m.minute !== null ? formatMinute(m.minute, t.locale) : ""} ${m.courtName ?? ""}` : t("sw.noCourt")}</span>
                        <span className={m.winner === m.a ? "font-semibold" : ""}>{name(m.a)}</span>
                        <span className="text-slate-400">{t("tn.versus")}</span>
                        <span className={m.winner === m.b ? "font-semibold" : ""}>{name(m.b)}</span>
                        {note && (
                          <span className="text-xs text-slate-500">
                            ({pts(note.aPoints, note.aVirtual)}–{pts(note.bPoints, note.bVirtual)}
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
      {preview && (
        <div className="rounded-lg border border-teal-200 bg-teal-50 p-3 text-xs" aria-live="polite">
          <p className="font-medium text-teal-900">{t("sw3.preview.title", { n: preview.round })}</p>
          <ul className="mt-1 space-y-0.5">
            {preview.pairs.map((p) => (
              <li key={`${p.a}-${p.b}`}>
                {name(p.a)} {t("tn.versus")} {name(p.b)}{" "}
                <span className="text-slate-500">
                  ({pts(p.note.aPoints, p.note.aVirtual)}–{pts(p.note.bPoints, p.note.bVirtual)}
                  {p.note.float ? `, ${t("sw.float")}` : ""})
                </span>
              </li>
            ))}
            {preview.bye && (
              <li>
                {t("sw3.preview.bye", { name: name(preview.bye.id) })} <span className="text-slate-500">{t("sw.byeWhy", { pts: showPoints(preview.bye.note.aPoints, halves) })}</span>
              </li>
            )}
          </ul>
          <p className={`mt-1 ${preview.unplaced > 0 ? "text-amber-900" : "text-slate-600"}`}>{preview.unplaced > 0 ? t("sw3.preview.unplaced", { n: preview.unplaced }) : t("sw3.preview.fits")}</p>
          <button onClick={() => setPreview(null)} className={`mt-2 ${button}`}>
            {t("sw3.preview.close")}
          </button>
        </div>
      )}
      {runs && tn.status === "drawn" && s.nextRound !== null && !blockedWhy && complete && (
        <div className="flex flex-wrap gap-2">
          <button onClick={() => void look()} className={button}>
            {t("sw3.preview.button", { n: s.nextRound })}
          </button>
          <button onClick={() => void run({ action: "swiss_pair" })} className={button}>
            {t("sw.pairAgain", { n: s.nextRound })}
          </button>
        </div>
      )}
    </section>
  );
}
