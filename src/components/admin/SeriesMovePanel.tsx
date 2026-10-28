"use client";

import { useEffect, useState } from "react";
import { readJson } from "@/lib/read-response";
import { money, shortDate } from "@/lib/region";
import { formatMinute } from "@/lib/interval";
import type { SeriesMoveWeek } from "@/lib/series-moves";
import type { StaffPhrase } from "@/lib/staff-i18n";
import { useStaffT } from "./StaffLanguage";

/** Monday first, as the week a series moves within; values as `getUTCDay()` counts. */
const DAYS: [number, StaffPhrase][] = [
  [1, "rep.day.1"],
  [2, "rep.day.2"],
  [3, "rep.day.3"],
  [4, "rep.day.4"],
  [5, "rep.day.5"],
  [6, "rep.day.6"],
  [0, "rep.day.0"],
];

const clock = (min: number) => `${String(Math.floor(min / 60) % 24).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`;

interface Choices {
  weekday: number;
  start: number;
  courtId: number;
  weeks: number;
  courts: { id: number; name: string }[];
}

/**
 * Moving the weeks of a weekly series still to be played in one step
 * (lib/series-moves.ts): a weekday, a start and a court, then each week
 * previewed as the single move would do it (where it goes, what it costs,
 * which cannot move and why), the weeks to move ticked, and moved.
 */
export function SeriesMovePanel({
  seriesCode,
  onDone,
  onClose,
}: {
  seriesCode: string;
  onDone: (notice: string) => void;
  onClose: () => void;
}) {
  const t = useStaffT();
  const [choices, setChoices] = useState<Choices | null>(null);
  const [weekday, setWeekday] = useState<number>(0);
  const [start, setStart] = useState("");
  const [courtId, setCourtId] = useState("");
  const [weeks, setWeeks] = useState<SeriesMoveWeek[] | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    (async () => {
      try {
        const res = await fetch(`/api/admin/bookings/move-series?seriesCode=${encodeURIComponent(seriesCode)}`, { cache: "no-store" });
        const data = await readJson(res);
        if (!res.ok) throw new Error(t.err(data, t("r9e.sm.failed")));
        if (!live) return;
        const c = data as Choices;
        setChoices(c);
        setWeekday(c.weekday);
        setStart(clock(c.start));
      } catch (err) {
        if (live) setError(err instanceof Error ? err.message : t("r9e.sm.failed"));
      }
    })();
    return () => {
      live = false;
    };
  }, [seriesCode, t]);

  const minutes = () => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(start);
    return m ? Number(m[1]) * 60 + Number(m[2]) : null;
  };
  const target = () => ({ seriesCode, start: minutes(), weekday, ...(courtId !== "" ? { courtId: Number(courtId) } : {}) });

  async function check() {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/admin/bookings/move-series", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...target(), preview: true }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(t.err(data, t("r9e.sm.failed")));
      const list = data.weeks as SeriesMoveWeek[];
      setWeeks(list);
      setChosen(list.filter((w) => w.movable).map((w) => w.code));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("r9e.sm.failed"));
    } finally {
      setBusy(false);
    }
  }

  async function move() {
    setError(null);
    setBusy(true);
    try {
      const res = await fetch("/api/admin/bookings/move-series", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...target(), codes: chosen, ...(reason.trim() ? { reason } : {}) }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(t.err(data, t("r9e.sm.failed")));
      const left = data.left as { code: string; error: string; errorCode?: string }[];
      onDone(
        [
          t("r9e.sm.done", { n: data.moved.length }),
          left.length > 0 ? t("r9e.sm.left", { list: left.map((l) => `${l.code} (${t.err({ error: l.error, code: l.errorCode })})`).join(", ") }) : "",
        ]
          .filter(Boolean)
          .join(" ")
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : t("r9e.sm.failed"));
    } finally {
      setBusy(false);
    }
  }

  const at = (w: { date: string; startMin: number; courtName: string | null }) =>
    `${shortDate(w.date, t.locale, true)} ${formatMinute(w.startMin, t.locale)}${w.courtName ? `, ${w.courtName}` : ""}`;
  const game = (weeks ?? []).some((w) => chosen.includes(w.code) && w.outcome === "venue");
  const field = "mt-1 block rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-teal-500 focus:outline-none";

  return (
    <div className="rounded-xl border border-teal-200 bg-teal-50/60 px-4 py-3 text-sm" data-testid="series-move">
      <p className="font-semibold">{t("r9e.sm.title", { series: seriesCode })}</p>
      <p className="mt-0.5 text-xs text-slate-600">{t("r9e.sm.help")}</p>
      {error && <p className="mt-2 text-xs font-medium text-red-700">{error}</p>}
      {choices && (
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <label className="text-xs font-medium text-slate-600">
            {t("r9e.sm.day")}
            <select value={weekday} onChange={(e) => { setWeekday(Number(e.target.value)); setWeeks(null); }} className={field}>
              {DAYS.map(([d, key]) => (
                <option key={d} value={d}>
                  {t(key)}
                </option>
              ))}
            </select>
          </label>
          <label className="text-xs font-medium text-slate-600">
            {t("r9e.sm.start")}
            <input type="time" value={start} onChange={(e) => { setStart(e.target.value); setWeeks(null); }} className={field} />
          </label>
          <label className="text-xs font-medium text-slate-600">
            {t("r9e.sm.court")}
            <select value={courtId} onChange={(e) => { setCourtId(e.target.value); setWeeks(null); }} className={field}>
              <option value="">{t("r9e.sm.anyCourt")}</option>
              {choices.courts.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={busy || minutes() === null}
            onClick={() => void check()}
            className="rounded-lg border border-teal-300 bg-white px-3 py-1.5 text-xs font-semibold text-teal-700 hover:bg-teal-100 disabled:opacity-50"
          >
            {t("r9e.sm.check")}
          </button>
        </div>
      )}
      {weeks && weeks.length === 0 && <p className="mt-2 text-slate-600">{t("r9e.sm.none")}</p>}
      {weeks && weeks.length > 0 && (
        <ul className="mt-3 space-y-1 text-xs">
          {weeks.map((w) => (
            <li key={w.code}>
              <label className="inline-flex flex-wrap items-center gap-2">
                <input
                  type="checkbox"
                  disabled={!w.movable}
                  checked={chosen.includes(w.code)}
                  onChange={(e) => setChosen(e.target.checked ? [...chosen, w.code] : chosen.filter((c) => c !== w.code))}
                />
                <span className="font-mono">{w.code}</span>
                <span>{t("r9e.sm.week", { from: at(w.from), to: at(w.to) })}</span>
                <span className={w.movable ? "text-slate-500" : "font-medium text-amber-800"}>
                  {w.movable
                    ? [
                        w.priceChange !== 0 ? t("r9e.sm.price", { change: `${w.priceChange > 0 ? "+" : "−"}${money(Math.abs(w.priceChange))}` }) : "",
                        w.unchargedDifference > 0 ? t("r9e.sm.uncharged", { amount: money(w.unchargedDifference) }) : "",
                        w.outcome === "venue" ? t("r9e.sm.game") : "",
                      ]
                        .filter(Boolean)
                        .join(" · ")
                    : t("r9e.sm.cannot", { why: t.err({ error: w.refusal?.error, code: w.refusal?.code, vars: w.refusal?.vars }) })}
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
      {game && (
        <label className="mt-2 block text-xs font-medium text-slate-600">
          {t("r9e.sm.reason")}
          <input type="text" value={reason} onChange={(e) => setReason(e.target.value)} className={`${field} w-80`} />
        </label>
      )}
      <div className="mt-3 flex gap-2">
        {weeks && chosen.length > 0 && (
          <button type="button" disabled={busy} onClick={() => void move()} className="rounded-lg bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-700 disabled:opacity-50">
            {t.plural("r9e.sm.submit", chosen.length)}
          </button>
        )}
        <button type="button" onClick={onClose} className="rounded-lg px-3 py-1.5 text-xs font-medium text-slate-500 hover:text-slate-700">
          {t("c.cancel")}
        </button>
      </div>
    </div>
  );
}
