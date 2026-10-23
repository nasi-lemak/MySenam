"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ACTIVITY_CATEGORIES, RESOURCE_MODELS, RESOURCE_NOUNS, type ActivityCategory, type ResourceModel } from "@/lib/activity-catalogue";
import { activityIcon, activityName, type Activity } from "@/lib/activity-registry";
import { courtSports } from "@/lib/court-activities";
import { currencySymbol, region } from "@/lib/region";
import { MAX_CAPACITY, MAX_DEPOSIT, type Court } from "@/lib/types";

/**
 * Resources and the activities they are booked for (ADR 0011), as an
 * operator sets them up: pick an activity, start from its template, change
 * any of it; let a court be booked for more than one activity; add an
 * activity of the venue's own; record staff sign-offs.
 */

export const CATEGORY_LABELS: Record<ActivityCategory, string> = {
  racket: "Racket sports",
  team: "Team sports",
  aquatic: "In the pool",
  water: "On the water",
  fitness: "Fitness",
  studio: "Classes and studios",
  specialist: "Specialist",
};

const MODEL_LABELS: Record<ResourceModel, string> = {
  exclusive: "One booking at a time (a court, a pitch)",
  lanes: "Several of the same, one booking each (lanes, bays, tables)",
  shared: "Many people at once, up to its places (a gym floor, a wall)",
  class: "Classes led by an instructor (a studio)",
  hire: "Kit hired out, several per booking (kayaks, boards, bikes)",
};

const SUPPORT_LABELS = {
  full: "Fully supported",
  basic: "Basic booking",
  specialised: "Needs a workflow not built yet",
} as const;

const input = "rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-teal-500 focus:outline-none";

async function json<T>(res: Response, fallback: string): Promise<T> {
  const data = await res.json();
  if (!res.ok) throw new Error(data.error ?? fallback);
  return data as T;
}

/** The activities this venue may offer: the platform's, and its own. */
export function useVenueActivities(venueId: number): { activities: Activity[]; reload: () => void } {
  const [activities, setActivities] = useState<Activity[]>([]);
  const reload = useCallback(() => {
    fetch(`/api/admin/activities?venueId=${venueId}`, { cache: "no-store" })
      .then((r) => json<{ activities: Activity[] }>(r, "Could not load activities"))
      .then((d) => setActivities(d.activities))
      .catch(() => setActivities([]));
  }, [venueId]);
  useEffect(() => reload(), [reload]);
  return { activities, reload };
}

/** A picker of activities, by category. */
function ActivityPicker({
  activities,
  value,
  onChange,
  label = "Activity",
}: {
  activities: Activity[];
  value: string;
  onChange: (key: string) => void;
  label?: string;
}) {
  return (
    <label className="flex flex-col text-xs font-medium text-slate-500">
      {label}
      <select value={value} onChange={(e) => onChange(e.target.value)} className={`mt-1 ${input}`}>
        {ACTIVITY_CATEGORIES.map((cat) => {
          const here = activities.filter((a) => a.category === cat);
          if (here.length === 0) return null;
          return (
            <optgroup key={cat} label={CATEGORY_LABELS[cat]}>
              {here.map((a) => (
                <option key={a.key} value={a.key}>
                  {a.icon} {a.names.en}
                  {a.businessId !== null || a.venueId !== null ? " (yours)" : ""}
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
  const { activities, reload } = useVenueActivities(venueId);
  const [sport, setSport] = useState("badminton");
  const chosen = activities.find((a) => a.key === sport) ?? null;
  const [form, setForm] = useState({ count: "1", name: "", noun: "court", offPeak: "", peak: "", capacity: "1", deposit: "0", perPlayer: false, maxPlayers: "", setting: "" });
  const [error, setError] = useState<string | null>(null);
  const [ownOpen, setOwnOpen] = useState(false);

  // A new activity chosen: start from its template.
  useEffect(() => {
    if (!chosen) return;
    const t = chosen.template;
    setForm((f) => ({
      ...f,
      count: String(t.count),
      noun: t.noun,
      capacity: String(t.capacity),
      perPlayer: t.perPlayer,
      maxPlayers: t.maxPlayers === null ? "" : String(t.maxPlayers),
      setting: t.setting ?? "",
      deposit: t.model === "hire" ? f.deposit : "0",
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
        "Could not add"
      );
      onAdded(`Added ${data.courts.map((c) => c.name).join(", ")}.`);
      setForm((f) => ({ ...f, name: "", offPeak: "", peak: "" }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add");
    }
  }

  return (
    <section className="space-y-3 rounded-xl border border-dashed border-slate-300 bg-white p-4">
      <h3 className="font-semibold">Add courts, lanes, bays or a facility</h3>
      <p className="text-sm text-slate-500">
        Choose what it is for, and it starts as that activity usually is: lanes come in sets, a gym floor has places, kayaks are hired several at a
        time. Change anything before adding.
      </p>
      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      <form onSubmit={add} className="flex flex-wrap items-end gap-2">
        <ActivityPicker activities={activities} value={sport} onChange={setSport} />
        <label className="flex flex-col text-xs font-medium text-slate-500">
          How many
          <input type="number" min={1} max={20} value={form.count} onChange={(e) => setForm({ ...form, count: e.target.value })} className={`mt-1 w-20 ${input}`} />
        </label>
        {form.count === "1" && (
          <label className="flex flex-col text-xs font-medium text-slate-500">
            Name (optional)
            <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Centre court" className={`mt-1 w-36 ${input}`} />
          </label>
        )}
        <label className="flex flex-col text-xs font-medium text-slate-500">
          Each is a
          <select value={form.noun} onChange={(e) => setForm({ ...form, noun: e.target.value })} className={`mt-1 ${input}`}>
            {RESOURCE_NOUNS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          Off-peak ({currencySymbol()}/hr)
          <input required type="number" step={0.01} min={0} value={form.offPeak} onChange={(e) => setForm({ ...form, offPeak: e.target.value })} className={`mt-1 w-24 ${input}`} />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          Peak ({currencySymbol()}/hr)
          <input required type="number" step={0.01} min={0} value={form.peak} onChange={(e) => setForm({ ...form, peak: e.target.value })} className={`mt-1 w-24 ${input}`} />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500" title="1: one booking at a time. More: that many people, or items, at once.">
          Places
          <input type="number" min={1} max={MAX_CAPACITY} value={form.capacity} onChange={(e) => setForm({ ...form, capacity: e.target.value })} className={`mt-1 w-20 ${input}`} />
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500" title="Held while kit is out. 0 for anything that stays on site.">
          Deposit ({currencySymbol()})
          <input type="number" step={0.01} min={0} max={MAX_DEPOSIT} value={form.deposit} onChange={(e) => setForm({ ...form, deposit: e.target.value })} className={`mt-1 w-20 ${input}`} />
        </label>
        {form.capacity === "1" && (
          <label className="flex items-center gap-1 text-xs font-medium text-slate-500">
            <input type="checkbox" checked={form.perPlayer} onChange={(e) => setForm({ ...form, perPlayer: e.target.checked })} />
            Priced per person
          </label>
        )}
        <label className="flex flex-col text-xs font-medium text-slate-500" title="For search's indoor and outdoor filters.">
          Indoor or outdoor
          <select value={form.setting} onChange={(e) => setForm({ ...form, setting: e.target.value })} className={`mt-1 ${input}`}>
            <option value="">Not said</option>
            <option value="indoor">Indoor</option>
            <option value="outdoor">Outdoor</option>
          </select>
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          Most in one booking
          <input type="number" min={1} max={50} placeholder="Any" value={form.maxPlayers} onChange={(e) => setForm({ ...form, maxPlayers: e.target.value })} className={`mt-1 w-20 ${input}`} />
        </label>
        <button type="submit" className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700">
          Add
        </button>
      </form>
      {chosen && (
        <p className="text-xs text-slate-500">
          <span className="font-semibold">{chosen.icon} {chosen.names.en}</span>: {MODEL_LABELS[chosen.template.model]}.{" "}
          <span className={chosen.support === "full" ? "text-emerald-700" : chosen.support === "basic" ? "text-amber-700" : "text-red-700"}>
            {SUPPORT_LABELS[chosen.support]}
          </span>
          {chosen.supportNote ? ` — ${chosen.supportNote}` : ""}
          {chosen.template.signOff ? " Customers need a staff sign-off before they book it, unless you turn that off in the booking rules." : ""}
          {chosen.policy.defaultLength && chosen.policy.defaultLength !== 60 ? ` Usually booked for ${chosen.policy.defaultLength} minutes.` : ""}
        </p>
      )}
      <button type="button" onClick={() => setOwnOpen(!ownOpen)} className="text-xs font-semibold text-teal-700 hover:underline">
        {ownOpen ? "Close" : "Not in the list? Add an activity of your own"}
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
        "Could not add the activity"
      );
      onAdded(data.activity.key);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not add the activity");
    }
  }
  return (
    <form onSubmit={save} className="space-y-2 rounded-lg bg-slate-50 p-3">
      <p className="text-xs text-slate-500">
        It is booked with the same courts, rules and prices as everything else, and players find it in search once one of your courts offers it. Its
        name in other languages is optional.
      </p>
      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      <div className="flex flex-wrap items-end gap-2">
        {(["en", "ms", "zh", "ta"] as const).map((l) => (
          <label key={l} className="flex flex-col text-xs font-medium text-slate-500">
            Name ({l === "en" ? "English" : l === "ms" ? "Malay" : l === "zh" ? "Chinese" : "Tamil"})
            <input required={l === "en"} maxLength={40} value={form[l]} onChange={(e) => setForm({ ...form, [l]: e.target.value })} className={`mt-1 w-36 ${input}`} />
          </label>
        ))}
        <label className="flex flex-col text-xs font-medium text-slate-500">
          Icon
          <input maxLength={4} value={form.icon} onChange={(e) => setForm({ ...form, icon: e.target.value })} placeholder="🏑" className={`mt-1 w-14 ${input}`} />
        </label>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col text-xs font-medium text-slate-500">
          Category
          <select value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} className={`mt-1 ${input}`}>
            {ACTIVITY_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABELS[c]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          How it is booked
          <select value={form.model} onChange={(e) => setForm({ ...form, model: e.target.value })} className={`mt-1 ${input}`}>
            {RESOURCE_MODELS.map((m) => (
              <option key={m} value={m}>
                {MODEL_LABELS[m]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          Each is a
          <select value={form.noun} onChange={(e) => setForm({ ...form, noun: e.target.value })} className={`mt-1 ${input}`}>
            {RESOURCE_NOUNS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          Also searched as (commas)
          <input value={form.aliases} onChange={(e) => setForm({ ...form, aliases: e.target.value })} className={`mt-1 w-48 ${input}`} />
        </label>
        <button type="submit" className="rounded-lg bg-teal-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-teal-700">
          Add activity
        </button>
      </div>
    </form>
  );
}

/** What each court can be booked for besides its main activity, each at the court's rates or its own. */
export function CourtActivitiesEditor({ venueId, courts, onSaved }: { venueId: number; courts: Court[]; onSaved: (message: string) => void }) {
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
        "Could not save"
      );
      onSaved(`${court.name} is booked for ${[court.sport, ...rows.map((r) => r.sport)].map((s) => activityName(s)).join(", ")}.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    }
  }

  return (
    <section className="space-y-2 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h3 className="font-semibold">Courts booked for more than one activity</h3>
      <p className="text-sm text-slate-500">
        A hall booked for badminton can be booked for pickleball or volleyball too: it shows under each, at each one&apos;s rates and booking rules,
        and only one booking holds it at a time. Leave the rates blank to charge the court&apos;s own.
      </p>
      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col text-xs font-medium text-slate-500">
          Court
          <select value={court.id} onChange={(e) => setCourtId(Number(e.target.value))} className={`mt-1 ${input}`}>
            {courts.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({activityName(c.sport)})
              </option>
            ))}
          </select>
        </label>
      </div>
      <ul className="space-y-1 text-sm">
        <li className="text-slate-500">
          {activityIcon(court.sport)} {activityName(court.sport)}: its main activity, at the court&apos;s rates
        </li>
        {rows.map((r, i) => (
          <li key={r.sport} className="flex flex-wrap items-center gap-2">
            <span>
              {activityIcon(r.sport)} {activityName(r.sport)}
            </span>
            <input
              type="number"
              step={0.01}
              min={0}
              placeholder={`Off-peak ${currencySymbol()}`}
              value={r.offPeak}
              onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, offPeak: e.target.value } : x)))}
              className={`w-28 ${input}`}
            />
            <input
              type="number"
              step={0.01}
              min={0}
              placeholder={`Peak ${currencySymbol()}`}
              value={r.peak}
              onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, peak: e.target.value } : x)))}
              className={`w-28 ${input}`}
            />
            <button type="button" onClick={() => setRows(rows.filter((_, j) => j !== i))} className="text-xs text-red-600 hover:underline">
              Remove
            </button>
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-end gap-2">
        <select value={adding} onChange={(e) => setAdding(e.target.value)} className={input}>
          <option value="">Also booked for…</option>
          {activities
            .filter((a) => !offered.includes(a.key) && !rows.some((r) => r.sport === a.key))
            .map((a) => (
              <option key={a.key} value={a.key}>
                {a.icon} {a.names.en}
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
          Add
        </button>
        <button type="button" onClick={save} className="rounded-lg bg-teal-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-teal-700">
          Save
        </button>
      </div>
    </section>
  );
}

interface SignOffRow {
  id: number;
  sport: string | null;
  phone: string;
  name: string;
  note: string | null;
  expiresOn: string | null;
}

/** Staff sign-offs: who has been checked for an activity that asks for one (a belay check, a range briefing). */
export function SignOffsPanel({ venueId, courts }: { venueId: number; courts: Court[] }) {
  const [rows, setRows] = useState<SignOffRow[]>([]);
  const [form, setForm] = useState({ name: "", phone: "", sport: "", expiresOn: "", note: "" });
  const [error, setError] = useState<string | null>(null);
  const sports = useMemo(() => [...new Set(courts.flatMap(courtSports))], [courts]);

  const load = useCallback(() => {
    fetch(`/api/admin/sign-offs?venueId=${venueId}`, { cache: "no-store" })
      .then((r) => json<{ signOffs: SignOffRow[] }>(r, "Could not load sign-offs"))
      .then((d) => setRows(d.signOffs))
      .catch((err) => setError(err instanceof Error ? err.message : "Could not load sign-offs"));
  }, [venueId]);
  useEffect(() => load(), [load]);

  async function add(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await json(
        await fetch("/api/admin/sign-offs", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ venueId, ...form, sport: form.sport || null, expiresOn: form.expiresOn || null }),
        }),
        "Could not record the sign-off"
      );
      setForm({ name: "", phone: "", sport: form.sport, expiresOn: "", note: "" });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not record the sign-off");
    }
  }

  async function revoke(row: SignOffRow) {
    if (!window.confirm(`Take back ${row.name}'s sign-off?`)) return;
    await fetch(`/api/admin/sign-offs?venueId=${venueId}&id=${row.id}`, { method: "DELETE" });
    load();
  }

  return (
    <section className="space-y-2 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h3 className="font-semibold">Staff sign-offs</h3>
      <p className="text-sm text-slate-500">
        Where an activity&apos;s booking rules ask for one, customers book it only once staff have signed them off here: after a belay check, a range
        briefing, an induction. Staff can still book anyone in.
      </p>
      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      <form onSubmit={add} className="flex flex-wrap items-end gap-2">
        <input required placeholder="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className={`w-36 ${input}`} />
        <input required placeholder={region().phone.example} value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} className={`w-36 ${input}`} />
        <select value={form.sport} onChange={(e) => setForm({ ...form, sport: e.target.value })} className={input}>
          <option value="">Anything here</option>
          {sports.map((s) => (
            <option key={s} value={s}>
              {activityIcon(s)} {activityName(s)}
            </option>
          ))}
        </select>
        <label className="flex flex-col text-xs font-medium text-slate-500">
          Until (optional)
          <input type="date" value={form.expiresOn} onChange={(e) => setForm({ ...form, expiresOn: e.target.value })} className={`mt-1 ${input}`} />
        </label>
        <input placeholder="Note" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} className={`w-40 ${input}`} />
        <button type="submit" className="rounded-lg bg-teal-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-teal-700">
          Sign off
        </button>
      </form>
      {rows.length > 0 && (
        <ul className="divide-y divide-slate-100 text-sm">
          {rows.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
              <span>
                {r.name} · {r.phone} · {r.sport ? `${activityIcon(r.sport)} ${activityName(r.sport)}` : "anything here"}
                {r.expiresOn ? ` · until ${r.expiresOn}` : ""}
                {r.note ? ` · ${r.note}` : ""}
              </span>
              <button type="button" onClick={() => revoke(r)} className="text-xs text-red-600 hover:underline">
                Take back
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
