"use client";

import { useEffect, useState } from "react";
import type { TiebreakPreview } from "@/lib/swiss";
import { showPoints, showValue as show, tiebreakValue } from "@/lib/swiss-columns";
import { SWISS_TIEBREAKS, defaultSwissTiebreaks, type SwissTiebreak } from "@/lib/tournament-rules";
import type { TournamentDetail } from "@/lib/tournaments";
import { ManagerOnly } from "./StaffMay";
import { useStaffT } from "./StaffLanguage";

type Call = (url: string, body: object) => Promise<{ ok: boolean; data: Record<string, unknown> }>;

/**
 * The tie-break screen of a Swiss event (docs/features/tournaments.md#the-tie-break-screen, ADR 0038): the table with every published
 * tie-break as a column, for any two entries level on points which tie-break separated them and by how much (or that only the seed
 * did), and the order the tie-breaks are applied in, which a manager may change with a live preview of the table it would make. Locked
 * from round 1's pairing: then a change is saved with a reason, against the preview's token.
 */
export function SwissTiebreaks({ tn, names, base, call }: { tn: TournamentDetail; names: Map<number, string>; base: string; call: Call }) {
  const t = useStaffT();
  const s = tn.swiss;
  const current: SwissTiebreak[] = s?.tiebreaks ?? tn.rules.swiss?.tiebreaks ?? defaultSwissTiebreaks(tn.rules.scoring);
  const [draft, setDraft] = useState<SwissTiebreak[]>(current);
  const [preview, setPreview] = useState<TiebreakPreview | null>(null);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const locked = s !== null;
  const changed = draft.join() !== current.join();

  // What the table would become under the order being built, shown as it is built (never saved by looking).
  useEffect(() => {
    let live = true;
    if (!locked || !changed || draft.length === 0) {
      setPreview(null);
      return;
    }
    void call(base, { action: "swiss_tiebreaks", tiebreaks: draft, preview: true }).then((done) => {
      if (live) setPreview(done.ok ? (done.data.preview as TiebreakPreview) : null);
    });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [draft.join(), locked, changed]);

  const move = (i: number, by: -1 | 1) => {
    const next = [...draft];
    [next[i], next[i + by]] = [next[i + by], next[i]];
    setDraft(next);
  };
  const name = (id: number | null) => (id === null ? "" : (names.get(id) ?? "?"));
  const sequenceName = (k: SwissTiebreak) => t(`sw.tb.${k}`);

  async function save() {
    setError(null);
    if (draft.length === 0) return setError(t("sw3.tb.empty"));
    if (locked && !window.confirm(t("sw3.tb.confirm"))) return;
    setBusy(true);
    const done = await call(base, { action: "swiss_tiebreaks", tiebreaks: draft, ...(locked ? { token: preview?.token ?? "", reason } : {}) });
    setBusy(false);
    if (!done.ok) return setError(String(done.data.error ?? ""));
    setReason("");
    setPreview(null);
  }

  // The table to show: the proposed order's where there is one, else the event's.
  const byId = new Map((s?.standings ?? []).map((l) => [l.entryId, l]));
  const rows = (preview ? preview.after.map((r) => ({ entryId: r.entryId, rank: r.rank, tie: r.tie })) : (s?.standings ?? []).map((l) => ({ entryId: l.entryId, rank: l.rank, tie: l.tie ?? null }))).filter((r) => byId.has(r.entryId));
  const columns = [...draft, ...SWISS_TIEBREAKS.filter((k) => !draft.includes(k))].filter((k) => k !== "head_to_head");
  // Where points are kept doubled and shown halved (chess), the tie-breaks that add up points are shown halved too.
  const halves = tn.rules.scoring.pointsInHalves === true;
  const inPoints = (k: string, v: number | null) => (halves && v !== null && ["buchholz", "median_buchholz", "buchholz_cut1", "sonneborn_berger"].includes(k) ? v / 2 : v);
  const separation = (tie: NonNullable<(typeof rows)[number]["tie"]>) =>
    tie.by === "head_to_head"
      ? t("sw3.tb.sep.h2h", { name: name(tie.above) })
      : tie.by === "seed"
        ? t("sw3.tb.sep.seed", { name: name(tie.above), ahead: show(tie.ahead), behind: show(tie.behind) })
        : t("sw3.tb.sep.by", { name: name(tie.above), tiebreak: sequenceName(tie.by), ahead: show(inPoints(tie.by, tie.ahead)), behind: show(inPoints(tie.by, tie.behind)) });
  const small = "rounded-md border border-slate-300 px-2 py-1 text-xs font-medium hover:border-teal-500 disabled:opacity-40";

  return (
    <details className="rounded-lg border border-slate-200 p-3" open={!locked}>
      <summary className="cursor-pointer font-medium">{t("sw3.tb.title")}</summary>
      <p className="mt-2 text-xs text-slate-500">{t("sw3.tb.note")}</p>
      {locked && <p className="mt-1 text-xs text-slate-500">{t("sw3.tb.locked")}</p>}

      {s && (
        <div className="mt-2 overflow-x-auto">
          <table className="w-full min-w-[30rem] text-xs">
            <thead className="text-slate-500">
              <tr>
                <th scope="col" className="w-8 text-left font-medium">
                  #
                </th>
                <th scope="col" className="text-left font-medium">
                  {t("sw.player")}
                </th>
                <th scope="col" className="w-10 font-medium">
                  {t("sw.pts")}
                </th>
                {columns.map((k) => (
                  <th key={k} scope="col" className={`px-1 font-medium ${draft.includes(k) ? "" : "text-slate-400"}`} title={sequenceName(k)}>
                    {draft.includes(k) ? `${draft.indexOf(k) + 1}. ` : ""}
                    {t(`sw3.tbs.${k}`)}
                  </th>
                ))}
                <th scope="col" className="text-left font-medium">
                  {t("sw3.tb.separated")}
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => {
                const l = byId.get(r.entryId)!;
                return (
                  <tr key={r.entryId} className={`align-top ${l.out ? "text-slate-400" : ""}`}>
                    <td className="py-0.5">{r.rank > 0 ? r.rank : "–"}</td>
                    <td>{name(r.entryId)}</td>
                    <td className="text-center font-medium">{showPoints(l.points, halves)}</td>
                    {columns.map((k) => (
                      <td key={k} className={`px-1 text-center tabular-nums ${draft.includes(k) ? "" : "text-slate-400"}`}>
                        {show(tiebreakValue(l, k, halves))}
                      </td>
                    ))}
                    <td className={r.tie?.by === "seed" ? "text-amber-800" : "text-slate-600"}>
                      {r.tie ? (
                        <>
                          {r.tie.by === "seed" ? <span aria-hidden="true">⚠ </span> : null}
                          {separation(r.tie)}
                        </>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <ManagerOnly may="tournamentRun">
        <div className="mt-3 space-y-2">
          <h4 className="text-xs font-semibold text-slate-600">{t("sw3.tb.seq")}</h4>
          <ol className="space-y-1">
            {draft.map((k, i) => (
              <li key={k} className="flex flex-wrap items-center gap-2 text-xs">
                <span className="w-5 text-slate-500">{i + 1}.</span>
                <span className="min-w-[8rem]">{sequenceName(k)}</span>
                <button type="button" disabled={i === 0} aria-label={t("sw3.tb.up", { name: sequenceName(k) })} onClick={() => move(i, -1)} className={small}>
                  ↑
                </button>
                <button type="button" disabled={i === draft.length - 1} aria-label={t("sw3.tb.down", { name: sequenceName(k) })} onClick={() => move(i, 1)} className={small}>
                  ↓
                </button>
                <button type="button" aria-label={t("sw3.tb.remove", { name: sequenceName(k) })} onClick={() => setDraft(draft.filter((x) => x !== k))} className={small}>
                  ×
                </button>
              </li>
            ))}
          </ol>
          {SWISS_TIEBREAKS.some((k) => !draft.includes(k)) && (
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="text-slate-500">{t("sw3.tb.available")}</span>
              {SWISS_TIEBREAKS.filter((k) => !draft.includes(k)).map((k) => (
                <button key={k} type="button" aria-label={t("sw3.tb.add", { name: sequenceName(k) })} onClick={() => setDraft([...draft, k])} className={small}>
                  + {t(`sw3.tbs.${k}`)}
                </button>
              ))}
            </div>
          )}

          {preview && (
            <div className="rounded-lg border border-teal-200 bg-teal-50 p-3 text-xs" aria-live="polite">
              <p className="font-medium text-teal-900">{t("sw3.tb.preview")}</p>
              {preview.moved.length === 0 ? (
                <p className="mt-1">{t("sw3.tb.nochange")}</p>
              ) : (
                <ul className="mt-1 list-disc pl-4">
                  {preview.moved.map((m) => (
                    <li key={m.entryId}>{t("sw3.tb.moved", { name: name(m.entryId), from: m.from || "–", to: m.to })}</li>
                  ))}
                </ul>
              )}
              {preview.bySeed.length > 0 && <p className="mt-1 text-amber-900">{t("sw3.tb.bySeed", { names: preview.bySeed.map(name).join(", ") })}</p>}
            </div>
          )}

          {locked && changed && (
            <label className="flex flex-col text-xs font-medium text-slate-500">
              {t("sw3.tb.reason")}
              <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={300} className="w-full max-w-md rounded border border-slate-300 px-2 py-1 text-sm font-normal text-slate-900" />
            </label>
          )}
          {error && <p className="text-xs text-red-700">{error}</p>}
          <button
            type="button"
            disabled={busy || !changed || draft.length === 0 || (locked && (reason.trim().length < 3 || !preview))}
            onClick={() => void save()}
            className="rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-40"
          >
            {locked ? t("sw3.tb.change") : t("sw3.tb.save")}
          </button>
        </div>
      </ManagerOnly>
    </details>
  );
}
