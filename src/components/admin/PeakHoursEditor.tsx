"use client";

import { useEffect, useState } from "react";
import type { Holiday } from "@/lib/peak";
import { calendarUntil, MY_STATES } from "@/lib/holiday-calendar";
import { region } from "@/lib/region";
import { todayISO, type PeakRules } from "@/lib/time";
import { clockOf, parseClock } from "@/lib/interval";

type Rules = Omit<PeakRules, "holidays">;

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * When a venue's peak rates apply: the hours on working days and at the
 * weekend, which days are the weekend, and holidays priced like it.
 */
export function PeakHoursEditor({ venueId }: { venueId: number }) {
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
    if (!res.ok) return setError(d.error ?? "Could not save");
    setLoyalty(d.every);
    setNotice(d.every === null ? "Free hours for regulars are off." : `One free hour for every ${d.every} hours played.`);
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
      if (!res.ok) throw new Error(data.error ?? "Could not save");
      return data;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function saveRules() {
    const data = await send("/api/admin/peak-rules", "POST", { venueId, ...rules });
    if (!data) return;
    setRules(data.rules as Rules);
    setNotice("Saved. Prices from now on follow these hours; bookings already made keep theirs.");
  }

  async function saveLastMinute() {
    const data = await send("/api/admin/peak-rules", "POST", {
      venueId,
      lastMinute: lm.on ? { hours: lm.hours, percent: lm.percent, offPeakOnly: lm.offPeakOnly } : { off: true },
    });
    if (!data) return;
    setRules(data.rules as Rules);
    setNotice(lm.on ? "Saved. Customers see the lower price on hours that qualify, and pay it if they book then." : "Last-minute prices are off.");
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
    setNotice(
      data.added === 0
        ? "Nothing to add: every public holiday listed so far is on your list."
        : `Added ${data.added} public holiday${data.added === 1 ? "" : "s"}. Remove any you open as usual.`
    );
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
        aria-label="From"
        value={clockOf(rules[fromKey])}
        onChange={(e) => {
          const m = parseClock(e.target.value);
          if (m !== null) setRules({ ...rules, [fromKey]: m });
        }}
        className={input}
      />
      to
      <input
        type="time"
        step={60}
        aria-label="Until"
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
      <h3 className="font-semibold">When peak rates apply</h3>
      <p className="mt-1 text-xs text-slate-500">
        Each court above has an off-peak and a peak rate; these times decide which one each minute costs, so a booking across the change pays each part at its own rate. The same time twice
        means no peak; 00:00 to 00:00 is all day. Holidays are priced like the weekend.
      </p>
      <div className="mt-3 space-y-2">
        <p>
          <span className="inline-block w-24 text-xs font-medium text-slate-600">Weekdays</span>
          {span("weekdayFrom", "weekdayUntil")}
        </p>
        <p>
          <span className="inline-block w-24 text-xs font-medium text-slate-600">Weekend</span>
          {span("weekendFrom", "weekendUntil")}
        </p>
        <p className="flex flex-wrap items-center gap-1">
          <span className="inline-block w-24 text-xs font-medium text-slate-600">Weekend days</span>
          {DAYS.map((name, d) => {
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
                {name}
              </button>
            );
          })}
        </p>
        <button
          disabled={busy}
          onClick={saveRules}
          className="rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
        >
          Save peak hours
        </button>
      </div>

      <h4 className="mt-4 text-xs font-semibold uppercase tracking-wide text-slate-500">Last-minute prices</h4>
      <p className="mt-1 text-xs text-slate-500">
        Fill hours that would otherwise go empty: an hour still free shortly before it starts costs less, for whoever books
        it then. Bookings already made keep their price, and a booking moved into such an hour does not get the lower one.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={lm.on} onChange={(e) => setLm({ ...lm, on: e.target.checked })} />
          On:
        </label>
        <select aria-label="Discount" value={lm.percent} disabled={!lm.on} onChange={(e) => setLm({ ...lm, percent: Number(e.target.value) })} className={input}>
          {[10, 15, 20, 25, 30, 40, 50].map((p) => (
            <option key={p} value={p}>
              {p}% off
            </option>
          ))}
        </select>
        within
        <select aria-label="Hours before" value={lm.hours} disabled={!lm.on} onChange={(e) => setLm({ ...lm, hours: Number(e.target.value) })} className={input}>
          {[1, 2, 3, 4, 6, 8, 12, 24].map((h) => (
            <option key={h} value={h}>
              {h} hour{h === 1 ? "" : "s"}
            </option>
          ))}
        </select>
        of the start
        <label className="flex items-center gap-1">
          <input type="checkbox" checked={lm.offPeakOnly} disabled={!lm.on} onChange={(e) => setLm({ ...lm, offPeakOnly: e.target.checked })} />
          off-peak hours only
        </label>
        <button disabled={busy} onClick={saveLastMinute} className="rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
          Save
        </button>
      </div>
      {lm.on && !lm.offPeakOnly && (
        <p className="mt-1 text-xs text-amber-700">
          Peak hours too: regulars may learn to wait for the lower price on your busiest evenings.
        </p>
      )}

      <h4 className="mt-4 text-xs font-semibold uppercase tracking-wide text-slate-500">A free hour for regulars</h4>
      <p className="mt-1 text-xs text-slate-500">
        Rather than prices that move with demand, thank the people who keep coming: every so many paid hours somebody
        plays here, the next hour is on you. It goes to them once a day as a one-hour pass (90 days to use it), by email.
        Classes, no-shows and hours paid with a free hour do not count.
      </p>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select
          aria-label="Free hour for regulars"
          value={loyalty ?? ""}
          disabled={busy}
          onChange={(e) => void saveLoyalty(e.target.value === "" ? null : Number(e.target.value))}
          className={input}
        >
          <option value="">Off</option>
          {[5, 8, 10, 12, 15, 20, 30].map((n) => (
            <option key={n} value={n}>
              One free hour every {n} hours played
            </option>
          ))}
        </select>
      </div>

      <h4 className="mt-4 text-xs font-semibold uppercase tracking-wide text-slate-500">Holidays at weekend prices</h4>
      {holidays.length > 0 ? (
        <ul className="mt-1 divide-y divide-slate-100">
          {holidays.map((h) => (
            <li key={h.date} className="flex items-center justify-between gap-2 py-1">
              <span>
                <span className="font-medium">{h.date}</span> · {h.name}
              </span>
              <button disabled={busy} onClick={() => removeDay(h.date)} className="text-xs font-medium text-red-700">
                Remove
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-1 text-xs text-slate-500">None listed. Add public, school or festive holidays as they are announced.</p>
      )}
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <input
          type="date"
          aria-label="Holiday date"
          min={todayISO()}
          value={day.date}
          onChange={(e) => setDay({ ...day, date: e.target.value })}
          className={input}
        />
        <input
          aria-label="Holiday name"
          placeholder="Hari Raya Aidilfitri"
          value={day.name}
          onChange={(e) => setDay({ ...day, name: e.target.value })}
          className={`w-48 ${input}`}
        />
        <button
          disabled={busy || !day.date}
          onClick={addDay}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 disabled:opacity-50"
        >
          Add holiday
        </button>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-slate-600">
        <span>Or fill in the public holidays{region().country === "MY" ? " for" : ""}</span>
        {region().country === "MY" && (
          <select aria-label="State" value={state} onChange={(e) => setState(e.target.value)} className={input}>
            <option value="">every state (national only)</option>
            {MY_STATES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        )}
        <button
          disabled={busy}
          onClick={fill}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700 disabled:opacity-50"
        >
          Fill in
        </button>
        <span className="text-slate-500">As gazetted, to {calendarUntil(region().country)}. Islamic holidays can move a day once announced.</span>
      </div>
      {error && <p className="mt-2 text-xs font-medium text-red-700">{error}</p>}
      {notice && <p className="mt-2 text-xs text-emerald-700">{notice}</p>}
    </section>
  );
}
