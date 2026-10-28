"use client";

import { useCallback, useEffect, useState } from "react";
import { readJson } from "@/lib/read-response";
import { formatMinute } from "@/lib/interval";
import { sportLabel } from "@/lib/i18n";
import type { Court, CourtHoursChange, CourtRateChange } from "@/lib/types";
import type { DayHours, HoursChange, WeekHours } from "@/lib/week-hours";
import { ClockField } from "@/components/ClockField";
import { CourtWeekHours } from "./BookingPolicyEditor";
import { useStaffT } from "./StaffLanguage";
import { todayLocal } from "./shared";

/**
 * Opening hours, and a court's rates and own hours, from a later date (ADR
 * 0027): set now, applied by the date booked, listed while they wait, changed
 * or withdrawn until their date comes. Saving the venue's hours or the rates
 * table as before changes them from today.
 */

interface Stranded {
  code: string;
  date: string;
  startMin: number;
  endMin: number;
  court: string;
}

const input = "rounded-md border border-slate-200 px-2 py-1 text-sm focus:border-teal-500 focus:outline-none";
const tomorrow = () => {
  const d = new Date(`${todayLocal()}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
};

/** What the server refused, with every booking it would have left outside the hours. */
function Refused({ error, stranded }: { error: string; stranded: Stranded[] }) {
  const t = useStaffT();
  return (
    <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800" role="alert">
      <p className="font-medium">{error}</p>
      {stranded.length > 0 && (
        <>
          <p className="mt-1">{t("r9b.stranded")}</p>
          <ul className="mt-1 list-disc pl-5">
            {stranded.map((b) => (
              <li key={b.code}>
                {t("r9b.strandedRow", { date: b.date, from: formatMinute(b.startMin, t.locale), to: formatMinute(b.endMin, t.locale), court: b.court, code: b.code })}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

/** The bookings a refusal lists as in the way, on one line, for a screen that shows refusals as a sentence. */
export function strandedText(data: unknown, t: ReturnType<typeof useStaffT>): string {
  const list = (data as { stranded?: unknown } | null)?.stranded;
  if (!Array.isArray(list) || list.length === 0) return "";
  return ` ${t("r9b.stranded")} ${(list as Stranded[])
    .map((b) => t("r9b.strandedRow", { date: b.date, from: formatMinute(b.startMin, t.locale), to: formatMinute(b.endMin, t.locale), court: b.court, code: b.code }))
    .join("; ")}`;
}

/** Send a change; the refusal (and the bookings in the way) or null. */
async function send(url: string, method: string, body?: unknown): Promise<{ body: unknown; stranded: Stranded[] } | null> {
  const res = await fetch(url, {
    method,
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await readJson(res);
  if (res.ok) return null;
  return { body: data, stranded: Array.isArray(data?.stranded) ? data.stranded : [] };
}

function useDayNames(): string[] {
  const t = useStaffT();
  return [t("vn.sunday"), t("vn.monday"), t("vn.tuesday"), t("vn.wednesday"), t("vn.thursday"), t("vn.friday"), t("vn.saturday")];
}

/** 08:00–23:00, Friday 16:00–02:00, Sunday closed. */
function useHoursText(): (h: { openMin: number; closeMin: number; weekHours: WeekHours | null }) => string {
  const t = useStaffT();
  const days = useDayNames();
  return (h) =>
    [
      `${formatMinute(h.openMin, t.locale)}–${formatMinute(h.closeMin, t.locale)}`,
      ...(h.weekHours ?? [])
        .map((d, i) => (d === null ? null : d === "closed" ? `${days[i]}: ${t("vn.closedEveryWeek")}` : `${days[i]}: ${formatMinute(d.open, t.locale)}–${formatMinute(d.close, t.locale)}`))
        .filter((x): x is string => x !== null),
    ].join(" · ");
}

/** The venue's hours from a later date: its own form, and the changes waiting to apply. */
export function HoursFromDate({ venueId, current }: { venueId: number; current: { openMin: number; closeMin: number; weekHours: WeekHours | null } }) {
  const t = useStaffT();
  const days = useDayNames();
  const hoursText = useHoursText();
  const blank = () => ({ id: null as number | null, from: tomorrow(), openMin: current.openMin, closeMin: current.closeMin, weekHours: current.weekHours });
  const [changes, setChanges] = useState<HoursChange[] | null>(null);
  const [form, setForm] = useState(blank);
  const [refused, setRefused] = useState<{ error: string; stranded: Stranded[] } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/venues/${venueId}/hours-changes`, { cache: "no-store" });
    const data = await readJson(res);
    if (res.ok) setChanges(data.changes);
  }, [venueId]);
  useEffect(() => {
    void load();
  }, [load]);

  async function save() {
    setBusy(true);
    setNotice(null);
    const body = { from: form.from, openMin: form.openMin, closeMin: form.closeMin, weekHours: form.weekHours };
    const out = await send(`/api/admin/venues/${venueId}/hours-changes${form.id ? `/${form.id}` : ""}`, form.id ? "PATCH" : "POST", body);
    setBusy(false);
    setRefused(out ? { error: t.err(out.body as never), stranded: out.stranded } : null);
    if (!out) {
      setNotice(t("r9b.saved", { date: form.from }));
      setForm(blank());
      await load();
    }
  }

  async function withdraw(c: HoursChange) {
    if (!window.confirm(t("r9b.withdrawConfirm", { date: c.from }))) return;
    const out = await send(`/api/admin/venues/${venueId}/hours-changes/${c.id}`, "DELETE");
    setRefused(out ? { error: t.err(out.body as never), stranded: out.stranded } : null);
    if (!out) {
      setNotice(t("r9b.withdrawn"));
      await load();
    }
  }

  const setDay = (day: number, value: DayHours) => {
    const week = [...(form.weekHours ?? Array(7).fill(null))] as WeekHours;
    week[day] = value;
    setForm({ ...form, weekHours: week.every((x) => x === null) ? null : week });
  };

  return (
    <details className="w-full rounded-lg border border-slate-200 p-3 text-xs text-slate-600" open={!!changes?.length}>
      <summary className="cursor-pointer font-medium text-slate-700">{t("r9b.hours.title")}</summary>
      <p className="mt-1 text-slate-500">{t("r9b.hours.intro")}</p>
      {changes && (
        <div className="mt-2">
          <p className="font-semibold text-slate-700">{t("r9b.upcoming")}</p>
          {changes.length === 0 ? (
            <p className="text-slate-500">{t("r9b.none")}</p>
          ) : (
            <ul className="mt-1 space-y-1">
              {changes.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{t("r9b.fromDate", { date: c.from })}</span>
                  <span>{hoursText(c)}</span>
                  <button type="button" onClick={() => setForm({ id: c.id, from: c.from, openMin: c.openMin, closeMin: c.closeMin, weekHours: c.weekHours })} className="font-medium text-teal-700 underline">
                    {t("r9b.edit")}
                  </button>
                  <button type="button" onClick={() => withdraw(c)} className="font-medium text-red-700 underline">
                    {t("r9b.withdraw")}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="flex flex-col font-medium text-slate-500">
          {t("r9b.from")}
          <input type="date" min={tomorrow()} value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} className={`mt-1 ${input}`} />
        </label>
        <label className="flex flex-col font-medium text-slate-500">
          {t("vn.opens")}
          <ClockField label={t("vn.opens")} value={form.openMin} onChange={(m) => setForm({ ...form, openMin: m })} className={`mt-1 w-28 ${input}`} />
        </label>
        <label className="flex flex-col font-medium text-slate-500">
          {t("vn.closes")}
          <ClockField label={t("vn.closes")} value={form.closeMin} after={form.openMin} onChange={(m) => setForm({ ...form, closeMin: m })} className={`mt-1 w-28 ${input}`} />
        </label>
      </div>
      <div className="mt-2 grid gap-1 sm:grid-cols-2">
        {[1, 2, 3, 4, 5, 6, 0].map((day) => {
          const d = form.weekHours?.[day] ?? null;
          return (
            <div key={day} className="flex flex-wrap items-center gap-1.5">
              <span className="w-24 font-medium">{days[day]}</span>
              <select
                aria-label={t("r9b.dayHours", { day: days[day] })}
                value={d === null ? "usual" : d === "closed" ? "closed" : "own"}
                onChange={(e) => setDay(day, e.target.value === "usual" ? null : e.target.value === "closed" ? "closed" : { open: form.openMin, close: form.closeMin })}
                className={input}
              >
                <option value="usual">{t("vn.usualHours")}</option>
                <option value="own">{t("vn.ownHours")}</option>
                <option value="closed">{t("vn.closedEveryWeek")}</option>
              </select>
              {d !== null && d !== "closed" && (
                <>
                  <ClockField label={t("r9b.dayOpens", { day: days[day] })} value={d.open} onChange={(m) => setDay(day, { open: m, close: Math.max(d.close, m + 1) })} className={input} />
                  {t("vn.to")}
                  <ClockField label={t("r9b.dayCloses", { day: days[day] })} value={d.close} after={d.open} onChange={(m) => setDay(day, { open: d.open, close: m })} className={input} />
                </>
              )}
            </div>
          );
        })}
      </div>
      {refused && <div className="mt-2"><Refused {...refused} /></div>}
      {notice && <p className="mt-2 text-emerald-700">{notice}</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" disabled={busy || !form.from} onClick={save} className="rounded-md bg-teal-600 px-3 py-1.5 font-semibold text-white hover:bg-teal-700 disabled:opacity-30">
          {form.id ? t("r9b.saveChange") : t("r9b.save")}
        </button>
        {form.id && (
          <button type="button" onClick={() => setForm(blank())} className="rounded-md border border-slate-200 px-3 py-1.5 font-medium">
            {t("c.cancel")}
          </button>
        )}
      </div>
    </details>
  );
}

interface CourtListing {
  courtId: number;
  court: string;
  rates: CourtRateChange[];
  hours: CourtHoursChange[];
}

type CourtForm = {
  id: number | null;
  kind: "rates" | "hours";
  courtId: number;
  from: string;
  offPeak: string;
  peak: string;
  memberOffPeak: string;
  memberPeak: string;
  /** Other activities' own rates, blank for the court's. */
  activities: Record<string, { off: string; peak: string }>;
  weekHours: string;
};

const text = (v: number | null | undefined) => (v === null || v === undefined ? "" : String(v));

/** A court's rates, or its own hours, from a later date: the form, and every court's changes waiting to apply. */
export function CourtChangesFromDate({ venueId, courts }: { venueId: number; courts: Court[] }) {
  const t = useStaffT();
  const days = useDayNames();
  const formFor = (court: Court, kind: CourtForm["kind"] = "rates"): CourtForm => ({
    id: null,
    kind,
    courtId: court.id,
    from: tomorrow(),
    offPeak: text(court.offPeakRate),
    peak: text(court.peakRate),
    memberOffPeak: text(court.memberOffPeakRate),
    memberPeak: text(court.memberPeakRate),
    activities: Object.fromEntries(court.activities.filter((a) => a.sport !== court.sport).map((a) => [a.sport, { off: text(a.offPeakRate), peak: text(a.peakRate) }])),
    weekHours: "",
  });
  const [listing, setListing] = useState<CourtListing[] | null>(null);
  const [form, setForm] = useState<CourtForm>(() => formFor(courts[0]));
  const [refused, setRefused] = useState<{ error: string; stranded: Stranded[] } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const court = courts.find((c) => c.id === form.courtId) ?? courts[0];

  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/venues/${venueId}/court-changes`, { cache: "no-store" });
    const data = await readJson(res);
    if (res.ok) setListing(data.courts);
  }, [venueId]);
  useEffect(() => {
    void load();
  }, [load]);

  const money = (v: string) => (v.trim() === "" ? null : Number(v));
  async function save() {
    setBusy(true);
    setNotice(null);
    const body =
      form.kind === "rates"
        ? {
            kind: "rates",
            from: form.from,
            offPeakRate: Number(form.offPeak),
            peakRate: Number(form.peak),
            memberOffPeakRate: money(form.memberOffPeak),
            memberPeakRate: money(form.memberPeak),
            activities: Object.entries(form.activities).map(([sport, r]) => ({ sport, offPeakRate: money(r.off), peakRate: money(r.peak) })),
          }
        : { kind: "hours", from: form.from, weekHours: form.weekHours.trim() === "" ? null : JSON.parse(form.weekHours) };
    const out = await send(`/api/admin/courts/${form.courtId}/changes${form.id ? `/${form.id}` : ""}`, form.id ? "PATCH" : "POST", body);
    setBusy(false);
    setRefused(out ? { error: t.err(out.body as never), stranded: out.stranded } : null);
    if (!out) {
      setNotice(t("r9b.saved", { date: form.from }));
      setForm(formFor(court, form.kind));
      await load();
    }
  }

  async function withdraw(courtId: number, id: number, from: string) {
    if (!window.confirm(t("r9b.withdrawConfirm", { date: from }))) return;
    const out = await send(`/api/admin/courts/${courtId}/changes/${id}`, "DELETE");
    setRefused(out ? { error: t.err(out.body as never), stranded: out.stranded } : null);
    if (!out) {
      setNotice(t("r9b.withdrawn"));
      await load();
    }
  }

  const ratesText = (r: CourtRateChange) =>
    [
      t("r9b.ratesLine", { off: r.offPeakRate, peak: r.peakRate }),
      ...(r.memberOffPeakRate !== null || r.memberPeakRate !== null ? [t("r9b.memberLine", { off: r.memberOffPeakRate ?? "—", peak: r.memberPeakRate ?? "—" })] : []),
      ...r.activities.filter((a) => a.offPeakRate !== null).map((a) => `${sportLabel(t.customer, a.sport)}: ${t("r9b.ratesLine", { off: a.offPeakRate!, peak: a.peakRate! })}`),
    ].join(" · ");
  const ownHoursText = (h: CourtHoursChange) =>
    h.weekHours === null
      ? t("r9b.hoursVenue")
      : h.weekHours
          .map((d, i) => (d === null ? null : d === "closed" ? `${days[i]}: ${t("vn.closedEveryWeek")}` : `${days[i]}: ${formatMinute(d.open, t.locale)}–${formatMinute(d.close, t.locale)}`))
          .filter((x): x is string => x !== null)
          .join(" · ");

  const rateField = (label: string, value: string, set: (v: string) => void) => (
    <label className="flex flex-col font-medium text-slate-500">
      {label}
      <input type="number" step={0.01} min={0} value={value} onChange={(e) => set(e.target.value)} placeholder="—" className={`mt-1 w-24 ${input}`} />
    </label>
  );

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 text-xs text-slate-600 shadow-sm">
      <h3 className="text-sm font-semibold text-slate-900">{t("r9b.rates.title")}</h3>
      <p className="mt-1 text-sm text-slate-500">{t("r9b.rates.intro")}</p>
      {listing && (
        <div className="mt-2">
          <p className="font-semibold text-slate-700">{t("r9b.upcoming")}</p>
          {listing.length === 0 ? (
            <p className="text-slate-500">{t("r9b.none")}</p>
          ) : (
            <ul className="mt-1 space-y-1">
              {listing.flatMap((l) => [
                ...l.rates.map((r) => (
                  <li key={`r${r.id}`} className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{l.court}</span>
                    <span>{t("r9b.fromDate", { date: r.from })}</span>
                    <span>{ratesText(r)}</span>
                    <button
                      type="button"
                      onClick={() => {
                        const c = courts.find((x) => x.id === l.courtId) ?? court;
                        setForm({
                          ...formFor(c),
                          id: r.id,
                          from: r.from,
                          offPeak: text(r.offPeakRate),
                          peak: text(r.peakRate),
                          memberOffPeak: text(r.memberOffPeakRate),
                          memberPeak: text(r.memberPeakRate),
                          activities: {
                            ...formFor(c).activities,
                            ...Object.fromEntries(r.activities.map((a) => [a.sport, { off: text(a.offPeakRate), peak: text(a.peakRate) }])),
                          },
                        });
                      }}
                      className="font-medium text-teal-700 underline"
                    >
                      {t("r9b.edit")}
                    </button>
                    <button type="button" onClick={() => withdraw(l.courtId, r.id, r.from)} className="font-medium text-red-700 underline">
                      {t("r9b.withdraw")}
                    </button>
                  </li>
                )),
                ...l.hours.map((h) => (
                  <li key={`h${h.id}`} className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{l.court}</span>
                    <span>{t("r9b.fromDate", { date: h.from })}</span>
                    <span>{t("r9b.kindHours")}: {ownHoursText(h)}</span>
                    <button
                      type="button"
                      onClick={() => {
                        const c = courts.find((x) => x.id === l.courtId) ?? court;
                        setForm({ ...formFor(c, "hours"), id: h.id, from: h.from, weekHours: h.weekHours ? JSON.stringify(h.weekHours) : "" });
                      }}
                      className="font-medium text-teal-700 underline"
                    >
                      {t("r9b.edit")}
                    </button>
                    <button type="button" onClick={() => withdraw(l.courtId, h.id, h.from)} className="font-medium text-red-700 underline">
                      {t("r9b.withdraw")}
                    </button>
                  </li>
                )),
              ])}
            </ul>
          )}
        </div>
      )}
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <label className="flex flex-col font-medium text-slate-500">
          {t("ct.col.court")}
          <select
            value={form.courtId}
            disabled={form.id !== null}
            onChange={(e) => setForm(formFor(courts.find((c) => c.id === Number(e.target.value)) ?? court, form.kind))}
            className={`mt-1 ${input}`}
          >
            {courts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col font-medium text-slate-500">
          {t("r9b.kind")}
          <select value={form.kind} disabled={form.id !== null} onChange={(e) => setForm(formFor(court, e.target.value as CourtForm["kind"]))} className={`mt-1 ${input}`}>
            <option value="rates">{t("r9b.kindRates")}</option>
            <option value="hours">{t("r9b.kindHours")}</option>
          </select>
        </label>
        <label className="flex flex-col font-medium text-slate-500">
          {t("r9b.from")}
          <input type="date" min={tomorrow()} value={form.from} onChange={(e) => setForm({ ...form, from: e.target.value })} className={`mt-1 ${input}`} />
        </label>
        {form.kind === "rates" && (
          <>
            {rateField(t("ct.col.offPeak"), form.offPeak, (v) => setForm({ ...form, offPeak: v }))}
            {rateField(t("ct.col.peak"), form.peak, (v) => setForm({ ...form, peak: v }))}
            {rateField(t("ct.col.memberOffPeak"), form.memberOffPeak, (v) => setForm({ ...form, memberOffPeak: v }))}
            {rateField(t("ct.col.memberPeak"), form.memberPeak, (v) => setForm({ ...form, memberPeak: v }))}
          </>
        )}
      </div>
      {form.kind === "rates" && Object.keys(form.activities).length > 0 && (
        <div className="mt-2 flex flex-wrap items-end gap-3">
          {Object.entries(form.activities).map(([sport, r]) => (
            <fieldset key={sport} className="flex flex-wrap items-end gap-1 rounded-md border border-slate-200 p-2">
              <legend className="px-1">{t("r9b.activityRates", { activity: sportLabel(t.customer, sport) })}</legend>
              {rateField(t("r9b.offPeak"), r.off, (v) => setForm({ ...form, activities: { ...form.activities, [sport]: { ...r, off: v } } }))}
              {rateField(t("r9b.peak"), r.peak, (v) => setForm({ ...form, activities: { ...form.activities, [sport]: { ...r, peak: v } } }))}
            </fieldset>
          ))}
        </div>
      )}
      {form.kind === "hours" && <CourtWeekHours value={form.weekHours} onChange={(weekHours) => setForm({ ...form, weekHours })} />}
      {refused && <div className="mt-2"><Refused {...refused} /></div>}
      {notice && <p className="mt-2 text-emerald-700">{notice}</p>}
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" disabled={busy || !form.from} onClick={save} className="rounded-md bg-teal-600 px-3 py-1.5 font-semibold text-white hover:bg-teal-700 disabled:opacity-30">
          {form.id ? t("r9b.saveChange") : t("r9b.save")}
        </button>
        {form.id && (
          <button type="button" onClick={() => setForm(formFor(court, form.kind))} className="rounded-md border border-slate-200 px-3 py-1.5 font-medium">
            {t("c.cancel")}
          </button>
        )}
      </div>
    </section>
  );
}
