"use client";

import { useEffect, useState } from "react";
import type { Holiday } from "@/lib/peak";
import { calendarUntil, MY_STATES } from "@/lib/holiday-calendar";
import { region } from "@/lib/region";
import { todayISO, type PeakRules } from "@/lib/time";
import { clockOf, parseClock } from "@/lib/interval";
import { useStaffT } from "./StaffLanguage";
import { withMarks } from "./ResourcesEditor";

type Rules = Omit<PeakRules, "holidays">;

const DAYS = [0, 1, 2, 3, 4, 5, 6] as const;

/**
 * When a venue's peak rates apply: the hours on working days and at the
 * weekend, which days are the weekend, and holidays priced like it.
 */
export function PeakHoursEditor({ venueId }: { venueId: number }) {
  const t = useStaffT();
  const [rules, setRules] = useState<Rules | null>(null);
  const [holidays, setHolidays] = useState<Holiday[]>([]);
  const [day, setDay] = useState({ date: "", name: "" });
  // Which state's own holidays to fill in, in Malaysia; "" for those every state keeps.
  const [state, setState] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lm, setLm] = useState({ on: false, hours: 3, percent: 20, offPeakOnly: true });
  // A free hour every so many paid hours played (lib/loyalty.ts): null is off.
  const [loyalty, setLoyalty] = useState<number | null>(null);

  useEffect(() => {
    void fetch(`/api/admin/loyalty?venueId=${venueId}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { every: number | null } | null) => setLoyalty(d?.every ?? null));
  }, [venueId]);

  async function saveLoyalty(every: number | null) {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/admin/loyalty", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ venueId, every }),
    });
    const d = await res.json().catch(() => ({}));
    setBusy(false);
    if (!res.ok) return setError(t.err(d));
    setLoyalty(d.every);
    setNotice(d.every === null ? t("pk.loyaltyOff") : t("pk.loyaltyOn", { n: d.every }));
  }

  useEffect(() => {
    setRules(null);
    void fetch(`/api/admin/peak-rules?venueId=${venueId}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { rules?: Rules; holidays?: Holiday[] }) => {
        if (!d.rules) return;
        setRules(d.rules);
        const l = d.rules.lastMinute;
        setLm(l ? { on: true, hours: l.hours, percent: l.percent, offPeakOnly: l.offPeakOnly } : { on: false, hours: 3, percent: 20, offPeakOnly: true });
        setHolidays(d.holidays ?? []);
      });
  }, [venueId]);

  async function send(url: string, method: string, body?: unknown): Promise<Record<string, unknown> | null> {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(url, {
        method,
        headers: body ? { "Content-Type": "application/json" } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });
      const data = await res.json();
      if (!res.ok) throw new Error(t.err(data));
      return data;
    } catch (err) {
      setError(err instanceof Error ? err.message : t("c.failed"));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function saveRules() {
    const data = await send("/api/admin/peak-rules", "POST", { venueId, ...rules });
    if (!data) return;
    setRules(data.rules as Rules);
    setNotice(t("pk.savedRules"));
  }

  async function saveLastMinute() {
    const data = await send("/api/admin/peak-rules", "POST", {
      venueId,
      lastMinute: lm.on ? { hours: lm.hours, percent: lm.percent, offPeakOnly: lm.offPeakOnly } : { off: true },
    });
    if (!data) return;
    setRules(data.rules as Rules);
    setNotice(lm.on ? t("pk.savedLastMinute") : t("pk.lastMinuteOff"));
  }

  async function addDay() {
    const data = await send("/api/admin/holidays", "POST", { venueId, ...day });
    if (!data) return;
    setHolidays(data.holidays as Holiday[]);
    setDay({ date: "", name: "" });
  }

  async function fill() {
    const data = await send("/api/admin/holidays", "POST", { venueId, fill: true, state });
    if (!data) return;
    setHolidays(data.holidays as Holiday[]);
    setNotice(data.added === 0 ? t("pk.nothingToAdd") : t.plural("pk.added", Number(data.added)));
  }

  async function removeDay(date: string) {
    const data = await send(`/api/admin/holidays?venueId=${venueId}&date=${date}`, "DELETE");
    if (data) setHolidays(data.holidays as Holiday[]);
  }

  if (!rules) return null;
  const input = "rounded-md border border-slate-300 px-2 py-1 text-sm";
  // Any minute: peak from 17:45, to midnight or past it (an end at or before the start runs into the next morning).
  const span = (fromKey: "weekdayFrom" | "weekendFrom", untilKey: "weekdayUntil" | "weekendUntil") => (
    <span className="inline-flex items-center gap-1">
      <input
        type="time"
        step={60}
        aria-label={t("c.from")}
        value={clockOf(rules[fromKey])}
        onChange={(e) => {
          const m = parseClock(e.target.value);
          if (m !== null) setRules({ ...rules, [fromKey]: m });
        }}
        className={input}
      />
      {t("pk.to")}
      <input
        type="time"
        step={60}
        aria-label={t("c.until")}
        value={clockOf(rules[untilKey])}
        onChange={(e) => {
          const m = parseClock(e.target.value);
          if (m === null) return;
          // The same time as the start is no peak; earlier is the next morning (00:00 is midnight).
          setRules({ ...rules, [untilKey]: m < rules[fromKey] ? m + 1440 : m });
        }}
        className={input}
      />
    </span>
  );

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 text-sm shadow-sm">
      <h3 className="font-semibold">{t("pk.title")}</h3>
      <p className="mt-1 text-xs text-slate-500">{t("pk.intro")}</p>
      <div className="mt-3 space-y-2">
        <p>
          <span className="inline-block w-24 text-xs font-medium text-slate-600">{t("pk.weekdays")}</span>
          {span("weekdayFrom", "weekdayUntil")}
        </p>
        <p>
          <span className="inline-block w-24 text-xs font-medium text-slate-600">{t("pk.weekend")}</span>
          {span("weekendFrom", "weekendUntil")}
        </p>
        <p className="flex flex-wrap items-center gap-1">
          <span className="inline-block w-24 text-xs font-medium text-slate-600">{t("pk.weekendDays")}</span>
          {DAYS.map((d) => {
            const on = rules.weekendDays.includes(d);
            return (
              <button
                key={d}
                type="button"
                aria-pressed={on}
                onClick={() =>
                  setRules({ ...rules, weekendDays: on ? rules.weekendDays.filter((x) => x !== d) : [...rules.weekendDays, d] })
                }
                className={`rounded-md border px-2 py-1 text-xs font-medium ${
                  on ? "border-teal-600 bg-teal-50 text-teal-800" : "border-slate-300 text-slate-600"
                }`}
              >
                {t(`pk.day.${d}`)}
              </button>
            );
          })}
        </p>
        <button
          disabled={busy}
          onClick={saveRules}
          className="rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
        >
          {t("pk.savePeak")}
        </button>
      </div>

      <h4 className="mt-4 text-xs font-semibold uppercase tracking-wide text-slate-500">{t("pk.lastMinuteTitle")}</h4>
      <p className="mt-1 text-xs text-slate-500">{t("pk.lastMinuteIntro")}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={lm.on} onChange={(e) => setLm({ ...lm, on: e.target.checked })} />
          {t("pk.onLabel")}
        </label>
        {withMarks(t("pk.lastMinuteRule"), {
          discount: (
            <select aria-label={t("pk.discount")} value={lm.percent} disabled={!lm.on} onChange={(e) => setLm({ ...lm, percent: Number(e.target.value) })} className={input}>
              {[10, 15, 20, 25, 30, 40, 50].map((p) => (
                <option key={p} value={p}>
                  {t("pk.percentOff", { p })}
                </option>
              ))}
            </select>
          ),
          hours: (
            <select aria-label={t("pk.hoursBefore")} value={lm.hours} disabled={!lm.on} onChange={(e) => setLm({ ...lm, hours: Number(e.target.value) })} className={input}>
              {[1, 2, 3, 4, 6, 8, 12, 24].map((h) => (
                <option key={h} value={h}>
                  {t.plural("c.hours", h)}
                </option>
              ))}
            </select>
          ),
        })}
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={lm.offPeakOnly} disabled={!lm.on} onChange={(e) => setLm({ ...lm, offPeakOnly: e.target.checked })} />
          {t("pk.offPeakOnly")}
        </label>
        <button disabled={busy} onClick={saveLastMinute} className="rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
          {t("c.save")}
        </button>
      </div>
      {lm.on && !lm.offPeakOnly && (
        <p className="mt-1 text-xs text-amber-700">
          {t("pk.peakWarning")}
        </p>
      )}

      <h4 className="mt-4 text-xs font-semibold uppercase tracking-wide text-slate-500">{t("pk.loyaltyTitle")}</h4>
      <p className="mt-1 text-xs text-slate-500">{t("pk.loyaltyIntro")}</p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select
          aria-label={t("pk.loyaltyAria")}
          value={loyalty ?? ""}
          disabled={busy}
          onChange={(e) => void saveLoyalty(e.target.value === "" ? null : Number(e.target.value))}
          className={input}
        >
          <option value="">{t("pk.loyaltyOffOption")}</option>
          {[5, 8, 10, 12, 15, 20, 30].map((n) => (
            <option key={n} value={n}>
              {t("pk.loyaltyEvery", { n })}
            </option>
          ))}
        </select>
      </div>

      <h4 className="mt-4 text-xs font-semibold uppercase tracking-wide text-slate-500">{t("pk.holidaysTitle")}</h4>
      {holidays.length > 0 ? (
        <ul className="mt-1 divide-y divide-slate-100">
          {holidays.map((h) => (
            <li key={h.date} className="flex items-center justify-between gap-2 py-1">
              <span>
                <span className="font-medium">{h.date}</span> · {h.name}
              </span>
              <button disabled={busy} onClick={() => removeDay(h.date)} className="text-xs font-medium text-red-700">
                {t("c.remove")}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-xs text-slate-500">{t("pk.noHolidays")}</p>
      )}
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <input
          type="date"
          aria-label={t("pk.holidayDate")}
          min={todayISO()}
          value={day.date}
          onChange={(e) => setDay({ ...day, date: e.target.value })}
          className={input}
        />
        <input
          aria-label={t("pk.holidayName")}
          placeholder={t("pk.holidayExample")}
          value={day.name}
          onChange={(e) => setDay({ ...day, name: e.target.value })}
          className={`w-48 ${input}`}
        />
        <button
          disabled={busy || !day.date}
          onClick={addDay}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 disabled:opacity-50"
        >
          {t("pk.addHoliday")}
        </button>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-600">
        {region().country === "MY" ? (
          withMarks(t("pk.fillForState"), {
            state: (
              <select aria-label={t("pk.state")} value={state} onChange={(e) => setState(e.target.value)} className={input}>
                <option value="">{t("pk.everyState")}</option>
                {MY_STATES.map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            ),
          })
        ) : (
          <span>{t("pk.fill")}</span>
        )}
        <button
          disabled={busy}
          onClick={fill}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 disabled:opacity-50"
        >
          {t("pk.fillIn")}
        </button>
        <span className="text-slate-500">{t("pk.gazetted", { until: calendarUntil(region().country) })}</span>
      </div>
      {error && <p className="mt-2 text-xs font-medium text-red-700">{error}</p>}
      {notice && <p className="mt-2 text-xs text-emerald-700">{notice}</p>}
    </section>
  );
}
