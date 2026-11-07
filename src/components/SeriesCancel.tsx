"use client";

import { readJson } from "@/lib/read-response";
import { useEffect, useState } from "react";
import { translateError, type T } from "@/lib/i18n";
import { money } from "@/lib/region";
import { formatHour } from "@/lib/time";
import type { SeriesWeek } from "@/lib/store";

/**
 * Cancelling weeks of a weekly series: each upcoming week with what
 * cancelling it would do (all back, the venue's late share kept, or staying
 * booked and why), chosen week by week, totals shown before anything is
 * cancelled. Weeks past the free window go only on the terms shown here.
 */
export function SeriesCancel({
  t,
  seriesCode,
  phone,
  onDone,
  onClose,
}: {
  t: T;
  seriesCode: string;
  phone: string;
  onDone: (data: { cancelled: number; refunds?: { how: string; amount: number; dueBy?: string }[]; left?: SeriesWeek[] }) => void;
  onClose: () => void;
}) {
  const [weeks, setWeeks] = useState<SeriesWeek[] | null>(null);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const post = (body: object) =>
    fetch("/api/bookings/cancel-series", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seriesCode, phone, ...body }),
    });

  useEffect(() => {
    let live = true;
    (async () => {
      const res = await post({ preview: true });
      const data = await readJson(res);
      if (!live) return;
      if (!res.ok) return setError(translateError(t, data) || t("mine.cancelFailed"));
      setWeeks(data.weeks);
      setChosen(new Set((data.weeks as SeriesWeek[]).filter((w) => w.outcome !== "stays").map((w) => w.code)));
    })();
    return () => {
      live = false;
    };
    // Once, for this series.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seriesCode, phone]);

  const picked = (weeks ?? []).filter((w) => chosen.has(w.code));
  const back = picked.reduce((n, w) => n + w.refund, 0);
  const kept = picked.reduce((n, w) => n + w.kept, 0);

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      const res = await post({ codes: picked.map((w) => w.code), acceptLate: picked.filter((w) => w.outcome === "late").map((w) => w.code) });
      const data = await readJson(res);
      if (!res.ok) throw new Error(translateError(t, data) || t("mine.cancelFailed"));
      onDone(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("mine.cancelFailed"));
    } finally {
      setBusy(false);
    }
  }

  const line = (w: SeriesWeek) =>
    w.outcome === "free"
      ? w.refund > 0
        ? t("series.free", { amount: money(w.refund) })
        : t("series.freeNothing")
      : w.outcome === "late"
        ? w.strike
          ? t("series.lateStrike")
          : t("series.late", { pct: w.keptPercent ?? 0, kept: money(w.kept), amount: money(w.refund) })
        : w.reason === "kit"
          ? t("series.staysKit")
          : w.reason === "arrived"
            ? t("series.staysArrived")
            : w.owed > 0
              ? t("series.staysOwed", { amount: money(w.owed) })
              : t("series.stays");

  return (
    <div className="mb-4 rounded-xl border border-red-200 bg-white p-4 shadow-sm" data-testid="series-cancel">
      <h3 className="text-sm font-semibold">{t("series.title", { code: seriesCode })}</h3>
      {!weeks && !error && <p className="mt-2 text-sm text-slate-500">{t("auth.working")}</p>}
      {weeks && (
        <ul className="mt-3 space-y-1.5">
          {weeks.map((w) => (
            <li key={w.code} className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                aria-label={w.date}
                disabled={w.outcome === "stays"}
                checked={chosen.has(w.code)}
                onChange={(e) => {
                  const next = new Set(chosen);
                  if (e.target.checked) next.add(w.code);
                  else next.delete(w.code);
                  setChosen(next);
                }}
              />
              <span>
                <span className="font-medium">
                  {w.date} · {formatHour(w.startHour, t.locale)}–{formatHour(w.endHour, t.locale)}
                </span>{" "}
                <span className={w.outcome === "free" ? "text-slate-600" : w.outcome === "late" ? "text-amber-800" : "text-slate-500"}>
                  {line(w)}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {weeks && (
        <p className="mt-3 text-sm text-slate-700" data-testid="series-total">
          {t("series.total", { n: picked.length, amount: money(back), kept: money(kept) })}
        </p>
      )}
      {error && <p className="mt-2 text-sm font-medium text-red-700">{error}</p>}
      <div className="mt-3 flex gap-2">
        <button
          onClick={() => void confirm()}
          disabled={busy || picked.length === 0}
          className="rounded-lg bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
        >
          {t("series.confirm", { n: picked.length })}
        </button>
        <button onClick={onClose} className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm">
          {t("series.back")}
        </button>
      </div>
    </div>
  );
}
