"use client";

import { readJson } from "@/lib/read-response";
import { useCallback, useEffect, useState } from "react";
import type { Court } from "@/lib/types";
import type { Phrase } from "@/lib/i18n";
import { sportLabel } from "@/lib/i18n";
import { courtSports } from "@/lib/court-activities";
import { formatMinute } from "@/lib/interval";
import { offsetMs } from "@/lib/region";
import type { StaffPhrase } from "@/lib/staff-i18n";
import type { LaunchReason } from "@/lib/launch-day";
import type { RowFault, RowWarning } from "@/lib/tide-import";
import type { Stranded } from "@/lib/launch-worklist";
import { useStaffT } from "./StaffLanguage";

/**
 * Launch and tide windows for water hire (lib/launch-windows.ts, ADR 0037): a
 * resource's daily window by weekday, from a tide table, or both; the tide
 * table (typed or imported as CSV, checked row by row); a month of the windows
 * as bookings will meet them; and the bookings a change leaves outside a
 * window, which nothing cancels.
 */

interface Rule {
  id: number;
  courtId: number;
  sport: string | null;
  source: "weekly" | "tide" | "both";
  weekly: ({ from: number; to: number } | null)[] | null;
  station: string | null;
  tide: { rule: "height"; minHeightCm: number } | { rule: "event"; eventKind: "high" | "low"; eventMinutes: number } | null;
  minWindowMin: number;
  returnBufferMin: number;
}

interface Station {
  station: string;
  entries: number;
  from: string;
  until: string;
}

interface Entry {
  id: number;
  date: string;
  time: string;
  kind: "high" | "low";
  heightCm: number;
  source: "typed" | "csv";
}

interface PreviewDay {
  date: string;
  windows: { start: number; end: number }[];
  returnBuffer: number;
  why: "closed" | LaunchReason | null;
}

interface Day {
  on: boolean;
  from: string;
  to: string;
}

interface Form {
  id?: number;
  courtId: string;
  sport: string;
  source: "weekly" | "tide" | "both";
  days: Day[];
  station: string;
  tideRule: "height" | "event";
  minHeight: string;
  eventKind: "high" | "low";
  eventMinutes: string;
  minWindow: string;
  back: string;
}

const DAYS: StaffPhrase[] = ["coach.day.0", "coach.day.1", "coach.day.2", "coach.day.3", "coach.day.4", "coach.day.5", "coach.day.6"];
const input = "rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-teal-500 focus:outline-none";
const button = "rounded-lg bg-teal-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-50";
const link = "text-sm font-medium text-teal-700 underline";
const today = () => new Date(Date.now() + offsetMs()).toISOString().slice(0, 10);

/** "07:10" as minutes; an end of "00:00" is midnight. */
const toMinutes = (text: string, end = false): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text);
  if (!m) return null;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  return end && minutes === 0 ? 1440 : minutes;
};
const toClock = (minutes: number): string => `${String(Math.floor(minutes / 60) % 24).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

const blank = (courtId: number): Form => ({
  courtId: String(courtId),
  sport: "",
  source: "weekly",
  days: Array.from({ length: 7 }, () => ({ on: false, from: "07:00", to: "11:00" })),
  station: "",
  tideRule: "height",
  minHeight: "2",
  eventKind: "high",
  eventMinutes: "90",
  minWindow: "30",
  back: "0",
});

const formOf = (r: Rule): Form => ({
  id: r.id,
  courtId: String(r.courtId),
  sport: r.sport ?? "",
  source: r.source,
  days: Array.from({ length: 7 }, (_, i) => {
    const d = r.weekly?.[i] ?? null;
    return d ? { on: true, from: toClock(d.from), to: toClock(d.to) } : { on: false, from: "07:00", to: "11:00" };
  }),
  station: r.station ?? "",
  tideRule: r.tide?.rule ?? "height",
  minHeight: r.tide?.rule === "height" ? String(r.tide.minHeightCm / 100) : "2",
  eventKind: r.tide?.rule === "event" ? r.tide.eventKind : "high",
  eventMinutes: r.tide?.rule === "event" ? String(r.tide.eventMinutes) : "90",
  minWindow: String(r.minWindowMin),
  back: String(r.returnBufferMin),
});

export function LaunchWindowsPanel({ venueId, courts }: { venueId: number; courts: Court[] }) {
  const t = useStaffT();
  const [rules, setRules] = useState<Rule[]>([]);
  const [stations, setStations] = useState<Station[]>([]);
  const [stranded, setStranded] = useState<Stranded[]>([]);
  const [kept, setKept] = useState<Stranded[]>([]);
  const [form, setForm] = useState<Form | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/launch-windows?venueId=${venueId}`, { cache: "no-store" });
    if (!res.ok) return;
    const data = await readJson(res);
    setRules(data.rules ?? []);
    setStations(data.stations ?? []);
    setStranded(data.stranded ?? []);
    setKept(data.kept ?? []);
  }, [venueId]);
  useEffect(() => {
    void load();
  }, [load]);

  const courtName = (id: number) => courts.find((c) => c.id === id)?.name ?? String(id);
  const activity = (r: Rule) => (r.sport ? sportLabel(t.customer, r.sport) : t("wtrs.allActivities"));
  /** What a change answered: the bookings and classes it leaves outside a window, updated in place. */
  const worklist = (data: { stranded?: Stranded[]; kept?: Stranded[] }) => {
    if (data.stranded) setStranded(data.stranded);
    if (data.kept) setKept(data.kept);
  };
  const reasonText = (reason: LaunchReason) => t.customer(`wtr1.reason.${reason}` as Phrase);
  const whyText = (code: Stranded["why"]) => t(`wtrs.why.${code}` as StaffPhrase);
  const windowsText = (w: { start: number; end: number }[]) => w.map((x) => `${formatMinute(x.start, t.locale)}–${formatMinute(x.end, t.locale)}`).join(", ");

  async function save() {
    if (!form) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const weekly =
        form.source === "tide"
          ? undefined
          : form.days.map((d) => {
              if (!d.on) return null;
              const from = toMinutes(d.from);
              const to = toMinutes(d.to, true);
              return from === null || to === null ? { from: -1, to: -1 } : { from, to };
            });
      const res = await fetch("/api/admin/launch-windows", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          venueId,
          ...(form.id ? { id: form.id } : {}),
          courtId: Number(form.courtId),
          sport: form.sport || null,
          source: form.source,
          weekly,
          station: form.source === "weekly" ? undefined : form.station,
          tide:
            form.source === "weekly"
              ? undefined
              : form.tideRule === "height"
                ? { rule: "height", minHeight: form.minHeight }
                : { rule: "event", eventKind: form.eventKind, eventMinutes: form.eventMinutes },
          minWindowMin: form.minWindow,
          returnBufferMin: form.back,
        }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(t.err(data, t("c.failed")));
      worklist(data);
      setForm(null);
      setNotice(t("wtrs.saved"));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("c.failed"));
    } finally {
      setBusy(false);
    }
  }

  async function remove(r: Rule) {
    if (!window.confirm(t("wtrs.removeConfirm"))) return;
    setError(null);
    const res = await fetch(`/api/admin/launch-windows?venueId=${venueId}&id=${r.id}`, { method: "DELETE" });
    const data = await readJson(res);
    if (!res.ok) return setError(t.err(data, t("c.failed")));
    worklist(data);
    setNotice(t("wtrs.removed"));
    await load();
  }

  async function keep(item: Stranded) {
    setError(null);
    const res = await fetch("/api/admin/launch-windows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ venueId, keep: item.ref }),
    });
    const data = await readJson(res);
    if (!res.ok) return setError(t.err(data, t("c.failed")));
    worklist(data);
  }

  if (courts.length === 0) return null;
  const set = (patch: Partial<Form>) => setForm((f) => (f ? { ...f, ...patch } : f));
  const chosen = form ? courts.find((c) => c.id === Number(form.courtId)) : undefined;

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm" data-testid="launch-windows">
      <h3 className="font-semibold">{t("wtrs.title")}</h3>
      <p className="mt-1 text-sm text-slate-500">{t("wtrs.intro")}</p>
      <p className="mt-1 text-xs text-slate-500">{t("wtrs.tideNote")}</p>

      {rules.length === 0 ? (
        <p className="mt-3 text-sm text-slate-600">{t("wtrs.none")}</p>
      ) : (
        <ul className="mt-3 space-y-2 text-sm">
          {rules.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-slate-50 px-3 py-2">
              <span>
                <span className="font-medium">{courtName(r.courtId)}</span> · {activity(r)}: {t(`wtrs.src.${r.source}` as StaffPhrase)}
                {r.tide?.rule === "height" && `, ${t("wtrs.sum.height", { m: r.tide.minHeightCm / 100, station: r.station ?? "" })}`}
                {r.tide?.rule === "event" && `, ${t("wtrs.sum.event", { n: r.tide.eventMinutes, kind: t(`wtrs.kind.${r.tide.eventKind}` as StaffPhrase), station: r.station ?? "" })}`}
                {r.minWindowMin > 0 && `, ${t("wtrs.sum.min", { n: r.minWindowMin })}`}
                {r.returnBufferMin > 0 && `, ${t("wtrs.sum.back", { n: r.returnBufferMin })}`}
              </span>
              <span className="flex gap-3">
                <button type="button" className={link} aria-label={t("wtrs.edit", { court: courtName(r.courtId) })} onClick={() => setForm(formOf(r))}>
                  {t("c.edit")}
                </button>
                <button type="button" className={link} aria-label={t("wtrs.remove", { court: courtName(r.courtId) })} onClick={() => void remove(r)}>
                  {t("c.remove")}
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}

      {!form && (
        <button type="button" className={`mt-3 ${button}`} onClick={() => setForm(blank(courts[0].id))}>
          {t("wtrs.add")}
        </button>
      )}

      {form && (
        <div className="mt-3 space-y-3 rounded-lg border border-slate-200 p-3">
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-xs text-slate-500">
              {t("wtrs.f.court")}
              <select value={form.courtId} disabled={form.id !== undefined} onChange={(e) => set({ courtId: e.target.value, sport: "" })} className={`block ${input}`}>
                {courts.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-xs text-slate-500">
              {t("wtrs.f.activity")}
              <select value={form.sport} disabled={form.id !== undefined} onChange={(e) => set({ sport: e.target.value })} className={`block ${input}`}>
                <option value="">{t("wtrs.allActivities")}</option>
                {chosen &&
                  courtSports(chosen).map((s) => (
                    <option key={s} value={s}>
                      {sportLabel(t.customer, s)}
                    </option>
                  ))}
              </select>
            </label>
            <label className="text-xs text-slate-500">
              {t("wtrs.f.source")}
              <select value={form.source} onChange={(e) => set({ source: e.target.value as Form["source"] })} className={`block ${input}`}>
                {(["weekly", "tide", "both"] as const).map((s) => (
                  <option key={s} value={s}>
                    {t(`wtrs.src.${s}` as StaffPhrase)}
                  </option>
                ))}
              </select>
            </label>
          </div>

          {form.source !== "tide" && (
            <div>
              <ul className="space-y-1">
                {form.days.map((d, i) => (
                  <li key={i} className="flex flex-wrap items-center gap-2 text-sm">
                    <label className="flex min-w-32 items-center gap-1">
                      <input
                        type="checkbox"
                        checked={d.on}
                        onChange={(e) => set({ days: form.days.map((x, j) => (j === i ? { ...x, on: e.target.checked } : x)) })}
                        aria-label={t("wtrs.f.day", { day: t(DAYS[i]) })}
                      />
                      {t(DAYS[i])}
                    </label>
                    <input
                      type="time"
                      value={d.from}
                      disabled={!d.on}
                      aria-label={t("wtrs.f.from", { day: t(DAYS[i]) })}
                      onChange={(e) => set({ days: form.days.map((x, j) => (j === i ? { ...x, from: e.target.value } : x)) })}
                      className={input}
                    />
                    <input
                      type="time"
                      value={d.to}
                      disabled={!d.on}
                      aria-label={t("wtrs.f.to", { day: t(DAYS[i]) })}
                      onChange={(e) => set({ days: form.days.map((x, j) => (j === i ? { ...x, to: e.target.value } : x)) })}
                      className={input}
                    />
                  </li>
                ))}
              </ul>
              <p className="mt-1 text-xs text-slate-500">{t("wtrs.f.toHint")}</p>
              <button
                type="button"
                className={`mt-1 ${link}`}
                onClick={() => {
                  const first = form.days.find((d) => d.on);
                  if (first) set({ days: form.days.map(() => ({ ...first })) });
                }}
              >
                {t("wtrs.f.sameAll")}
              </button>
            </div>
          )}

          {form.source !== "weekly" && (
            <div className="space-y-2">
              <label className="block text-xs text-slate-500">
                {t("wtrs.f.station")}
                <input list="wtrs-stations" value={form.station} maxLength={60} onChange={(e) => set({ station: e.target.value })} className={`block ${input}`} />
                <datalist id="wtrs-stations">
                  {stations.map((s) => (
                    <option key={s.station} value={s.station} />
                  ))}
                </datalist>
                <span className="block text-xs text-slate-400">{t("wtrs.f.stationHint")}</span>
              </label>
              <div className="flex flex-wrap items-end gap-3">
                <label className="text-xs text-slate-500">
                  {t("wtrs.f.rule")}
                  <select value={form.tideRule} onChange={(e) => set({ tideRule: e.target.value as Form["tideRule"] })} className={`block ${input}`}>
                    <option value="height">{t("wtrs.f.ruleHeight")}</option>
                    <option value="event">{t("wtrs.f.ruleEvent")}</option>
                  </select>
                </label>
                {form.tideRule === "height" ? (
                  <label className="text-xs text-slate-500">
                    {t("wtrs.f.minHeight")}
                    <input type="number" step="0.05" value={form.minHeight} onChange={(e) => set({ minHeight: e.target.value })} className={`block w-28 ${input}`} />
                  </label>
                ) : (
                  <>
                    <label className="text-xs text-slate-500">
                      {t("wtrs.f.eventKind")}
                      <select value={form.eventKind} onChange={(e) => set({ eventKind: e.target.value as Form["eventKind"] })} className={`block ${input}`}>
                        <option value="high">{t("wtrs.kind.high")}</option>
                        <option value="low">{t("wtrs.kind.low")}</option>
                      </select>
                    </label>
                    <label className="text-xs text-slate-500">
                      {t("wtrs.f.eventMinutes")}
                      <input type="number" min={0} max={720} value={form.eventMinutes} onChange={(e) => set({ eventMinutes: e.target.value })} className={`block w-24 ${input}`} />
                    </label>
                  </>
                )}
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-start gap-3">
            <label className="text-xs text-slate-500">
              {t("wtrs.f.minWindow")}
              <input type="number" min={0} max={1440} value={form.minWindow} onChange={(e) => set({ minWindow: e.target.value })} className={`block w-28 ${input}`} />
              <span className="block max-w-56 text-xs text-slate-400">{t("wtrs.f.minWindowHint")}</span>
            </label>
            <label className="text-xs text-slate-500">
              {t("wtrs.f.back")}
              <input type="number" min={0} max={240} value={form.back} onChange={(e) => set({ back: e.target.value })} className={`block w-28 ${input}`} />
              <span className="block max-w-64 text-xs text-slate-400">{t("wtrs.f.backHint")}</span>
            </label>
          </div>
          <div className="flex gap-2">
            <button type="button" disabled={busy} className={button} onClick={() => void save()}>
              {busy ? t("c.saving") : t("c.save")}
            </button>
            <button type="button" className={link} onClick={() => setForm(null)}>
              {t("c.cancel")}
            </button>
          </div>
        </div>
      )}

      {error && <p className="mt-2 text-sm font-medium text-red-700">{error}</p>}
      {notice && <p className="mt-2 text-sm font-medium text-emerald-700">{notice}</p>}

      {stranded.length > 0 || kept.length > 0 ? (
        <div className="mt-4 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm" data-testid="launch-stranded">
          {stranded.length > 0 && (
            <>
              <h4 className="font-semibold text-amber-900">{t("wtrs.wl.title", { n: stranded.length })}</h4>
              <p className="mt-0.5 text-xs text-amber-900">{t("wtrs.wl.intro")}</p>
              <ul className="mt-2 space-y-1.5">
                {stranded.map((s) => (
                  <li key={`${s.kind}-${s.ref}`} className="rounded-md bg-white px-2 py-1.5">
                    <span className="font-medium">
                      {t("wtrs.wl.line", {
                        date: s.date,
                        time: formatMinute(s.startMin, t.locale),
                        end: formatMinute(s.endMin, t.locale),
                        court: s.court,
                        name: s.kind === "class" ? t("wtrs.wl.class", { name: s.name }) : s.name,
                      })}
                    </span>
                    {s.phone && (
                      <>
                        {" "}
                        <a href={`tel:${s.phone}`} className="text-teal-700 underline">
                          {s.phone}
                        </a>
                      </>
                    )}
                    {s.kind === "booking" && <span className="text-slate-500"> ({s.ref})</span>}
                    <span className="block text-xs text-slate-600">
                      {whyText(s.why)} · {s.windows.length > 0 ? t("wtrs.wl.windows", { windows: windowsText(s.windows) }) : t("wtrs.wl.noWindows")}
                    </span>
                    {s.kind === "booking" && (
                      <button type="button" className={`mt-1 ${link}`} aria-label={t("wtrs.wl.keepFor", { code: s.ref })} onClick={() => void keep(s)}>
                        {t("wtrs.wl.keep")}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
          {kept.length > 0 && <p className="mt-2 text-xs text-amber-900">{t("wtrs.wl.kept", { n: kept.length })}</p>}
        </div>
      ) : (
        rules.length > 0 && <p className="mt-3 text-sm text-slate-600">{t("wtrs.wl.none")}</p>
      )}

      <Preview venueId={venueId} rules={rules} courtName={courtName} activity={activity} reasonText={reasonText} windowsText={windowsText} />
      <TideTable venueId={venueId} stations={stations} reload={load} onWorklist={worklist} />
    </section>
  );
}

/** A month of one rule's windows, as bookings will meet them. */
function Preview({
  venueId,
  rules,
  courtName,
  activity,
  reasonText,
  windowsText,
}: {
  venueId: number;
  rules: Rule[];
  courtName: (id: number) => string;
  activity: (r: Rule) => string;
  reasonText: (r: LaunchReason) => string;
  windowsText: (w: { start: number; end: number }[]) => string;
}) {
  const t = useStaffT();
  const [ruleId, setRuleId] = useState("");
  const [month, setMonth] = useState(today().slice(0, 7));
  const [days, setDays] = useState<PreviewDay[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (rules.length === 0) return null;
  const id = ruleId || String(rules[0].id);

  async function show() {
    setError(null);
    const res = await fetch(`/api/admin/launch-windows?venueId=${venueId}&preview=${id}&month=${month}`, { cache: "no-store" });
    const data = await readJson(res);
    if (!res.ok) {
      setDays(null);
      return setError(t.err(data, t("c.failed")));
    }
    setDays(data.days);
  }

  return (
    <div className="mt-4 border-t border-slate-100 pt-3">
      <h4 className="font-semibold">{t("wtrs.pv.title")}</h4>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <label className="text-xs text-slate-500">
          {t("wtrs.pv.rule")}
          <select value={id} onChange={(e) => setRuleId(e.target.value)} className={`block ${input}`}>
            {rules.map((r) => (
              <option key={r.id} value={r.id}>
                {courtName(r.courtId)} · {activity(r)}
              </option>
            ))}
          </select>
        </label>
        <label className="text-xs text-slate-500">
          {t("wtrs.pv.month")}
          <input type="month" value={month} onChange={(e) => setMonth(e.target.value)} className={`block ${input}`} />
        </label>
        <button type="button" className={button} onClick={() => void show()}>
          {t("wtrs.pv.show")}
        </button>
      </div>
      {error && <p className="mt-2 text-sm font-medium text-red-700">{error}</p>}
      {days && (
        <table className="mt-2 w-full max-w-xl text-left text-sm">
          <tbody>
            {days.map((d) => (
              <tr key={d.date} className="border-b border-slate-100">
                <th scope="row" className="whitespace-nowrap py-1 pr-3 font-medium">
                  {d.date}
                </th>
                <td className="py-1">
                  {d.windows.length > 0
                    ? `${windowsText(d.windows)}${d.returnBuffer > 0 ? ` · ${t("wtrs.pv.backBy", { n: d.returnBuffer })}` : ""}`
                    : d.why === "closed"
                      ? t("wtrs.pv.closed")
                      : `${t("wtrs.pv.noWindow")}${d.why ? ` · ${reasonText(d.why)}` : ""}`}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}

/** The venue's own tide table: its stations, one entry typed, a CSV imported, entries removed. */
function TideTable({
  venueId,
  stations,
  reload,
  onWorklist,
}: {
  venueId: number;
  stations: Station[];
  reload: () => Promise<void>;
  onWorklist: (data: { stranded?: Stranded[]; kept?: Stranded[] }) => void;
}) {
  const t = useStaffT();
  const [station, setStation] = useState("");
  const [csv, setCsv] = useState("");
  const [times, setTimes] = useState<"venue" | "utc">("venue");
  const [errors, setErrors] = useState<RowFault[]>([]);
  const [warnings, setWarnings] = useState<RowWarning[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [from, setFrom] = useState(today());
  const [one, setOne] = useState({ date: today(), time: "", kind: "high", heightM: "" });
  const [range, setRange] = useState({ from: today(), until: today() });

  const shown = station || stations[0]?.station || "";
  const loadEntries = useCallback(async () => {
    if (!shown) return setEntries([]);
    const res = await fetch(`/api/admin/launch-windows?venueId=${venueId}&station=${encodeURIComponent(shown)}&from=${from}`, { cache: "no-store" });
    if (res.ok) setEntries((await readJson(res)).entries ?? []);
  }, [venueId, shown, from]);
  useEffect(() => {
    void loadEntries();
  }, [loadEntries, stations]);

  const post = async (body: Record<string, unknown>) => {
    const res = await fetch("/api/admin/tides", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ venueId, ...body }) });
    return { res, data: await readJson(res) };
  };
  const faults = (data: { errors?: RowFault[]; warnings?: RowWarning[]; error?: string }) => {
    setErrors(data.errors ?? []);
    setWarnings(data.warnings ?? []);
  };
  const rowText = (e: RowFault) => t(`wtrs.row.${e.code}` as StaffPhrase, e.vars ?? {});
  const warnText = (w: RowWarning) => t(`wtrs.warn.${w.code}` as StaffPhrase, { n: w.line, ...w.vars, ...(w.vars.kind ? { kind: t(`wtrs.kind.${w.vars.kind}` as StaffPhrase) } : {}) });

  async function importCsv(preview: boolean) {
    setMessage(null);
    setProblem(null);
    const { res, data } = await post({ action: "import", station: station || shown, csv, times, preview });
    faults(data);
    if (!res.ok) {
      if (data.errors?.length > 0) setProblem(t.plural("wtrs.tt.faults", data.errors.length));
      else setProblem(t.err(data, t("c.failed")));
      return;
    }
    setMessage(t(preview ? "wtrs.tt.checked" : "wtrs.tt.imported", { added: data.added, changed: data.changed, unchanged: data.unchanged, from: data.from, until: data.until }));
    if (!preview) {
      onWorklist(data);
      setCsv("");
      setStation(data.station);
      await reload();
      await loadEntries();
    }
  }

  async function addOne() {
    setMessage(null);
    setProblem(null);
    const { res, data } = await post({ action: "add", station: station || shown, ...one });
    faults(data);
    if (!res.ok) return setProblem(data.errors?.length > 0 ? rowText(data.errors[0]) : t.err(data, t("c.failed")));
    onWorklist(data);
    setMessage(t("wtrs.tt.imported", { added: data.added, changed: data.changed, unchanged: data.unchanged, from: data.from, until: data.until }));
    setStation(data.station);
    await reload();
    await loadEntries();
  }

  async function removeEntry(e: Entry) {
    const { res, data } = await post({ action: "delete", id: e.id });
    if (!res.ok) return setProblem(t.err(data, t("c.failed")));
    onWorklist(data);
    await reload();
    await loadEntries();
  }

  async function removeRange() {
    if (!window.confirm(t("wtrs.tt.rangeConfirm", { station: shown, from: range.from, until: range.until }))) return;
    const { res, data } = await post({ action: "delete", station: shown, from: range.from, until: range.until });
    if (!res.ok) return setProblem(t.err(data, t("c.failed")));
    onWorklist(data);
    setMessage(t("wtrs.tt.removedN", { n: data.removed }));
    await reload();
    await loadEntries();
  }

  return (
    <div className="mt-4 border-t border-slate-100 pt-3">
      <h4 className="font-semibold">{t("wtrs.tt.title")}</h4>
      {stations.length === 0 ? (
        <p className="mt-1 text-sm text-slate-600">{t("wtrs.tt.none")}</p>
      ) : (
        <ul className="mt-1 text-sm text-slate-600">
          {stations.map((s) => (
            <li key={s.station}>{t("wtrs.tt.station", { station: s.station, n: s.entries, from: s.from, until: s.until })}</li>
          ))}
        </ul>
      )}

      <div className="mt-3 space-y-2">
        <h5 className="text-sm font-medium">{t("wtrs.tt.import")}</h5>
        <p className="text-xs text-slate-500">{t("wtrs.tt.format")}</p>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-slate-500">
            {t("wtrs.f.station")}
            <input list="wtrs-stations-tt" value={station} placeholder={shown} maxLength={60} onChange={(e) => setStation(e.target.value)} className={`block ${input}`} />
            <datalist id="wtrs-stations-tt">
              {stations.map((s) => (
                <option key={s.station} value={s.station} />
              ))}
            </datalist>
          </label>
          <label className="text-xs text-slate-500">
            {t("wtrs.tt.times")}
            <select value={times} onChange={(e) => setTimes(e.target.value as "venue" | "utc")} className={`block ${input}`}>
              <option value="venue">{t("wtrs.tt.timesVenue")}</option>
              <option value="utc">{t("wtrs.tt.timesUtc")}</option>
            </select>
          </label>
          <label className="text-xs text-slate-500">
            {t("wtrs.tt.file")}
            <input
              type="file"
              accept=".csv,text/csv,text/plain"
              className={`block ${input}`}
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (file) setCsv(await file.text());
              }}
            />
          </label>
        </div>
        <textarea aria-label={t("wtrs.tt.csv")} value={csv} onChange={(e) => setCsv(e.target.value)} rows={6} className={`w-full font-mono ${input}`} spellCheck={false} />
        <div className="flex gap-2">
          <button type="button" className={button} disabled={csv.trim() === ""} onClick={() => void importCsv(true)}>
            {t("wtrs.tt.check")}
          </button>
          <button type="button" className={button} disabled={csv.trim() === ""} onClick={() => void importCsv(false)}>
            {t("wtrs.tt.importNow")}
          </button>
        </div>
      </div>

      {problem && <p className="mt-2 text-sm font-medium text-red-700">{problem}</p>}
      {message && <p className="mt-2 text-sm font-medium text-emerald-700">{message}</p>}
      {errors.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-sm text-red-700" data-testid="tide-faults">
          {errors.map((e, i) => (
            <li key={i}>
              {e.line > 0 && <strong>{t("wtrs.tt.line", { n: e.line })}: </strong>}
              {rowText(e)}
            </li>
          ))}
        </ul>
      )}
      {warnings.length > 0 && (
        <ul className="mt-1 space-y-0.5 text-sm text-amber-800">
          {warnings.map((w, i) => (
            <li key={i}>{warnText(w)}</li>
          ))}
        </ul>
      )}

      <div className="mt-4 space-y-2">
        <h5 className="text-sm font-medium">{t("wtrs.tt.add")}</h5>
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-slate-500">
            {t("wtrs.tt.date")}
            <input type="date" value={one.date} onChange={(e) => setOne({ ...one, date: e.target.value })} className={`block ${input}`} />
          </label>
          <label className="text-xs text-slate-500">
            {t("wtrs.tt.time")}
            <input type="time" value={one.time} onChange={(e) => setOne({ ...one, time: e.target.value })} className={`block ${input}`} />
          </label>
          <label className="text-xs text-slate-500">
            {t("wtrs.tt.type")}
            <select value={one.kind} onChange={(e) => setOne({ ...one, kind: e.target.value })} className={`block ${input}`}>
              <option value="high">{t("wtrs.kind.high")}</option>
              <option value="low">{t("wtrs.kind.low")}</option>
            </select>
          </label>
          <label className="text-xs text-slate-500">
            {t("wtrs.tt.height")}
            <input type="number" step="0.01" value={one.heightM} onChange={(e) => setOne({ ...one, heightM: e.target.value })} className={`block w-28 ${input}`} />
          </label>
          <button type="button" className={button} disabled={!(station || shown)} onClick={() => void addOne()}>
            {t("wtrs.tt.addNow")}
          </button>
        </div>
      </div>

      {shown && (
        <div className="mt-4">
          <div className="flex flex-wrap items-end gap-3">
            <h5 className="text-sm font-medium">{t("wtrs.tt.entries", { station: shown })}</h5>
            <label className="text-xs text-slate-500">
              {t("wtrs.tt.entriesFrom")}
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className={`block ${input}`} />
            </label>
          </div>
          <ul className="mt-1 max-h-60 space-y-0.5 overflow-y-auto text-sm">
            {entries.map((e) => (
              <li key={e.id} className="flex items-center justify-between gap-2">
                <span>
                  {t("wtrs.tt.entry", { date: e.date, time: e.time, kind: t(`wtrs.kind.${e.kind}` as StaffPhrase), height: e.heightCm / 100 })}{" "}
                  <span className="text-xs text-slate-400">({t(e.source === "typed" ? "wtrs.tt.srcTyped" : "wtrs.tt.srcCsv")})</span>
                </span>
                <button type="button" className={link} aria-label={t("wtrs.tt.removeEntry", { date: e.date, time: e.time })} onClick={() => void removeEntry(e)}>
                  {t("c.remove")}
                </button>
              </li>
            ))}
          </ul>
          <div className="mt-3 flex flex-wrap items-end gap-2">
            <span className="text-sm font-medium">{t("wtrs.tt.removeRange")}</span>
            <label className="text-xs text-slate-500">
              {t("wtrs.tt.rangeFrom")}
              <input type="date" value={range.from} onChange={(e) => setRange({ ...range, from: e.target.value })} className={`block ${input}`} />
            </label>
            <label className="text-xs text-slate-500">
              {t("wtrs.tt.rangeUntil")}
              <input type="date" value={range.until} onChange={(e) => setRange({ ...range, until: e.target.value })} className={`block ${input}`} />
            </label>
            <button type="button" className={link} onClick={() => void removeRange()}>
              {t("wtrs.tt.removeRangeNow")}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
