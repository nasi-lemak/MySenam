"use client";

import { useCallback, useEffect, useState } from "react";
import type { Coach, CoachHours } from "@/lib/coaching";
import { SPORT_LABELS, type Sport } from "@/lib/types";
import { formatHour } from "@/lib/time";
import { money } from "@/lib/region";
import type { ManagedVenue } from "./shared";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const TIMES = Array.from({ length: 49 }, (_, i) => i / 2);

interface Draft {
  id?: number;
  name: string;
  bio: string;
  sports: Sport[];
  rate: string;
  days: number[];
  from: number;
  until: number;
}

const blank = (sports: Sport[]): Draft => ({ name: "", bio: "", sports: sports.slice(0, 1), rate: "80", days: [1, 2, 3, 4, 5], from: 9, until: 17 });

/**
 * A venue's coaches for one-to-one lessons: who, what they coach, their fee
 * an hour on top of the court, and when they take lessons. Customers book
 * them from the venue's page; a lesson is a booking like any other.
 */
export function CoachesPanel({ venue }: { venue: ManagedVenue }) {
  const sports = [...new Set(venue.courts.map((c) => c.sport))] as Sport[];
  const [coaches, setCoaches] = useState<Coach[]>([]);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/coaches?venueId=${venue.id}`, { cache: "no-store" });
    if (res.ok) setCoaches((await res.json()).coaches);
  }, [venue.id]);
  useEffect(() => {
    void load();
  }, [load]);

  function edit(c: Coach) {
    // One stretch of hours on the days they work: the first one's, which is all this form sets.
    const first: CoachHours | undefined = c.hours[0];
    setDraft({
      id: c.id,
      name: c.name,
      bio: c.bio ?? "",
      sports: c.sports,
      rate: String(c.rate),
      days: [...new Set(c.hours.map((h) => h.weekday))],
      from: first?.from ?? 9,
      until: first?.until ?? 17,
    });
  }

  async function save() {
    if (!draft) return;
    setError(null);
    const res = await fetch("/api/admin/coaches", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        venueId: venue.id,
        id: draft.id,
        name: draft.name,
        bio: draft.bio,
        sports: draft.sports,
        rate: Number(draft.rate),
        hours: draft.days.map((weekday) => ({ weekday, from: draft.from, until: draft.until })),
      }),
    });
    const data = await res.json();
    if (!res.ok) return setError(data.error ?? "Could not save");
    setCoaches(data.coaches);
    setDraft(null);
  }

  async function retire(c: Coach) {
    if (!confirm(`Stop taking lessons with ${c.name}? Lessons already booked stand.`)) return;
    const res = await fetch(`/api/admin/coaches?venueId=${venue.id}&id=${c.id}`, { method: "DELETE" });
    if (res.ok) setCoaches((await res.json()).coaches);
  }

  const input = "rounded-md border border-slate-300 px-2 py-1 text-sm";
  const toggle = (on: boolean) => `rounded-md border px-2 py-1 text-xs font-medium ${on ? "border-teal-600 bg-teal-50 text-teal-800" : "border-slate-300 text-slate-600"}`;
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 text-sm">
      <h3 className="font-semibold">Coaches: one-to-one lessons</h3>
      <p className="mt-1 text-xs text-slate-500">
        Customers book a lesson from your venue page: a free court is picked for them, and the coach&apos;s fee goes on top of
        its price. A coach can only be booked once at a time.
      </p>
      <ul className="mt-2 divide-y divide-slate-100">
        {coaches.map((c) => (
          <li key={c.id} className={`flex flex-wrap items-center justify-between gap-2 py-2 ${c.active ? "" : "opacity-50"}`}>
            <span>
              <span className="font-medium">{c.name}</span> · {c.sports.map((s) => SPORT_LABELS[s]).join(", ")} · {money(c.rate)}/hr
              <span className="block text-xs text-slate-500">
                {c.active
                  ? c.hours.map((h) => `${DAYS[h.weekday]} ${formatHour(h.from)}–${formatHour(h.until)}`).join(", ") || "No hours set"
                  : "Not taking lessons"}
              </span>
            </span>
            <span className="flex gap-3 text-xs font-medium">
              <button onClick={() => edit(c)} className="text-teal-700 underline">
                {c.active ? "Change" : "Bring back"}
              </button>
              {c.active && (
                <button onClick={() => retire(c)} className="text-red-700 underline">
                  Stop
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>
      {draft ? (
        <div className="mt-3 space-y-2 rounded-lg border border-slate-200 p-3">
          <div className="flex flex-wrap gap-2">
            <input aria-label="Coach's name" placeholder="Coach's name" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} className={input} />
            <input aria-label="Fee an hour" type="number" min={0} step={0.01} value={draft.rate} onChange={(e) => setDraft({ ...draft, rate: e.target.value })} className={`w-24 ${input}`} />
          </div>
          <textarea aria-label="About them" placeholder="About them (optional): level, certification, languages" rows={2} value={draft.bio} onChange={(e) => setDraft({ ...draft, bio: e.target.value })} className={`w-full ${input}`} />
          <div className="flex flex-wrap items-center gap-1">
            <span className="mr-1 text-xs text-slate-600">Coaches</span>
            {sports.map((s) => (
              <button key={s} type="button" onClick={() => setDraft({ ...draft, sports: draft.sports.includes(s) ? draft.sports.filter((x) => x !== s) : [...draft.sports, s] })} className={toggle(draft.sports.includes(s))}>
                {SPORT_LABELS[s]}
              </button>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-1">
            <span className="mr-1 text-xs text-slate-600">Takes lessons</span>
            {DAYS.map((d, i) => (
              <button key={d} type="button" onClick={() => setDraft({ ...draft, days: draft.days.includes(i) ? draft.days.filter((x) => x !== i) : [...draft.days, i] })} className={toggle(draft.days.includes(i))}>
                {d}
              </button>
            ))}
            <select aria-label="From" value={draft.from} onChange={(e) => setDraft({ ...draft, from: Number(e.target.value) })} className={input}>
              {TIMES.slice(0, -1).map((h) => (
                <option key={h} value={h}>{formatHour(h)}</option>
              ))}
            </select>
            to
            <select aria-label="Until" value={draft.until} onChange={(e) => setDraft({ ...draft, until: Number(e.target.value) })} className={input}>
              {TIMES.slice(1).map((h) => (
                <option key={h} value={h}>{h === 24 ? "Midnight" : formatHour(h)}</option>
              ))}
            </select>
          </div>
          <div className="flex gap-2">
            <button onClick={save} className="rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white">
              Save coach
            </button>
            <button onClick={() => setDraft(null)} className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold text-slate-700">
              Cancel
            </button>
          </div>
          {error && <p className="text-xs font-medium text-red-700">{error}</p>}
        </div>
      ) : (
        <button onClick={() => setDraft(blank(sports))} className="mt-2 rounded-md border border-teal-300 px-3 py-1.5 text-xs font-semibold text-teal-700">
          Add a coach
        </button>
      )}
    </section>
  );
}
