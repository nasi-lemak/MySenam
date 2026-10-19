"use client";

import { useEffect, useState } from "react";
import { useT } from "@/components/Language";
import { translateError } from "@/lib/i18n";
import type { RescheduleOption } from "@/lib/store";
import { addDays, formatHour, todayISO } from "@/lib/time";
import type { Booking } from "@/lib/types";
import { MAX_ADVANCE_DAYS } from "@/lib/types";

/**
 * Pick a new day and start time for a booking: only times free for its
 * whole length are offered. The same control for a customer (their own
 * booking, by code and phone) and for staff (any booking, any court).
 */
export function ChangeTime({
  booking,
  optionsUrl,
  submit,
  staff = false,
  onDone,
  onClose,
}: {
  booking: Booking;
  optionsUrl: (date: string) => string;
  submit: (option: RescheduleOption, date: string) => Promise<Response>;
  staff?: boolean;
  onDone: (booking: Booking, message: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  const [date, setDate] = useState(booking.date < todayISO() ? todayISO() : booking.date);
  const [options, setOptions] = useState<RescheduleOption[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const length = booking.endHour - booking.startHour;
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

  const when = (o: RescheduleOption) => `${date}, ${formatHour(o.startHour)}–${formatHour(o.startHour + length)}`;

  async function choose(o: RescheduleOption) {
    if (!window.confirm(t("resched.confirm", { code: booking.code, when: when(o) }))) return;
    setBusy(true);
    setError(null);
    try {
      const res = await submit(o, date);
      const data = await res.json();
      if (!res.ok) throw new Error(translateError(t, data) || "Could not change it");
      onDone(data.booking as Booking, t("resched.done", { when: when(o) }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not change it");
    } finally {
      setBusy(false);
    }
  }

  const shown = (options ?? []).filter((o) => !paidLimit || o.difference <= 0);
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
          max={addDays(todayISO(), MAX_ADVANCE_DAYS)}
          onChange={(e) => e.target.value && setDate(e.target.value)}
          className="ml-1 rounded-md border border-slate-300 px-2 py-1 text-sm"
        />
      </label>
      <div className="mt-3 flex flex-wrap gap-2">
        {options === null && !error && <p className="text-xs text-slate-500">{t("resched.loading")}</p>}
        {options !== null && shown.length === 0 && <p className="text-xs text-slate-600">{t("resched.none")}</p>}
        {shown.map((o) => (
          <button
            key={`${o.startHour}-${o.courtId}`}
            disabled={busy}
            onClick={() => choose(o)}
            className="rounded-lg border border-teal-300 bg-white px-3 py-1.5 text-left text-xs font-semibold text-teal-700 hover:bg-teal-100 disabled:opacity-50"
          >
            {formatHour(o.startHour)}–{formatHour(o.startHour + length)}
            <span className="block font-normal text-slate-500">
              {o.courtId !== booking.courtId || staff ? `${o.courtName} · ` : ""}RM{o.price.toFixed(2)}
              {o.difference !== 0 && ` (${o.difference > 0 ? "+" : "−"}RM${Math.abs(o.difference).toFixed(2)})`}
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
