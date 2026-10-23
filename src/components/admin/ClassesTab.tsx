"use client";

import { ClockField } from "@/components/ClockField";
import { useCallback, useEffect, useState } from "react";
import { CoachesPanel } from "./CoachesPanel";
import { formatHour } from "@/lib/time";
import { MAX_CLASS_WEEKS, SPORT_ICONS } from "@/lib/types";
import type { Booking, ClassSession } from "@/lib/types";
import { todayLocal } from "./shared";
import type { ManagedVenue } from "./shared";
import { money, currencySymbol } from "@/lib/region";

/* ---------------- Classes tab ---------------- */

export function ClassesTab({ venues }: { venues: ManagedVenue[] }) {
  const [venueId, setVenueId] = useState(venues[0]?.id ?? 1);
  const [classes, setClasses] = useState<ClassSession[] | null>(null);
  const [roster, setRoster] = useState<{
    session: ClassSession;
    roster: Booking[];
    waitlist?: { id: number; name: string; phone: string; status: string }[];
  } | null>(null);
  const [waiting, setWaiting] = useState<Record<number, number>>({});
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [form, setForm] = useState({
    courtId: "",
    name: "",
    instructor: "",
    date: todayLocal(),
    // Minutes of the day: classes start and end on any minute.
    start: 19 * 60,
    end: 20 * 60,
    capacity: "12",
    price: "25",
    weeks: "1",
    termOff: "0",
    who: "anyone",
  });

  const venue = venues.find((v) => v.id === venueId);
  // Only shared facilities can host a class; a single court has one place.
  const hostable = (venue?.courts ?? []).filter((c) => c.capacity > 1);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(`/api/admin/classes?venueId=${venueId}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load classes");
      setClasses(data.classes);
      setWaiting(data.waiting ?? {});
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load classes");
      setClasses(null);
    }
  }, [venueId]);

  useEffect(() => {
    load();
  }, [load]);

  async function schedule(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/classes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          courtId: Number(form.courtId),
          name: form.name,
          instructor: form.instructor,
          date: form.date,
          start: form.start,
          end: form.end,
          capacity: Number(form.capacity),
          price: Number(form.price),
          weeks: Number(form.weeks),
          termOffPercent: Number(form.weeks) > 1 ? Number(form.termOff) : null,
          who: form.who,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not schedule the class");
      setNotice(
        data.classes.length > 1
          ? `Scheduled ${data.classes.length} weekly sessions (${data.seriesCode}).`
          : `Scheduled ${form.name}.`
      );
      setForm({ ...form, name: "", instructor: "" });
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not schedule the class");
    }
  }

  async function cancelClass(session: ClassSession) {
    if (
      !window.confirm(
        `Cancel ${session.name} on ${session.date}? ${session.enrolled} enrolment(s) will be released.`
      )
    )
      return;
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/classes/${session.id}`, { method: "DELETE" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Cancellation failed");
      setNotice(`Cancelled — ${data.released} enrolment(s) released.`);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Cancellation failed");
    }
  }

  async function openRoster(session: ClassSession) {
    setError(null);
    try {
      const res = await fetch(`/api/admin/classes/${session.id}`, { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Failed to load roster");
      setRoster(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load roster");
    }
  }

  const inputClass =
    "rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none";

  return (
    <div className="space-y-4">
      <select
        value={venueId}
        onChange={(e) => setVenueId(Number(e.target.value))}
        className={inputClass}
      >
        {venues.map((v) => (
          <option key={v.id} value={v.id}>
            {v.name}
          </option>
        ))}
      </select>

      {error && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}
      {notice && (
        <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">
          {notice}
        </div>
      )}

      {classes && classes.length > 0 ? (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
          <table className="w-full min-w-[820px] text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                {["Class", "Instructor", "Where", "When", "Enrolled", "Waiting", "Price", "", ""].map(
                  (h, i) => (
                    <th key={i} className="px-3 py-2 font-semibold">
                      {h}
                    </th>
                  )
                )}
              </tr>
            </thead>
            <tbody>
              {classes.map((session) => (
                <tr key={session.id} className="border-b border-slate-100 last:border-0">
                  <td className="px-3 py-2 font-medium">
                    {session.name}
                    {session.seriesCode && (
                      <span className="ml-1 rounded-full bg-violet-50 px-1.5 py-0.5 font-mono text-[10px] font-semibold text-violet-700">
                        🔁
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2">{session.instructor}</td>
                  <td className="px-3 py-2">
                    {SPORT_ICONS[session.sport]} {session.courtName}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">
                    {session.date} · {formatHour(session.startHour)}–{formatHour(session.endHour)}
                  </td>
                  <td className="px-3 py-2">
                    <button
                      onClick={() => openRoster(session)}
                      className="font-medium text-teal-700 underline"
                    >
                      {session.enrolled}/{session.capacity}
                    </button>
                  </td>
                  <td className="px-3 py-2">
                    {waiting[session.id] ? (
                      <span className="rounded-full bg-amber-50 px-2 py-0.5 text-xs font-semibold text-amber-700">
                        {waiting[session.id]}
                      </span>
                    ) : (
                      <span className="text-xs text-slate-300">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2">
                    {money(session.price)}
                    {session.who !== "anyone" && <span className="ml-1 text-xs text-fuchsia-700">{session.who} only</span>}
                  </td>
                  <td className="px-3 py-2">
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                        session.status === "scheduled"
                          ? "bg-emerald-50 text-emerald-700"
                          : "bg-slate-100 text-slate-500"
                      }`}
                    >
                      {session.status}
                    </span>
                  </td>
                  <td className="px-3 py-2">
                    {session.status === "scheduled" && (
                      <button
                        onClick={() => cancelClass(session)}
                        className="rounded-md border border-red-300 px-2.5 py-1 text-xs font-medium text-red-600 hover:bg-red-50"
                      >
                        Cancel
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-white p-8 text-center text-slate-500">
          No classes scheduled here yet.
        </div>
      )}

      {hostable.length === 0 ? (
        <p className="rounded-xl border border-dashed border-slate-300 bg-white p-4 text-sm text-slate-500">
          Classes need a shared facility to run in. Give a resource a capacity above 1 in{" "}
          <span className="font-medium">Courts &amp; rates</span> first.
        </p>
      ) : (
        <form
          onSubmit={schedule}
          className="flex flex-wrap items-end gap-2 rounded-xl border border-dashed border-slate-300 bg-white p-4"
        >
          <div className="w-full text-sm font-semibold text-slate-700">Schedule a class</div>
          <input
            required minLength={2} placeholder="Class name" value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            className={`w-40 ${inputClass}`}
          />
          <input
            required minLength={2} placeholder="Instructor" value={form.instructor}
            onChange={(e) => setForm({ ...form, instructor: e.target.value })}
            className={`w-36 ${inputClass}`}
          />
          <select
            required value={form.courtId}
            onChange={(e) => setForm({ ...form, courtId: e.target.value })}
            className={inputClass}
          >
            <option value="">Where…</option>
            {hostable.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({c.capacity})
              </option>
            ))}
          </select>
          <input
            required type="date" value={form.date}
            onChange={(e) => setForm({ ...form, date: e.target.value })}
            className={inputClass}
          />
          <ClockField label="Starts" value={form.start} onChange={(m) => setForm({ ...form, start: m })} className={`w-28 ${inputClass}`} />
          <ClockField label="Ends" value={form.end} after={form.start} onChange={(m) => setForm({ ...form, end: m })} className={`w-28 ${inputClass}`} />
          <input
            required type="number" min={1} value={form.capacity}
            onChange={(e) => setForm({ ...form, capacity: e.target.value })}
            title="Seats" className={`w-20 ${inputClass}`}
          />
          <input
            required type="number"
            step={0.01} min={0} value={form.price}
            onChange={(e) => setForm({ ...form, price: e.target.value })}
            title={`Price per person (${currencySymbol()})`} className={`w-20 ${inputClass}`}
          />
          <select
            value={form.who}
            onChange={(e) => setForm({ ...form, who: e.target.value })}
            title="Who can enrol"
            className={inputClass}
          >
            <option value="anyone">Anyone</option>
            <option value="women">Women only</option>
            <option value="men">Men only</option>
          </select>
          <select
            value={form.weeks}
            onChange={(e) => setForm({ ...form, weeks: e.target.value })}
            title="Repeat weekly"
            className={inputClass}
          >
            {Array.from({ length: MAX_CLASS_WEEKS }, (_, i) => i + 1).map((w) => (
              <option key={w} value={w}>
                {w === 1 ? "Once" : `${w} weeks`}
              </option>
            ))}
          </select>
          {Number(form.weeks) > 1 && (
            <select
              value={form.termOff}
              onChange={(e) => setForm({ ...form, termOff: e.target.value })}
              title="A share off each session for joining the whole term at once"
              className={inputClass}
            >
              {[0, 5, 10, 15, 20, 25, 30].map((p) => (
                <option key={p} value={p}>
                  {p === 0 ? "No term discount" : `${p}% off for the whole term`}
                </option>
              ))}
            </select>
          )}
          <button
            type="submit"
            className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700"
          >
            Schedule
          </button>
        </form>
      )}

      {roster && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 px-4">
          <div className="max-h-[80vh] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-6 shadow-2xl">
            <h3 className="text-lg font-bold">{roster.session.name}</h3>
            <p className="mt-1 text-sm text-slate-600">
              {roster.session.date} · {formatHour(roster.session.startHour)}–
              {formatHour(roster.session.endHour)} with {roster.session.instructor}
            </p>
            {roster.waitlist && roster.waitlist.length > 0 && (
              <div className="mt-4 rounded-lg bg-amber-50 p-3">
                <div className="text-xs font-semibold uppercase tracking-wide text-amber-800">
                  Waiting ({roster.waitlist.length})
                </div>
                <ul className="mt-1 space-y-1 text-sm text-amber-900">
                  {roster.waitlist.map((w) => (
                    <li key={w.id} className="flex items-center justify-between gap-3">
                      <span>
                        {w.name}
                        <span className="ml-2 text-xs opacity-70">{w.phone}</span>
                      </span>
                      {w.status === "offered" && (
                        <span className="rounded-full bg-amber-200 px-2 py-0.5 text-xs font-semibold">
                          offered
                        </span>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {roster.roster.length === 0 ? (
              <p className="mt-4 text-sm text-slate-500">Nobody has enrolled yet.</p>
            ) : (
              <ul className="mt-4 space-y-1.5 text-sm">
                {roster.roster.map((b) => (
                  <li key={b.id} className="flex items-center justify-between gap-3">
                    <span className={b.status === "cancelled" ? "text-slate-400 line-through" : ""}>
                      {b.name}
                      <span className="ml-2 text-xs text-slate-400">{b.phone}</span>
                    </span>
                    {b.status === "confirmed" && (
                      <span
                        className={`rounded-full px-2 py-0.5 text-xs font-semibold ${
                          b.checkedInAt
                            ? "bg-emerald-50 text-emerald-700"
                            : "bg-slate-100 text-slate-500"
                        }`}
                      >
                        {b.checkedInAt ? "checked in" : "expected"}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <button
              onClick={() => setRoster(null)}
              className="mt-5 w-full rounded-lg bg-teal-600 py-2 font-semibold text-white hover:bg-teal-700"
            >
              Close
            </button>
          </div>
        </div>
      )}
      {venue && <CoachesPanel key={venue.id} venue={venue} />}
    </div>
  );
}
