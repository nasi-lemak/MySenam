"use client";

import { courtSports, sportsOf } from "@/lib/court-activities";
import { ClockField } from "@/components/ClockField";
import { WEEKDAYS, type DayHours } from "@/lib/week-hours";
import { activityName } from "@/lib/activity-registry";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PLATFORM_POLICY, SETTING_KEYS, type BookingPolicy, type FixedPrice, type PolicySettings } from "@/lib/booking-rules";
import { clockOf, parseClock } from "@/lib/interval";
import { type Court, type Sport } from "@/lib/types";

/**
 * A venue's booking rules (lib/booking-policy.ts): when bookings may start,
 * how long they run, what is kept free around them, how soon before they
 * may be made, and how their time is priced. Set for the whole venue, a
 * sport, or one court, or for every branch of a business; anything left
 * blank is inherited from the level above, down from the platform's own
 * (on the hour, an hour to four, priced to the minute).
 *
 * The usual settings show; the rest (buffers, notice, pricing rules) are
 * behind "More". Bookings already made keep their time and price.
 */

type Level =
  | { level: "business" }
  | { level: "venue" }
  | { level: "sport"; sport: Sport }
  | { level: "court"; courtId: number }
  // One activity on one court that offers several: a booking product.
  | { level: "court"; courtId: number; sport: Sport };

interface Levels {
  venue: PolicySettings;
  business: PolicySettings | null;
  sports: Partial<Record<Sport, PolicySettings>>;
  courts: Record<number, PolicySettings>;
  products: Record<number, Record<string, PolicySettings>>;
}

interface Effective {
  sports: Partial<Record<Sport, BookingPolicy>>;
  courts: Record<number, BookingPolicy & { summary: string }>;
  products: Record<number, Record<string, BookingPolicy & { summary: string }>>;
}

/** Each setting as typed in the form; blank inherits. */
type Form = Record<(typeof SETTING_KEYS)[number], string>;

const NUMBER_KEYS = [
  "startEvery",
  "startOffset",
  "lengthStep",
  "minLength",
  "maxLength",
  "defaultLength",
  "bufferBefore",
  "bufferAfter",
  "noticeMinutes",
  "billStep",
  "minBilled",
] as const;
const AMOUNT_KEYS = ["minCharge", "setupFee", "cleanupFee"] as const;

function toForm(s: PolicySettings): Form {
  const form = Object.fromEntries(SETTING_KEYS.map((k) => [k, ""])) as Form;
  for (const k of NUMBER_KEYS) form[k] = s[k] === null || s[k] === undefined ? "" : String(s[k]);
  for (const k of AMOUNT_KEYS) form[k] = s[k] === null || s[k] === undefined ? "" : String(s[k]);
  form.startTimes = s.startTimes ? s.startTimes.map(clockOf).join(", ") : "";
  form.lengths = s.lengths ? s.lengths.join(", ") : "";
  form.rateMode = s.rateMode ?? "";
  form.fixedPrices = s.fixedPrices
    ? s.fixedPrices.map((f) => `${f.minutes} = ${f.price}${f.peakPrice !== null ? ` / ${f.peakPrice}` : ""}`).join("\n")
    : "";
  form.weekHours = s.weekHours ? JSON.stringify(s.weekHours) : "";
  form.signOff = s.signOff === true ? "yes" : s.signOff === false ? "no" : "";
  return form;
}

/** The form as settings to send: blank is null (inherit). Throws on what does not read. */
function fromForm(form: Form): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of NUMBER_KEYS) out[k] = form[k].trim() === "" ? null : Number(form[k]);
  for (const k of AMOUNT_KEYS) out[k] = form[k].trim() === "" ? null : Number(form[k]);
  out.startTimes =
    form.startTimes.trim() === ""
      ? null
      : form.startTimes.split(/[,\s]+/).filter(Boolean).map((t) => {
          const m = parseClock(t);
          if (m === null) throw new Error(`"${t}" is not a time (use 18:00).`);
          return m;
        });
  out.lengths = form.lengths.trim() === "" ? null : form.lengths.split(/[,\s]+/).filter(Boolean).map(Number);
  out.rateMode = form.rateMode === "" ? null : form.rateMode;
  out.fixedPrices =
    form.fixedPrices.trim() === ""
      ? null
      : form.fixedPrices
          .split("\n")
          .filter((l) => l.trim())
          .map((line): FixedPrice => {
            const m = /^\s*(\d+)\s*=\s*([\d.]+)\s*(?:\/\s*([\d.]+))?\s*$/.exec(line);
            if (!m) throw new Error(`"${line}" is not "minutes = price" (or "minutes = price / peak price").`);
            return { minutes: Number(m[1]), price: Number(m[2]), peakPrice: m[3] ? Number(m[3]) : null };
          });
  out.weekHours = form.weekHours.trim() === "" ? null : JSON.parse(form.weekHours);
  out.signOff = form.signOff === "" ? null : form.signOff === "yes";
  return out;
}

const minutesText = (m: number | null | undefined) => (m === null || m === undefined ? "—" : `${m} min`);

export function BookingPolicyEditor({ venueId, courts }: { venueId: number; courts: Court[] }) {
  const [levels, setLevels] = useState<Levels | null>(null);
  const [effective, setEffective] = useState<Effective | null>(null);
  const [level, setLevel] = useState<Level>({ level: "venue" });
  const [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const sports = useMemo(() => sportsOf(courts), [courts]);

  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/booking-policies?venueId=${venueId}`, { cache: "no-store" });
    const data = await res.json();
    if (res.ok) {
      setLevels(data.levels);
      setEffective(data.effective);
    }
  }, [venueId]);

  useEffect(() => {
    void load();
  }, [load]);

  const own: PolicySettings | null = useMemo(() => {
    if (!levels) return null;
    if (level.level === "business") return levels.business ?? {};
    if (level.level === "venue") return levels.venue;
    if (level.level === "sport") return levels.sports[level.sport] ?? {};
    if ("sport" in level) return levels.products[level.courtId]?.[level.sport] ?? {};
    return levels.courts[level.courtId] ?? {};
  }, [levels, level]);

  useEffect(() => {
    if (own) setForm(toForm(own));
    setError(null);
    setNotice(null);
  }, [own]);

  /** What applies now at this level, everything inherited: the placeholders. */
  const now = useMemo(() => {
    if (!effective) return null;
    if (level.level === "court" && "sport" in level) return effective.products[level.courtId]?.[level.sport] ?? null;
    if (level.level === "court") return effective.courts[level.courtId] ?? null;
    if (level.level === "sport") return effective.sports[level.sport] ?? null;
    return null;
  }, [effective, level]);

  const hint = (key: (typeof SETTING_KEYS)[number]): string => {
    const value = now
      ? key in now
        ? (now as unknown as Record<string, unknown>)[key]
        : (now.pricing as unknown as Record<string, unknown>)[key]
      : (PLATFORM_POLICY as Record<string, unknown>)[key];
    if (value === null || value === undefined) return "not set";
    if (key === "startTimes" && Array.isArray(value)) return (value as number[]).map(clockOf).join(", ");
    if (Array.isArray(value)) return value.join(", ");
    return String(value);
  };

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const settings = fromForm(form);
      const res = await fetch("/api/admin/booking-policies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ venueId, ...level, settings }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not save");
      setNotice("Saved. New bookings follow it; bookings already made keep their time and price.");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  if (!levels || !form) return null;

  const levelKey =
    level.level === "sport"
      ? `sport:${level.sport}`
      : level.level === "court"
        ? "sport" in level
          ? `product:${level.courtId}:${level.sport}`
          : `court:${level.courtId}`
        : level.level;
  const input = "mt-1 w-full rounded-md border border-slate-300 px-2 py-1 text-sm placeholder:text-slate-400";
  const field = (key: (typeof SETTING_KEYS)[number], label: string, note?: string) => (
    <label className="block text-xs font-medium text-slate-600">
      {label}
      <input
        value={form[key]}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
        placeholder={`inherits: ${hint(key)}`}
        inputMode={NUMBER_KEYS.includes(key as (typeof NUMBER_KEYS)[number]) ? "numeric" : undefined}
        className={input}
      />
      {note && <span className="mt-0.5 block font-normal text-slate-400">{note}</span>}
    </label>
  );

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 text-sm shadow-sm">
      <h3 className="font-semibold">Booking rules</h3>
      <p className="mt-1 text-xs text-slate-500">
        When bookings may start and how long they run, in minutes. Set them for the whole venue, a sport, or one court; a blank
        box takes the level above (a court from its sport here, that from the venue). Customers book within them; a manager may
        book outside them from the booking page, and it is recorded. Nothing can be booked over another booking, a block or a
        buffer.
      </p>

      <label className="mt-3 block text-xs font-medium text-slate-600">
        Applies to
        <select
          value={levelKey}
          onChange={(e) => {
            const v = e.target.value;
            if (v === "venue" || v === "business") setLevel({ level: v });
            else if (v.startsWith("sport:")) setLevel({ level: "sport", sport: v.slice(6) as Sport });
            else if (v.startsWith("product:")) {
              const [, id, sport] = v.split(":");
              setLevel({ level: "court", courtId: Number(id), sport });
            } else setLevel({ level: "court", courtId: Number(v.slice(6)) });
          }}
          className="mt-1 rounded-md border border-slate-300 px-2 py-1 text-sm"
        >
          {levels.business !== null && <option value="business">Every branch of the business</option>}
          <option value="venue">The whole venue</option>
          {sports.map((s) => (
            <option key={s} value={`sport:${s}`}>
              {activityName(s) ?? s} here
            </option>
          ))}
          {courts.map((c) => (
            <option key={c.id} value={`court:${c.id}`}>
              {c.name}
            </option>
          ))}
          {courts.flatMap((c) =>
            courtSports(c)
              .slice(1)
              .map((s) => (
                <option key={`${c.id}:${s}`} value={`product:${c.id}:${s}`}>
                  {activityName(s)} on {c.name}
                </option>
              ))
          )}
        </select>
      </label>
      {level.level === "court" && now && "summary" in now && <p className="mt-1 text-xs text-slate-500">Now: {String(now.summary)}.</p>}

      <form onSubmit={save} className="mt-3 space-y-3">
        <div className="grid gap-3 sm:grid-cols-3">
          {field("startEvery", "Starts every (minutes)", "60 is on the hour; 15 or 5 for finer starts.")}
          {field("minLength", "Shortest booking (minutes)")}
          {field("maxLength", "Longest booking (minutes)")}
          {field("lengthStep", "Lengths go up by (minutes)", "75 minutes needs 15 or 5.")}
          {field("defaultLength", "Length offered first (minutes)")}
          {field("lengths", "Or only these lengths (minutes)", "e.g. 60, 75, 90 — in place of the steps.")}
        </div>

        <details className="rounded-lg border border-slate-200 p-3">
          <summary className="cursor-pointer text-xs font-semibold text-slate-700">More: start times, buffers, notice, pricing</summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            {field("startOffset", "First start past the hour (minutes)", "15 makes starts :15 past.")}
            {field("startTimes", "Or only at these times", "e.g. 18:00, 19:30, 21:00.")}
            {field("noticeMinutes", "Book at least this far ahead (minutes)")}
            {field("bufferBefore", "Kept free before each booking (minutes)", "Setup. Customers cannot book it and are not charged.")}
            {field("bufferAfter", "Kept free after each booking (minutes)", "Cleaning, changeover.")}
            <label className="block text-xs font-medium text-slate-600">
              Peak and off-peak in one booking
              <select value={form.rateMode} onChange={(e) => setForm({ ...form, rateMode: e.target.value })} className={input}>
                <option value="">inherits: {hint("rateMode") === "start" ? "rate when it starts" : "each part at its own rate"}</option>
                <option value="split">Each part at its own rate</option>
                <option value="start">All at the rate when it starts</option>
              </select>
            </label>
            {field("billStep", "Charge by steps of (minutes)", "Blank: exactly the minutes booked.")}
            {field("minBilled", "Charge at least (minutes)")}
            {field("minCharge", "Charge at least (amount)")}
            {field("setupFee", "Setup fee (amount)", "Shown apart from the time, on every booking.")}
            {field("cleanupFee", "Cleanup fee (amount)")}
            <label className="block text-xs font-medium text-slate-600">
              Staff sign-off first
              <select value={form.signOff} onChange={(e) => setForm({ ...form, signOff: e.target.value })} className={input}>
                <option value="">inherits: {hint("signOff") === "true" ? "needed" : "not needed"}</option>
                <option value="yes">Needed: customers book only once signed off</option>
                <option value="no">Not needed</option>
              </select>
              <span className="mt-0.5 block font-normal text-slate-400">A belay check, a range briefing: record it under Staff sign-offs.</span>
            </label>
          </div>
          {level.level === "court" && (
            <CourtWeekHours value={form.weekHours} onChange={(weekHours) => setForm({ ...form, weekHours })} />
          )}
          <label className="mt-3 block text-xs font-medium text-slate-600">
            Prices for set lengths
            <textarea
              value={form.fixedPrices}
              onChange={(e) => setForm({ ...form, fixedPrices: e.target.value })}
              placeholder={"90 = 120\n120 = 150 / 180   (minutes = price / peak price)"}
              rows={3}
              className={input}
            />
            <span className="mt-0.5 block font-normal text-slate-400">
              A booking of that length costs that, whatever the hour; other lengths are priced by the minute.
            </span>
          </label>
        </details>

        {error && <p className="text-xs font-medium text-red-700">{error}</p>}
        {notice && <p className="text-xs text-emerald-700">{notice}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <button disabled={busy} className="rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-700 disabled:opacity-50">
            Save rules
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setForm(toForm({}))}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:border-slate-400"
          >
            Clear (inherit everything)
          </button>
          {now && (
            <span className="text-xs text-slate-500">
              Buffers now: {minutesText(now.bufferBefore)} before, {minutesText(now.bufferAfter)} after
            </span>
          )}
        </div>
      </form>
    </section>
  );
}

/**
 * A court's own hours, weekday by weekday, inside the venue's: the venue's
 * hours, closed, or its own (a floodlit pitch until 22:00, a pool's lanes
 * from 06:30). All "the venue's" stores nothing.
 */
function CourtWeekHours({ value, onChange }: { value: string; onChange: (json: string) => void }) {
  let week: DayHours[] = Array(7).fill(null);
  try {
    const parsed = value.trim() === "" ? null : (JSON.parse(value) as DayHours[]);
    if (Array.isArray(parsed) && parsed.length === 7) week = parsed;
  } catch {
    // Unreadable: start from the venue's hours.
  }
  const set = (i: number, d: DayHours) => {
    const next = week.map((x, j) => (j === i ? d : x));
    onChange(next.every((x) => x === null) ? "" : JSON.stringify(next));
  };
  return (
    <fieldset className="mt-3 rounded-lg border border-slate-200 p-2">
      <legend className="px-1 text-xs font-semibold text-slate-700">This court&apos;s own hours</legend>
      <div className="grid gap-1 sm:grid-cols-2">
        {WEEKDAYS.map((name, i) => {
          const d = week[i];
          const mode = d === null ? "venue" : d === "closed" ? "closed" : "own";
          return (
            <div key={name} className="flex flex-wrap items-center gap-1 text-xs">
              <span className="w-20 text-slate-600">{name}</span>
              <select
                aria-label={`${name} hours`}
                value={mode}
                onChange={(e) => set(i, e.target.value === "venue" ? null : e.target.value === "closed" ? "closed" : { open: 8 * 60, close: 22 * 60 })}
                className="rounded-md border border-slate-300 px-1 py-0.5"
              >
                <option value="venue">The venue&apos;s</option>
                <option value="closed">Closed</option>
                <option value="own">Its own</option>
              </select>
              {d !== null && d !== "closed" && (
                <>
                  <ClockField label={`${name} opens`} value={d.open} onChange={(m) => set(i, { ...d, open: m })} className="rounded-md border border-slate-300 px-1 py-0.5" />
                  <ClockField label={`${name} closes`} value={d.close} after={d.open} onChange={(m) => set(i, { ...d, close: m })} className="rounded-md border border-slate-300 px-1 py-0.5" />
                </>
              )}
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}
