"use client";

import { courtSports, sportsOf } from "@/lib/court-activities";
import { ClockField } from "@/components/ClockField";
import { WEEKDAYS, type DayHours } from "@/lib/week-hours";
import { useCallback, useEffect, useMemo, useState } from "react";
import { PLATFORM_POLICY, SETTING_KEYS, type BookingPolicy, type FixedPrice, type PolicySettings } from "@/lib/booking-rules";
import { clockOf, parseClock } from "@/lib/interval";
import { type Court, type Sport } from "@/lib/types";
import { sportLabel } from "@/lib/i18n";
import type { StaffT } from "@/lib/staff-i18n";
import type { StaffText } from "@/lib/staff-text";
import { useStaffT } from "./StaffLanguage";

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
 *
 * Two kinds of time kept around a booking, side by side: the minimum gap
 * (separation), shared with the neighbour's so only the larger counts, and
 * setup and cleaning (operational time), which add up with the neighbour's
 * (docs/architecture/booking-time-model.md#buffers-separation-and-operational-time).
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
  courts: Record<number, BookingPolicy & { summary: string; summaryPhrase?: StaffText }>;
  products: Record<number, Record<string, BookingPolicy & { summary: string; summaryPhrase?: StaffText }>>;
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
  "operationalBefore",
  "operationalAfter",
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
  form.turnover = s.turnover ?? "";
  form.fixedPrices = s.fixedPrices
    ? s.fixedPrices.map((f) => `${f.minutes} = ${f.price}${f.peakPrice !== null ? ` / ${f.peakPrice}` : ""}`).join("\n")
    : "";
  form.weekHours = s.weekHours ? JSON.stringify(s.weekHours) : "";
  form.signOff = s.signOff === true ? "yes" : s.signOff === false ? "no" : "";
  form.certification = s.certification === true ? "yes" : s.certification === false ? "no" : "";
  return form;
}

/** The form as settings to send: blank is null (inherit). Throws on what does not read. */
function fromForm(form: Form, t: StaffT): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of NUMBER_KEYS) out[k] = form[k].trim() === "" ? null : Number(form[k]);
  for (const k of AMOUNT_KEYS) out[k] = form[k].trim() === "" ? null : Number(form[k]);
  out.startTimes =
    form.startTimes.trim() === ""
      ? null
      : form.startTimes.split(/[,\s]+/).filter(Boolean).map((time) => {
          const m = parseClock(time);
          if (m === null) throw new Error(t("pol.notATime", { time }));
          return m;
        });
  out.lengths = form.lengths.trim() === "" ? null : form.lengths.split(/[,\s]+/).filter(Boolean).map(Number);
  out.rateMode = form.rateMode === "" ? null : form.rateMode;
  out.turnover = form.turnover === "" ? null : form.turnover;
  out.fixedPrices =
    form.fixedPrices.trim() === ""
      ? null
      : form.fixedPrices
          .split("\n")
          .filter((l) => l.trim())
          .map((line): FixedPrice => {
            const m = /^\s*(\d+)\s*=\s*([\d.]+)\s*(?:\/\s*([\d.]+))?\s*$/.exec(line);
            if (!m) throw new Error(t("pol.notAPrice", { line }));
            return { minutes: Number(m[1]), price: Number(m[2]), peakPrice: m[3] ? Number(m[3]) : null };
          });
  out.weekHours = form.weekHours.trim() === "" ? null : JSON.parse(form.weekHours);
  out.signOff = form.signOff === "" ? null : form.signOff === "yes";
  out.certification = form.certification === "" ? null : form.certification === "yes";
  return out;
}

export function BookingPolicyEditor({ venueId, courts }: { venueId: number; courts: Court[] }) {
  const t = useStaffT();
  const minutesText = (m: number | null | undefined) => (m === null || m === undefined ? "—" : t("pol.min", { n: m }));
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
    if (value === null || value === undefined) return t("pol.notSet");
    if (key === "startTimes" && Array.isArray(value)) return (value as number[]).map(clockOf).join(", ");
    if (Array.isArray(value)) return value.join(", ");
    return String(value);
  };

  /** A turnover said as the choices are (docs/architecture/booking-time-model.md#shared-facilities-how-they-are-turned-over). */
  const turnoverName = (mode: string) =>
    mode === "facility" ? t("pol.turnoverFacility") : mode === "unit" ? t("pol.turnoverUnit") : t("pol.turnoverPlace");

  async function save(e: React.FormEvent) {
    e.preventDefault();
    if (!form) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const settings = fromForm(form, t);
      const res = await fetch("/api/admin/booking-policies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ venueId, ...level, settings }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(t.err(data, t("pol.couldNotSave")));
      setNotice(t("pol.saved"));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("pol.couldNotSave"));
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
        placeholder={t("pol.inherits", { value: hint(key) })}
        inputMode={NUMBER_KEYS.includes(key as (typeof NUMBER_KEYS)[number]) ? "numeric" : undefined}
        className={input}
      />
      {note && <span className="mt-0.5 block font-normal text-slate-400">{note}</span>}
    </label>
  );

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 text-sm shadow-sm">
      <h3 className="font-semibold">{t("pol.title")}</h3>
      <p className="mt-1 text-xs text-slate-500">{t("pol.intro")}</p>

      <label className="mt-3 block text-xs font-medium text-slate-600">
        {t("pol.appliesTo")}
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
          {levels.business !== null && <option value="business">{t("pol.everyBranch")}</option>}
          <option value="venue">{t("pol.wholeVenue")}</option>
          {sports.map((s) => (
            <option key={s} value={`sport:${s}`}>
              {t("pol.sportHere", { sport: sportLabel(t.customer, s) })}
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
                  {t("pol.sportOnCourt", { sport: sportLabel(t.customer, s), court: c.name })}
                </option>
              ))
          )}
        </select>
      </label>
      {level.level === "court" && now && "summary" in now && <p className="mt-1 text-xs text-slate-500">{t("pol.now", { summary: t.say("summaryPhrase" in now ? (now.summaryPhrase as StaffText | undefined) : null, String(now.summary)) })}</p>}

      <form onSubmit={save} className="mt-3 space-y-3">
        <div className="grid gap-3 sm:grid-cols-3">
          {field("startEvery", t("pol.startEvery"), t("pol.startEveryNote"))}
          {field("minLength", t("pol.minLength"))}
          {field("maxLength", t("pol.maxLength"))}
          {field("lengthStep", t("pol.lengthStep"), t("pol.lengthStepNote"))}
          {field("defaultLength", t("pol.defaultLength"))}
          {field("lengths", t("pol.lengths"), t("pol.lengthsNote"))}
        </div>

        <details className="rounded-lg border border-slate-200 p-3">
          <summary className="cursor-pointer text-xs font-semibold text-slate-700">{t("pol.more")}</summary>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            {field("startOffset", t("pol.startOffset"), t("pol.startOffsetNote"))}
            {field("startTimes", t("pol.startTimes"), t("pol.startTimesNote"))}
            {field("noticeMinutes", t("pol.notice"))}
            {field("bufferBefore", t("pol.bufferBefore"), t("pol.bufferBeforeNote"))}
            {field("bufferAfter", t("pol.bufferAfter"), t("pol.bufferAfterNote"))}
            {field("operationalBefore", t("pol.operationalBefore"), t("pol.operationalBeforeNote"))}
            {field("operationalAfter", t("pol.operationalAfter"), t("pol.operationalAfterNote"))}
            <label className="block text-xs font-medium text-slate-600">
              {t("pol.turnover")}
              <select value={form.turnover} onChange={(e) => setForm({ ...form, turnover: e.target.value })} className={input}>
                <option value="">{t("pol.inheritsTurnover", { mode: turnoverName(hint("turnover")) })}</option>
                <option value="place">{t("pol.turnoverPlace")}</option>
                <option value="unit">{t("pol.turnoverUnit")}</option>
                <option value="facility">{t("pol.turnoverFacility")}</option>
              </select>
              <span className="mt-0.5 block font-normal text-slate-400">{t("pol.turnoverNote")}</span>
            </label>
            <label className="block text-xs font-medium text-slate-600">
              {t("pol.rateMode")}
              <select value={form.rateMode} onChange={(e) => setForm({ ...form, rateMode: e.target.value })} className={input}>
                <option value="">{hint("rateMode") === "start" ? t("pol.inheritsStart") : t("pol.inheritsSplit")}</option>
                <option value="split">{t("pol.rateSplit")}</option>
                <option value="start">{t("pol.rateStart")}</option>
              </select>
            </label>
            {field("billStep", t("pol.billStep"), t("pol.billStepNote"))}
            {field("minBilled", t("pol.minBilled"))}
            {field("minCharge", t("pol.minCharge"))}
            {field("setupFee", t("pol.setupFee"), t("pol.setupFeeNote"))}
            {field("cleanupFee", t("pol.cleanupFee"))}
            <label className="block text-xs font-medium text-slate-600">
              {t("pol.signOff")}
              <select value={form.signOff} onChange={(e) => setForm({ ...form, signOff: e.target.value })} className={input}>
                <option value="">{hint("signOff") === "true" ? t("pol.inheritsNeeded") : t("pol.inheritsNotNeeded")}</option>
                <option value="yes">{t("pol.signOffNeeded")}</option>
                <option value="no">{t("pol.notNeeded")}</option>
              </select>
              <span className="mt-0.5 block font-normal text-slate-400">{t("pol.signOffNote")}</span>
            </label>
            <label className="block text-xs font-medium text-slate-600">
              {t("pol.certification")}
              <select value={form.certification} onChange={(e) => setForm({ ...form, certification: e.target.value })} className={input}>
                <option value="">{hint("certification") === "true" ? t("pol.inheritsNeeded") : t("pol.inheritsNotNeeded")}</option>
                <option value="yes">{t("pol.certificationNeeded")}</option>
                <option value="no">{t("pol.notNeeded")}</option>
              </select>
              <span className="mt-0.5 block font-normal text-slate-400">{t("pol.certificationNote")}</span>
            </label>
          </div>
          {level.level === "court" && (
            <CourtWeekHours value={form.weekHours} onChange={(weekHours) => setForm({ ...form, weekHours })} />
          )}
          <label className="mt-3 block text-xs font-medium text-slate-600">
            {t("pol.fixedPrices")}
            <textarea
              value={form.fixedPrices}
              onChange={(e) => setForm({ ...form, fixedPrices: e.target.value })}
              placeholder={t("pol.fixedPricesExample")}
              rows={3}
              className={input}
            />
            <span className="mt-0.5 block font-normal text-slate-400">{t("pol.fixedPricesNote")}</span>
          </label>
        </details>

        {error && <p className="text-xs font-medium text-red-700">{error}</p>}
        {notice && <p className="text-xs text-emerald-700">{notice}</p>}
        <div className="flex flex-wrap items-center gap-2">
          <button disabled={busy} className="rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-700 disabled:opacity-50">
            {t("pol.saveRules")}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => setForm(toForm({}))}
            className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-600 hover:border-slate-400"
          >
            {t("pol.clear")}
          </button>
          {now && (
            <span className="text-xs text-slate-500">
              {t("pol.buffersNow", {
                before: minutesText(now.bufferBefore),
                after: minutesText(now.bufferAfter),
                setup: minutesText(now.operationalBefore),
                cleaning: minutesText(now.operationalAfter),
              })}
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
  const t = useStaffT();
  const dayNames: Record<(typeof WEEKDAYS)[number], string> = {
    Sunday: t("pol.sunday"),
    Monday: t("pol.monday"),
    Tuesday: t("pol.tuesday"),
    Wednesday: t("pol.wednesday"),
    Thursday: t("pol.thursday"),
    Friday: t("pol.friday"),
    Saturday: t("pol.saturday"),
  };
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
      <legend className="px-1 text-xs font-semibold text-slate-700">{t("pol.courtHours")}</legend>
      <div className="grid gap-1 sm:grid-cols-2">
        {WEEKDAYS.map((key, i) => {
          const d = week[i];
          const name = dayNames[key];
          const mode = d === null ? "venue" : d === "closed" ? "closed" : "own";
          return (
            <div key={key} className="flex flex-wrap items-center gap-1 text-xs">
              <span className="w-20 text-slate-600">{name}</span>
              <select
                aria-label={t("pol.dayHours", { day: name })}
                value={mode}
                onChange={(e) => set(i, e.target.value === "venue" ? null : e.target.value === "closed" ? "closed" : { open: 8 * 60, close: 22 * 60 })}
                className="rounded-md border border-slate-300 px-1 py-0.5"
              >
                <option value="venue">{t("pol.venueHours")}</option>
                <option value="closed">{t("pol.closed")}</option>
                <option value="own">{t("pol.ownHours")}</option>
              </select>
              {d !== null && d !== "closed" && (
                <>
                  <ClockField label={t("pol.dayOpens", { day: name })} value={d.open} onChange={(m) => set(i, { ...d, open: m })} className="rounded-md border border-slate-300 px-1 py-0.5" />
                  <ClockField label={t("pol.dayCloses", { day: name })} value={d.close} after={d.open} onChange={(m) => set(i, { ...d, close: m })} className="rounded-md border border-slate-300 px-1 py-0.5" />
                </>
              )}
            </div>
          );
        })}
      </div>
    </fieldset>
  );
}
