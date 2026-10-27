"use client";

import { useEffect, useState } from "react";
import { useT } from "@/components/Language";
import { translateError } from "@/lib/i18n";
import type { RescheduleOption } from "@/lib/store";
import { addDays, todayISO } from "@/lib/time";
import { formatMinute } from "@/lib/interval";
import type { Booking } from "@/lib/types";
import { MAX_ADVANCE_DAYS } from "@/lib/types";
import { money } from "@/lib/region";
import type { MovePreview } from "@/lib/game-moves";

/**
 * Pick a new day and start time for a booking: only times free for its
 * whole length are offered. The same control for a customer (their own
 * booking, by code and phone), for staff (any booking, any court), and for
 * an open game's host. With `preview`, a chosen time is shown first for what
 * it would do (an open game's players, what is owed back, whether they are
 * asked), and a venue's change of a game with players asks for its reason.
 */
export function ChangeTime({
  booking,
  optionsUrl,
  submit,
  preview,
  staff = false,
  lastDate,
  onDone,
  onClose,
}: {
  booking: Booking;
  optionsUrl: (date: string) => string;
  submit: (option: RescheduleOption, date: string, reason?: string) => Promise<Response>;
  /** What moving there would do, changing nothing (lib/game-moves.ts, previewMove). */
  preview?: (option: RescheduleOption, date: string) => Promise<Response>;
  staff?: boolean;
  /** The last day it may move to: the venue's window for this customer, up to 90 days. */
  lastDate?: string;
  onDone: (booking: Booking, message: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [date, setDate] = useState(booking.date < todayISO() ? todayISO() : booking.date);
  const [options, setOptions] = useState<RescheduleOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The time chosen, and what moving there would do, before anything changes.
  const [checking, setChecking] = useState<{ option: RescheduleOption; preview: MovePreview } | null>(null);
  const [reason, setReason] = useState("");
  const length = booking.endMin - booking.startMin;
  // A customer who has paid may not move to a dearer time; staff may.
  const paidLimit = !staff && booking.paymentStatus === "paid";

  useEffect(() => {
    let live = true;
    setOptions(null);
    setError(null);
    fetch(optionsUrl(date), { cache: "no-store" })
      .then(async (res) => {
        const data = await res.json();
        if (!res.ok) throw new Error(translateError(t, data) || "Could not load times");
        if (live) setOptions(data.options as RescheduleOption[]);
      })
      .catch((err) => live && setError(err instanceof Error ? err.message : "Could not load times"));
    return () => {
      live = false;
    };
  }, [date, optionsUrl, t]);

  const when = (o: RescheduleOption) => `${date}, ${formatMinute(o.startMin, t.locale)}–${formatMinute(o.startMin + length, t.locale)}`;

  async function choose(o: RescheduleOption) {
    if (preview) {
      setBusy(true);
      setError(null);
      try {
        const res = await preview(o, date);
        const data = await res.json();
        if (!res.ok) throw new Error(translateError(t, data) || "Could not change it");
        setChecking({ option: o, preview: data.preview as MovePreview });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Could not change it");
      } finally {
        setBusy(false);
      }
      return;
    }
    if (!window.confirm(t("resched.confirm", { code: booking.code, when: when(o) }))) return;
    await commit(o);
  }

  async function commit(o: RescheduleOption, why?: string) {
    setBusy(true);
    setError(null);
    try {
      const res = await submit(o, date, why);
      const data = await res.json();
      if (!res.ok) throw new Error(translateError(t, data) || "Could not change it");
      setChecking(null);
      onDone((data.booking as Booking | undefined) ?? booking, data.outcome === "proposal" ? t("move.proposed") : t("resched.done", { when: when(o) }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change it");
    } finally {
      setBusy(false);
    }
  }

  const shown = (options ?? []).filter((o) => !paidLimit || o.difference <= 0);
  if (checking) {
    const p = checking.preview;
    const span = (x: { date: string; startMin: number; endMin: number; courtName: string }) =>
      `${x.date}, ${formatMinute(x.startMin, t.locale)}–${formatMinute(x.endMin, t.locale)}, ${x.courtName}`;
    const pendingCount = p.pending.invited + p.pending.requested + p.pending.waitlisted + p.pending.offered;
    const needsReason = p.outcome === "venue";
    return (
      <div className="rounded-xl border border-teal-200 bg-teal-50/60 px-4 py-3" data-testid="move-preview">
        <p className="text-sm font-semibold">{t("move.previewTitle")}</p>
        <p className="mt-1 text-sm">{t("move.fromTo", { from: span(p.from), to: span(p.to) })}</p>
        <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs text-slate-700">
          {p.priceChange > 0 && <li>{t("move.dearer", { amount: money(p.priceChange.toFixed(2)) })}</li>}
          {p.priceChange < 0 && <li>{t("move.cheaper", { amount: money(Math.abs(p.priceChange).toFixed(2)) })}</li>}
          {p.players.length > 0 && <li>{t("move.players", { names: p.players.map((x) => x.name).join(", ") })}</li>}
          {pendingCount > 0 && <li>{t("move.pending", { n: pendingCount })}</li>}
          {p.clashes > 0 && <li>{t("move.clashes", { n: p.clashes })}</li>}
          {p.sharesPaid > 0 && <li>{t("move.shares", { amount: money(p.sharesPaid.toFixed(2)) })}</li>}
          <li>
            {p.outcome === "move"
              ? t("move.now")
              : p.outcome === "proposal"
                ? t("move.propose", {
                    until: p.expiresAt
                      ? new Date(p.expiresAt).toLocaleString([], { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" })
                      : "",
                  })
                : t("move.venue")}
          </li>
        </ul>
        {needsReason && (
          <label className="mt-2 block text-xs font-medium text-slate-700">
            {t("move.reason")}
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              maxLength={300}
              className="mt-1 block w-full rounded-md border border-slate-300 px-2 py-1 text-sm"
              data-testid="move-reason"
            />
          </label>
        )}
        {error && <p className="mt-2 text-xs font-medium text-red-700">{error}</p>}
        <div className="mt-3 flex gap-2">
          <button
            disabled={busy || (needsReason && reason.trim().length < 3)}
            onClick={() => void commit(checking.option, needsReason ? reason.trim() : undefined)}
            className="rounded-lg bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
          >
            {t("move.confirm")}
          </button>
          <button onClick={() => setChecking(null)} className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs font-medium">
            {t("move.back")}
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="rounded-xl border border-teal-200 bg-teal-50/60 px-4 py-3">
      <p className="text-sm font-semibold">{t("resched.title")}</p>
      <p className="mt-0.5 text-xs text-slate-600">{t("resched.intro")}</p>
      {paidLimit && <p className="mt-1 text-xs text-slate-600">{t("resched.paidNote")}</p>}
      <label className="mt-3 block text-xs font-medium text-slate-700">
        {t("resched.day")}{" "}
        <input
          type="date"
          value={date}
          min={todayISO()}
          max={lastDate ?? addDays(todayISO(), MAX_ADVANCE_DAYS)}
          onChange={(e) => e.target.value && setDate(e.target.value)}
          className="ml-1 rounded-md border border-slate-300 px-2 py-1 text-sm"
        />
      </label>
      <div className="mt-3 flex flex-wrap gap-2">
        {options === null && !error && <p className="text-xs text-slate-500">{t("resched.loading")}</p>}
        {options !== null && shown.length === 0 && <p className="text-xs text-slate-600">{t("resched.none")}</p>}
        {shown.map((o) => (
          <button
            key={`${o.startMin}-${o.courtId}`}
            disabled={busy}
            onClick={() => choose(o)}
            className="rounded-lg border border-teal-300 bg-white px-3 py-1.5 text-left text-xs font-semibold text-teal-700 hover:bg-teal-100 disabled:opacity-50"
          >
            {formatMinute(o.startMin, t.locale)}–{formatMinute(o.startMin + length, t.locale)}
            <span className="block font-normal text-slate-500">
              {o.courtId !== booking.courtId || staff ? `${o.courtName} · ` : ""}{money(o.price.toFixed(2))}
              {o.difference !== 0 && ` (${o.difference > 0 ? "+" : "−"}${money(Math.abs(o.difference).toFixed(2))})`}
            </span>
          </button>
        ))}
      </div>
      {error && <p className="mt-2 text-xs font-medium text-red-700">{error}</p>}
      <button onClick={onClose} className="mt-3 text-xs font-medium text-slate-500 hover:text-slate-700">
        {t("resched.close")}
      </button>
    </div>
  );
}
