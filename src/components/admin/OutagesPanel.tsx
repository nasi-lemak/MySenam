"use client";

import { useCallback, useEffect, useState } from "react";
import type { Court } from "@/lib/types";
import { offsetMs } from "@/lib/region";

interface Outage {
  id: number;
  courtId: number;
  courtName: string;
  startsOn: string;
  endsOn: string | null;
  reason: string | null;
}

interface Affected {
  kind: "booking" | "class";
  ref: string;
  date: string;
  startHour: number;
  name: string;
}

const input = "rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none";
const today = () => new Date(Date.now() + offsetMs()).toISOString().slice(0, 10);

/**
 * Courts out of service for days at a time. Taking one out shows whatever
 * is booked in the stretch, and asks before cancelling it.
 */
export function OutagesPanel({ venueId, courts }: { venueId: number; courts: Court[] }) {
  const [outages, setOutages] = useState<Outage[]>([]);
  const [form, setForm] = useState({ courtId: "", startsOn: today(), endsOn: "", open: false, reason: "" });
  const [affected, setAffected] = useState<Affected[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/outages?venueId=${venueId}`, { cache: "no-store" });
    if (res.ok) setOutages((await res.json()).outages);
  }, [venueId]);
  useEffect(() => {
    void load();
  }, [load]);

  async function submit(cancelAffected: boolean) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/outages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          courtId: Number(form.courtId || courts[0]?.id),
          startsOn: form.startsOn,
          endsOn: form.open ? null : form.endsOn || form.startsOn,
          reason: form.reason,
          cancelAffected,
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setAffected(data.affected ?? null);
        throw new Error(data.error ?? "Could not take it out of service.");
      }
      setAffected(null);
      setNotice(
        `${data.outage.courtName} is out of service${data.cancelled ? `; ${data.cancelled} cancelled and refunded, and the customers told` : ""}.`
      );
      setForm({ ...form, reason: "" });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not take it out of service.");
    } finally {
      setBusy(false);
    }
  }

  async function end(o: Outage) {
    const res = await fetch(`/api/admin/outages?id=${o.id}`, { method: "DELETE" });
    if (res.ok) {
      setNotice(`${o.courtName} is back in service from today.`);
      await load();
    } else setError((await res.json()).error ?? "Could not do that.");
  }

  if (courts.length === 0) return null;
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h3 className="font-semibold">Out of service</h3>
      <p className="mt-1 text-sm text-slate-500">
        For days at a time, or until further notice: nobody can book it, and customers see it is closed. For a few
        hours, block them on the Schedule instead.
      </p>
      {outages.length > 0 && (
        <ul className="mt-3 space-y-2 text-sm">
          {outages.map((o) => (
            <li key={o.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-amber-50 px-3 py-2">
              <span>
                <span className="font-medium">{o.courtName}</span>: {o.startsOn}
                {o.endsOn === null ? " until further notice" : o.endsOn === o.startsOn ? "" : ` to ${o.endsOn}`}
                {o.reason && <span className="text-slate-600"> · {o.reason}</span>}
              </span>
              <button onClick={() => end(o)} className="text-sm font-medium text-teal-700 underline">
                {o.startsOn > today() ? "Call it off" : "Back in service today"}
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex flex-wrap items-end gap-2">
        <select
          aria-label="Court"
          value={form.courtId || String(courts[0].id)}
          onChange={(e) => setForm({ ...form, courtId: e.target.value })}
          className={input}
        >
          {courts.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <label className="text-xs text-slate-500">
          From
          <input type="date" value={form.startsOn} onChange={(e) => setForm({ ...form, startsOn: e.target.value })} className={`block ${input}`} />
        </label>
        <label className="text-xs text-slate-500">
          To
          <input
            type="date"
            disabled={form.open}
            value={form.endsOn}
            min={form.startsOn}
            onChange={(e) => setForm({ ...form, endsOn: e.target.value })}
            className={`block ${input}`}
          />
        </label>
        <label className="flex items-center gap-1 pb-2 text-sm text-slate-600">
          <input type="checkbox" checked={form.open} onChange={(e) => setForm({ ...form, open: e.target.checked })} />
          Until further notice
        </label>
        <input
          placeholder="Why (customers see this)"
          value={form.reason}
          maxLength={200}
          onChange={(e) => setForm({ ...form, reason: e.target.value })}
          className={`min-w-0 flex-1 ${input}`}
        />
        <button
          disabled={busy}
          onClick={() => submit(false)}
          className="rounded-lg bg-teal-600 px-3 py-2 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
        >
          Take out of service
        </button>
      </div>
      {error && <p className="mt-2 text-sm font-medium text-red-700">{error}</p>}
      {notice && <p className="mt-2 text-sm font-medium text-emerald-700">{notice}</p>}
      {affected && affected.length > 0 && (
        <div className="mt-2 rounded-lg border border-red-200 bg-red-50 p-3 text-sm">
          <ul className="space-y-0.5">
            {affected.map((a) => (
              <li key={`${a.kind}-${a.ref}`}>
                {a.date} {String(a.startHour).padStart(2, "0")}:00 · {a.kind === "class" ? `Class: ${a.name}` : `${a.name} (${a.ref})`}
              </li>
            ))}
          </ul>
          <button
            disabled={busy}
            onClick={() => submit(true)}
            className="mt-2 rounded-lg bg-red-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
          >
            Cancel these, refund them, tell the customers, and take it out
          </button>
        </div>
      )}
    </section>
  );
}
