"use client";

import { useState } from "react";
import { useT } from "@/components/Language";
import { translateError } from "@/lib/i18n";
import { intlTag } from "@/lib/region";
import { todayISO } from "@/lib/time";
import { ClockField } from "@/components/ClockField";

interface Stretch {
  weekday: number;
  from: number;
  until: number;
}

interface TimeOff {
  id: number;
  from: string;
  until: string;
  reason: string | null;
}

const MONDAY_FIRST = [1, 2, 3, 4, 5, 6, 0];

/**
 * A coach's own week and time off, at their private link (lib/coach-schedule.ts):
 * the hours students can book them, and the days they are away.
 */
export default function CoachSelfService({ token, hours: initial, timeOff: initialOff }: { token: string; hours: Stretch[]; timeOff: TimeOff[] }) {
  const t = useT();
  const [hours, setHours] = useState<Stretch[]>(initial);
  const [off, setOff] = useState<TimeOff[]>(initialOff);
  const [form, setForm] = useState({ from: "", until: "", reason: "" });
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const day = (weekday: number) =>
    new Date(Date.UTC(2026, 0, 4 + weekday)).toLocaleDateString(intlTag(t.locale), { weekday: "long", timeZone: "UTC" });

  async function saveHours() {
    setError(null);
    setNotice(null);
    const res = await fetch(`/api/coach/${token}/hours`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ hours }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return setError(translateError(t, data) || data.error);
    setHours(data.coach.hours);
    setNotice(t("coachpage.saved"));
  }

  async function addOff(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    const res = await fetch(`/api/coach/${token}/time-off`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(form),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return setError(translateError(t, data) || data.error);
    setOff(data.timeOff);
    setForm({ from: "", until: "", reason: "" });
    setNotice(data.clashes > 0 ? t.plural("coachpage.offClash", data.clashes) : t("coachpage.saved"));
  }

  async function removeOff(id: number) {
    const res = await fetch(`/api/coach/${token}/time-off?id=${id}`, { method: "DELETE" });
    if (res.ok) setOff(off.filter((o) => o.id !== id));
  }

  const select = "rounded-md border border-slate-300 px-1.5 py-1 text-sm";
  return (
    <div className="space-y-4">
      <section className="rounded-xl border border-slate-200 bg-white p-4 text-sm shadow-sm">
        <h2 className="font-semibold">{t("coachpage.hoursTitle")}</h2>
        <p className="mt-1 text-xs text-slate-600">{t("coachpage.hoursBody")}</p>
        <ul className="mt-3 space-y-1.5">
          {hours
            .map((h, i) => ({ h, i }))
            .sort((a, b) => MONDAY_FIRST.indexOf(a.h.weekday) - MONDAY_FIRST.indexOf(b.h.weekday) || a.h.from - b.h.from)
            .map(({ h, i }) => (
              <li key={i} className="flex flex-wrap items-center gap-1.5">
                <select value={h.weekday} onChange={(e) => setHours(hours.map((x, j) => (j === i ? { ...x, weekday: Number(e.target.value) } : x)))} className={select}>
                  {MONDAY_FIRST.map((d) => (
                    <option key={d} value={d}>
                      {day(d)}
                    </option>
                  ))}
                </select>
                <ClockField label={t("coachpage.from")} value={h.from} onChange={(m) => setHours(hours.map((x, j) => (j === i ? { ...x, from: m } : x)))} className={select} />
                –
                <ClockField
                  label={t("coachpage.until")}
                  value={h.until}
                  after={h.from}
                  onChange={(m) => setHours(hours.map((x, j) => (j === i ? { ...x, until: m } : x)))}
                  className={select}
                />
                <button type="button" onClick={() => setHours(hours.filter((_, j) => j !== i))} className="text-xs text-red-600 underline">
                  {t("coachpage.remove")}
                </button>
              </li>
            ))}
        </ul>
        <div className="mt-3 flex gap-2">
          <button
            type="button"
            onClick={() => setHours([...hours, { weekday: 1, from: 17 * 60, until: 21 * 60 }])}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold"
          >
            + {t("coachpage.addHours")}
          </button>
          <button type="button" onClick={() => void saveHours()} className="rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white">
            {t("coachpage.save")}
          </button>
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4 text-sm shadow-sm">
        <h2 className="font-semibold">{t("coachpage.offTitle")}</h2>
        <p className="mt-1 text-xs text-slate-600">{t("coachpage.offBody")}</p>
        {off.length > 0 && (
          <ul className="mt-2 space-y-1">
            {off.map((o) => (
              <li key={o.id} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{o.from === o.until ? o.from : `${o.from} – ${o.until}`}</span>
                {o.reason && <span className="text-slate-500">{o.reason}</span>}
                <button type="button" onClick={() => void removeOff(o.id)} className="text-xs text-red-600 underline">
                  {t("coachpage.remove")}
                </button>
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={addOff} className="mt-3 flex flex-wrap items-end gap-2">
          <label className="text-xs text-slate-600">
            {t("coachpage.offFrom")}
            <input type="date" required min={todayISO()} value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} className={`mt-1 block ${select}`} />
          </label>
          <label className="text-xs text-slate-600">
            {t("coachpage.offUntil")}
            <input type="date" min={form.from || todayISO()} value={form.until} onChange={(e) => setForm({ ...form, until: e.target.value })} className={`mt-1 block ${select}`} />
          </label>
          <label className="text-xs text-slate-600">
            {t("coachpage.offReason")}
            <input value={form.reason} maxLength={120} onChange={(e) => setForm({ ...form, reason: e.target.value })} className={`mt-1 block w-44 ${select}`} />
          </label>
          <button type="submit" className="rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white">
            {t("coachpage.offAdd")}
          </button>
        </form>
      </section>
      {notice && <p className="text-sm font-medium text-emerald-700">{notice}</p>}
      {error && <p className="text-sm font-medium text-red-700">{error}</p>}
    </div>
  );
}
