"use client";

import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import { ACTIVITY_CATEGORIES, RESOURCE_MODELS, RESOURCE_NOUNS } from "@/lib/activity-catalogue";
import { activityIcon, type Activity } from "@/lib/activity-registry";
import { courtSports } from "@/lib/court-activities";
import { sportLabel } from "@/lib/i18n";
import { region } from "@/lib/region";
import { MAX_CAPACITY, MAX_DEPOSIT, type Court } from "@/lib/types";
import type { StaffT } from "@/lib/staff-i18n";
import { useStaffT } from "./StaffLanguage";

/**
 * Resources and the activities they are booked for (ADR 0011), as an
 * operator sets them up: pick an activity, start from its template, change
 * any of it; let a court be booked for more than one activity; add an
 * activity of the venue's own; record staff sign-offs.
 */

/**
 * A phrase whose `{marks}` are elements (a select, an emphasised word), in
 * the order the language puts them. Pass the phrase without those values, so
 * its marks are still there to fill.
 */
export function withMarks(text: string, marks: Record<string, ReactNode>): ReactNode[] {
  return text
    .split(/(\{\w+\})/)
    .filter((part) => part !== "")
    .map((part, i) => {
      const mark = /^\{(\w+)\}$/.exec(part)?.[1];
      return <Fragment key={i}>{mark !== undefined && mark in marks ? marks[mark] : part}</Fragment>;
    });
}

/** An activity's name in the staff's language, from the names it was given. */
const nameOf = (t: StaffT, a: Activity) => a.names[t.locale] ?? a.names.en;

const input = "rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-teal-500 focus:outline-none";

async function json<T>(res: Response, t: StaffT): Promise<T> {
  const data = await res.json();
  if (!res.ok) throw new Error(t.err(data));
  return data as T;
}

/** The activities this venue may offer: the platform's, and its own. */
export function useVenueActivities(venueId: number): { activities: Activity[]; reload: () => void } {
  const t = useStaffT();
  const [activities, setActivities] = useState<Activity[]>([]);
  const reload = useCallback(() => {
    fetch(`/api/admin/activities?venueId=${venueId}`, { cache: "no-store" })
      .then((r) => json<{ activities: Activity[] }>(r, t))
      .then((d) => setActivities(d.activities))
      .catch(() => setActivities([]));
  }, [venueId, t]);
  useEffect(() => reload(), [reload]);
  return { activities, reload };
}

/** A picker of activities, by category. */
function ActivityPicker({
  activities,
  value,
  onChange,
  label,
}: {
  activities: Activity[];
  value: string;
  onChange: (key: string) => void;
  label?: string;
}) {
  const t = useStaffT();
  return (
    <label className="flex flex-col text-xs font-medium text-slate-500">
      {label ?? t("res.activity")}
      <select value={value} onChange={(e) => onChange(e.target.value)} className={`mt-1 ${input}`}>
        {ACTIVITY_CATEGORIES.map((cat) => {
          const here = activities.filter((a) => a.category === cat);
          if (here.length === 0) return null;
          return (
            <optgroup key={cat} label={t(`res.cat.${cat}`)}>
              {here.map((a) => (
                <option key={a.key} value={a.key}>
                  {a.icon} {nameOf(t, a)}
                  {a.businessId !== null || a.venueId !== null ? ` (${t("res.yours")})` : ""}
                </option>
              ))}
            </optgroup>
          );
        })}
      </select>
    </label>
  );
}

/** Add one resource, or several of the same, from an activity's template. */
export function AddResourcesForm({ venueId, onAdded }: { venueId: number; onAdded: (message: string) => void }) {
  const t = useStaffT();
  const { activities, reload } = useVenueActivities(venueId);
  const [sport, setSport] = useState("badminton");
  const chosen = activities.find((a) => a.key === sport) ?? null;
  const [form, setForm] = useState({ count: "1", name: "", noun: "court", offPeak: "", peak: "", capacity: "1", deposit: "0", perPlayer: false, maxPlayers: "", setting: "" });
  const [error, setError] = useState<string | null>(null);
  const [ownOpen, setOwnOpen] = useState(false);

  // A new activity chosen: start from its template.
  useEffect(() => {
    if (!chosen) return;
    const tpl = chosen.template;
    setForm((f) => ({
      ...f,
      count: String(tpl.count),
      noun: tpl.noun,
      capacity: String(tpl.capacity),
      perPlayer: tpl.perPlayer,
      maxPlayers: tpl.maxPlayers === null ? "" : String(tpl.maxPlayers),
      setting: tpl.setting ?? "",
      deposit: tpl.model === "hire" ? f.deposit : "0",
    }));
  }, [chosen]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const count = Number(form.count);
    try {
      const data = await json<{ courts: Court[] }>(
        await fetch("/api/admin/courts", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            venueId,
            sport,
            ...(count > 1 || form.name.trim() === "" ? { count } : { name: form.name.trim() }),
            noun: form.noun,
            offPeakRate: Number(form.offPeak),
            peakRate: Number(form.peak),
            capacity: Number(form.capacity),
            deposit: Number(form.deposit),
            perPlayer: form.perPlayer,
            maxPlayers: form.maxPlayers.trim() === "" ? null : Number(form.maxPlayers),
            setting: form.setting || null,
          }),
        }),
        t
      );
      onAdded(t("res.added", { names: data.courts.map((c) => c.name).join(", ") }));
      setForm((f) => ({ ...f, name: "", offPeak: "", peak: "" }));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("c.failed"));
    }
  }

  return (
    <section className="space-y-3 rounded-xl border border-dashed border-slate-300 bg-white p-4">
      <h3 className="font-semibold">{t("res.addTitle")}</h3>
      <p className="text-sm text-slate-500">{t("res.addIntro")}</p>
      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      <form onSubmit={add} className="flex flex-wrap items-end gap-2">
        <ActivityPicker activities={activities} value={sport} onChange={setSport} />
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {t("res.howMany")}
          <input type="number" min={1} max={20} value={form.count} onChange={(e) => setForm({ ...form, count: e.target.value })} className={`mt-1 w-20 ${input}`} />
        </label>
        {form.count === "1" && (
          <label className="flex flex-col text-xs font-medium text-slate-500">
            {t("res.nameOptional")}
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t("res.nameExample")} className={`mt-1 w-36 ${input}`} />
          </label>
        )}
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {t("res.eachIsA")}
          <select value={form.noun} onChange={(e) => setForm({ ...form, noun: e.target.value })} className={`mt-1 ${input}`}>
            {RESOURCE_NOUNS.map((n) => (
              <option key={n} value={n}>
                {t(`res.noun.${n}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {t("res.offPeakRate")}
          <input required type="number" step={0.01} min={0} value={form.offPeak} onChange={(e) => setForm({ ...form, offPeak: e.target.value })} className={`mt-1 w-24 ${input}`} />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {t("res.peakRate")}
          <input required type="number" step={0.01} min={0} value={form.peak} onChange={(e) => setForm({ ...form, peak: e.target.value })} className={`mt-1 w-24 ${input}`} />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500" title={t("res.placesTitle")}>
          {t("res.places")}
          <input type="number" min={1} max={MAX_CAPACITY} value={form.capacity} onChange={(e) => setForm({ ...form, capacity: e.target.value })} className={`mt-1 w-20 ${input}`} />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500" title={t("res.depositTitle")}>
          {t("res.deposit")}
          <input type="number" step={0.01} min={0} max={MAX_DEPOSIT} value={form.deposit} onChange={(e) => setForm({ ...form, deposit: e.target.value })} className={`mt-1 w-20 ${input}`} />
        </label>
        {form.capacity === "1" && (
          <label className="flex items-center gap-1 text-xs font-medium text-slate-500">
            <input type="checkbox" checked={form.perPlayer} onChange={(e) => setForm({ ...form, perPlayer: e.target.checked })} />
            {t("res.perPerson")}
          </label>
        )}
        <label className="flex flex-col text-xs font-medium text-slate-500" title={t("res.settingTitle")}>
          {t("res.setting")}
          <select value={form.setting} onChange={(e) => setForm({ ...form, setting: e.target.value })} className={`mt-1 ${input}`}>
            <option value="">{t("res.notSaid")}</option>
            <option value="indoor">{t("res.indoor")}</option>
            <option value="outdoor">{t("res.outdoor")}</option>
          </select>
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {t("res.mostInBooking")}
          <input type="number" min={1} max={50} placeholder={t("res.any")} value={form.maxPlayers} onChange={(e) => setForm({ ...form, maxPlayers: e.target.value })} className={`mt-1 w-20 ${input}`} />
        </label>
        <button type="submit" className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700">
          {t("c.add")}
        </button>
      </form>
      {chosen && (
        <p className="text-xs text-slate-500">
          <span className="font-semibold">{chosen.icon} {nameOf(t, chosen)}</span>: {t(`res.model.${chosen.template.model}`)}.{" "}
          <span className={chosen.support === "full" ? "text-emerald-700" : chosen.support === "basic" ? "text-amber-700" : "text-red-700"}>
            {t(`res.support.${chosen.support}`)}
          </span>
          {chosen.supportNote ? ` — ${t.known(`srv.support.${chosen.key}`) ?? chosen.supportNote}` : ""}
          {chosen.template.signOff ? ` ${t("res.needsSignOff")}` : ""}
          {chosen.policy.defaultLength && chosen.policy.defaultLength !== 60 ? ` ${t("res.usualLength", { n: chosen.policy.defaultLength })}` : ""}
        </p>
      )}
      <button type="button" onClick={() => setOwnOpen(!ownOpen)} className="text-xs font-semibold text-teal-700 hover:underline">
        {ownOpen ? t("c.close") : t("res.ownToggle")}
      </button>
      {ownOpen && (
        <OwnActivityForm
          venueId={venueId}
          onAdded={(key) => {
            reload();
            setSport(key);
            setOwnOpen(false);
          }}
        />
      )}
    </section>
  );
}

/** An activity of the venue's own (every branch of its business): named, filed, and booked like any other. */
function OwnActivityForm({ venueId, onAdded }: { venueId: number; onAdded: (key: string) => void }) {
  const t = useStaffT();
  const [form, setForm] = useState({ en: "", ms: "", zh: "", ta: "", category: "specialist", model: "exclusive", noun: "court", icon: "", aliases: "" });
  const [error, setError] = useState<string | null>(null);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const data = await json<{ activity: Activity }>(
        await fetch("/api/admin/activities", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            venueId,
            names: { en: form.en, ms: form.ms, zh: form.zh, ta: form.ta },
            category: form.category,
            model: form.model,
            noun: form.noun,
            icon: form.icon,
            aliases: form.aliases.split(",").map((x) => x.trim()).filter(Boolean),
          }),
        }),
        t
      );
      onAdded(data.activity.key);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("c.failed"));
    }
  }
  return (
    <form onSubmit={save} className="space-y-2 rounded-lg bg-slate-50 p-3">
      <p className="text-xs text-slate-500">{t("res.ownIntro")}</p>
      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      <div className="flex flex-wrap items-end gap-2">
        {(["en", "ms", "zh", "ta"] as const).map((l) => (
          <label key={l} className="flex flex-col text-xs font-medium text-slate-500">
            {t("res.nameIn", { language: t(`res.lang.${l}`) })}
            <input required={l === "en"} maxLength={40} value={form[l]} onChange={(e) => setForm({ ...form, [l]: e.target.value })} className={`mt-1 w-36 ${input}`} />
          </label>
        ))}
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {t("res.icon")}
          <input maxLength={4} value={form.icon} onChange={(e) => setForm({ ...form, icon: e.target.value })} placeholder="🏑" className={`mt-1 w-14 ${input}`} />
        </label>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {t("res.category")}
          <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className={`mt-1 ${input}`}>
            {ACTIVITY_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {t(`res.cat.${c}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {t("res.howBooked")}
          <select value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} className={`mt-1 ${input}`}>
            {RESOURCE_MODELS.map((m) => (
              <option key={m} value={m}>
                {t(`res.model.${m}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {t("res.eachIsA")}
          <select value={form.noun} onChange={(e) => setForm({ ...form, noun: e.target.value })} className={`mt-1 ${input}`}>
            {RESOURCE_NOUNS.map((n) => (
              <option key={n} value={n}>
                {t(`res.noun.${n}`)}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {t("res.aliases")}
          <input value={form.aliases} onChange={(e) => setForm({ ...form, aliases: e.target.value })} className={`mt-1 w-48 ${input}`} />
        </label>
        <button type="submit" className="rounded-lg bg-teal-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-teal-700">
          {t("res.addActivity")}
        </button>
      </div>
    </form>
  );
}

/** What each court can be booked for besides its main activity, each at the court's rates or its own. */
export function CourtActivitiesEditor({ venueId, courts, onSaved }: { venueId: number; courts: Court[]; onSaved: (message: string) => void }) {
  const t = useStaffT();
  const { activities } = useVenueActivities(venueId);
  const [courtId, setCourtId] = useState(courts[0]?.id ?? 0);
  const court = courts.find((c) => c.id === courtId) ?? courts[0];
  const [rows, setRows] = useState<{ sport: string; offPeak: string; peak: string }[]>([]);
  const [adding, setAdding] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!court) return;
    setRows(
      court.activities
        .filter((a) => a.sport !== court.sport)
        .map((a) => ({ sport: a.sport, offPeak: a.offPeakRate === null ? "" : String(a.offPeakRate), peak: a.peakRate === null ? "" : String(a.peakRate) }))
    );
  }, [court]);

  const offered = useMemo(() => (court ? courtSports(court) : []), [court]);
  if (!court) return null;

  async function save() {
    setError(null);
    try {
      await json(
        await fetch(`/api/admin/courts/${court.id}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            activities: rows.map((r) => ({
              sport: r.sport,
              offPeakRate: r.offPeak.trim() === "" ? null : Number(r.offPeak),
              peakRate: r.peak.trim() === "" ? null : Number(r.peak),
            })),
          }),
        }),
        t
      );
      onSaved(
        t("res.bookedFor", {
          court: court.name,
          sports: [court.sport, ...rows.map((r) => r.sport)].map((s) => sportLabel(t.customer, s)).join(", "),
        })
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : t("c.failed"));
    }
  }

  return (
    <section className="space-y-2 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h3 className="font-semibold">{t("res.multiTitle")}</h3>
      <p className="text-sm text-slate-500">{t("res.multiIntro")}</p>
      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {t("res.court")}
          <select value={court.id} onChange={(e) => setCourtId(Number(e.target.value))} className={`mt-1 ${input}`}>
            {courts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({sportLabel(t.customer, c.sport)})
              </option>
            ))}
          </select>
        </label>
      </div>
      <ul className="space-y-1 text-sm">
        <li className="text-slate-500">
          {activityIcon(court.sport)} {t("res.mainActivity", { sport: sportLabel(t.customer, court.sport) })}
        </li>
        {rows.map((r, i) => (
          <li key={r.sport} className="flex flex-wrap items-center gap-2">
            <span>
              {activityIcon(r.sport)} {sportLabel(t.customer, r.sport)}
            </span>
            <input
              type="number"
              step={0.01}
              min={0}
              placeholder={t("res.offPeakPh")}
              value={r.offPeak}
              onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, offPeak: e.target.value } : x)))}
              className={`w-28 ${input}`}
            />
            <input
              type="number"
              step={0.01}
              min={0}
              placeholder={t("res.peakPh")}
              value={r.peak}
              onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, peak: e.target.value } : x)))}
              className={`w-28 ${input}`}
            />
            <button type="button" onClick={() => setRows(rows.filter((_, j) => j !== i))} className="text-xs text-red-600 hover:underline">
              {t("c.remove")}
            </button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-end gap-2">
        <select value={adding} onChange={(e) => setAdding(e.target.value)} className={input}>
          <option value="">{t("res.alsoFor")}</option>
          {activities
            .filter((a) => !offered.includes(a.key) && !rows.some((r) => r.sport === a.key))
            .map((a) => (
              <option key={a.key} value={a.key}>
                {a.icon} {nameOf(t, a)}
              </option>
            ))}
        </select>
        <button
          type="button"
          disabled={adding === ""}
          onClick={() => {
            setRows([...rows, { sport: adding, offPeak: "", peak: "" }]);
            setAdding("");
          }}
          className="rounded-md border border-slate-300 px-3 py-1.5 text-sm disabled:opacity-50"
        >
          {t("c.add")}
        </button>
        <button type="button" onClick={save} className="rounded-lg bg-teal-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-teal-700">
          {t("c.save")}
        </button>
      </div>
    </section>
  );
}

interface SignOffRow {
  id: number;
  businessId: number | null;
  sport: string | null;
  phone: string;
  name: string;
  userId: number | null;
  kind: "operational" | "certification";
  reference: string | null;
  note: string | null;
  expiresOn: string | null;
  createdAt: string;
  adminName: string | null;
}

const EMPTY_SIGN_OFF = { name: "", phone: "", email: "", sport: "", kind: "operational", reference: "", expiresOn: "", note: "", wholeBusiness: false };

/**
 * Staff sign-offs and certifications: who has been checked for an activity
 * that asks for one (a belay check, a range briefing), or whose certification
 * staff have seen. Online, only the customer's own account books on one.
 */
export function SignOffsPanel({ venueId, courts }: { venueId: number; courts: Court[] }) {
  const t = useStaffT();
  const [rows, setRows] = useState<SignOffRow[]>([]);
  const [form, setForm] = useState(EMPTY_SIGN_OFF);
  const [error, setError] = useState<string | null>(null);
  const sports = useMemo(() => [...new Set(courts.flatMap(courtSports))], [courts]);

  const load = useCallback(() => {
    fetch(`/api/admin/sign-offs?venueId=${venueId}`, { cache: "no-store" })
      .then((r) => json<{ signOffs: SignOffRow[] }>(r, t))
      .then((d) => setRows(d.signOffs))
      .catch((err) => setError(err instanceof Error ? err.message : t("c.failed")));
  }, [venueId, t]);
  useEffect(() => load(), [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await json(
        await fetch("/api/admin/sign-offs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            venueId,
            ...form,
            sport: form.sport || null,
            email: form.email || null,
            reference: form.reference || null,
            expiresOn: form.expiresOn || null,
          }),
        }),
        t
      );
      setForm({ ...EMPTY_SIGN_OFF, sport: form.sport, kind: form.kind });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("c.failed"));
    }
  }

  async function revoke(row: SignOffRow) {
    const reason = window.prompt(t(row.kind === "certification" ? "res.revokeCert" : "res.revokeSignOff", { name: row.name }));
    if (reason === null) return;
    setError(null);
    try {
      await json(
        await fetch(`/api/admin/sign-offs?venueId=${venueId}&id=${row.id}&reason=${encodeURIComponent(reason)}`, { method: "DELETE" }),
        t
      );
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("c.failed"));
    }
  }

  const certification = form.kind === "certification";
  return (
    <section className="space-y-2 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h3 className="font-semibold">{t("res.soTitle")}</h3>
      <p className="text-sm text-slate-500">
        {withMarks(t("res.soIntro"), {
          signOff: <strong>{t("res.signOffWord")}</strong>,
          certification: <strong>{t("res.certificationWord")}</strong>,
        })}
      </p>
      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      <form onSubmit={add} className="flex flex-wrap items-end gap-2">
        <select aria-label={t("res.kind")} value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })} className={input}>
          <option value="operational">{t("res.signOff")}</option>
          <option value="certification">{t("res.certification")}</option>
        </select>
        <input required placeholder={t("c.name")} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={`w-36 ${input}`} />
        <input required placeholder={region().phone.example} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className={`w-36 ${input}`} />
        <input
          type="email"
          placeholder={t("res.accountEmail")}
          value={form.email}
          onChange={(e) => setForm({ ...form, email: e.target.value })}
          className={`w-52 ${input}`}
        />
        <select aria-label={t("res.for")} value={form.sport} onChange={(e) => setForm({ ...form, sport: e.target.value })} className={input}>
          <option value="">{t("res.anythingHere")}</option>
          {sports.map((s) => (
            <option key={s} value={s}>
              {activityIcon(s)} {sportLabel(t.customer, s)}
            </option>
          ))}
        </select>
        {certification && (
          <input
            required
            placeholder={t("res.certRef")}
            value={form.reference}
            onChange={(e) => setForm({ ...form, reference: e.target.value })}
            className={`w-52 ${input}`}
          />
        )}
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {certification ? t("res.runsOut") : t("res.untilOptional")}
          <input
            type="date"
            required={certification}
            value={form.expiresOn}
            onChange={(e) => setForm({ ...form, expiresOn: e.target.value })}
            className={`mt-1 ${input}`}
          />
        </label>
        <input placeholder={t("res.note")} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} className={`w-40 ${input}`} />
        <label className="flex items-center gap-1 text-xs text-slate-600">
          <input type="checkbox" checked={form.wholeBusiness} onChange={(e) => setForm({ ...form, wholeBusiness: e.target.checked })} />
          {t("res.everyBranch")}
        </label>
        <button type="submit" className="rounded-lg bg-teal-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-teal-700">
          {t("res.record")}
        </button>
      </form>
      {rows.length > 0 && (
        <ul className="divide-y divide-slate-100 text-sm">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
              <span>
                {r.kind === "certification" ? `📜 ${r.reference} · ` : ""}
                {r.name} · {r.phone} · {r.sport ? `${activityIcon(r.sport)} ${sportLabel(t.customer, r.sport)}` : t("res.anything")}
                {r.businessId ? ` · ${t("res.everyBranchRow")}` : ""}
                {r.expiresOn ? ` · ${t("res.untilDate", { date: r.expiresOn })}` : ""}
                {` · ${r.userId ? t("res.accountLinked") : t("res.noAccount")}`}
                {` · ${t("res.byOn", { name: r.adminName ?? t("res.staff"), date: r.createdAt.slice(0, 10) })}`}
                {r.note ? ` · ${r.note}` : ""}
              </span>
              <button type="button" onClick={() => revoke(r)} className="text-xs text-red-600 hover:underline">
                {t("res.takeBack")}
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
