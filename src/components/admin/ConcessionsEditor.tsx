"use client";

import { useCallback, useEffect, useState } from "react";
import { SPORTS, SPORT_LABELS, type Sport } from "@/lib/types";

interface Concession {
  id: number;
  name: string;
  percent: number;
  proof: string;
  sport: Sport | null;
  offPeakOnly: boolean;
}

const PRESETS: { name: string; percent: number; proof: string }[] = [
  { name: "Student", percent: 20, proof: "your student card" },
  { name: "Senior (60+)", percent: 30, proof: "your IC" },
  { name: "Child (under 12)", percent: 50, proof: "your child's MyKid or birth certificate" },
  { name: "OKU", percent: 50, proof: "your OKU card" },
];

/**
 * Concession prices (lib/concessions.ts): student, senior, child or OKU, as a
 * share off. Customers pick one at booking and show proof at the counter; the
 * proof is looked at, never kept.
 */
export function ConcessionsEditor({ venueId }: { venueId: number }) {
  const [list, setList] = useState<Concession[] | null>(null);
  const [form, setForm] = useState({ name: "", percent: "20", proof: "", sport: "", offPeakOnly: false });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/concessions?venueId=${venueId}`, { cache: "no-store" });
    const data = await res.json();
    if (res.ok) setList(data.concessions);
  }, [venueId]);
  useEffect(() => {
    void load();
  }, [load]);

  async function add() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/concessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ venueId, ...form, percent: Number(form.percent), sport: form.sport || null }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not save");
      setForm({ name: "", percent: "20", proof: "", sport: "", offPeakOnly: false });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  async function withdraw(c: Concession) {
    if (!window.confirm(`Stop offering the ${c.name} price? Bookings already made keep theirs.`)) return;
    const res = await fetch(`/api/admin/concessions?venueId=${venueId}&id=${c.id}`, { method: "DELETE" });
    if (!res.ok) setError((await res.json()).error ?? "Could not withdraw it");
    await load();
  }

  if (!list) return null;
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 text-sm shadow-sm">
      <h3 className="font-semibold">Concession prices</h3>
      <p className="mt-1 text-xs text-slate-500">
        A lower price for students, seniors, children or OKU. Customers pick it when booking and show proof at the counter; your
        staff press <em>Proof seen</em> or <em>No proof</em>, and without proof the full price is charged. Nothing is photographed
        or stored: only that someone saw it, and until when not to ask again. One discount at a time, so not with a promo code or
        a last-minute price.
      </p>
      {list.length > 0 && (
        <ul className="mt-3 space-y-1">
          {list.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{c.name}</span>
              <span className="text-slate-600">
                {c.percent}% off{c.sport ? `, ${SPORT_LABELS[c.sport]} only` : ""}
                {c.offPeakOnly ? ", off-peak only" : ""} · bring {c.proof}
              </span>
              <button onClick={() => void withdraw(c)} className="text-xs font-semibold text-red-600 underline">
                Withdraw
              </button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 flex flex-wrap gap-1.5">
        {PRESETS.filter((p) => !list.some((c) => c.name === p.name)).map((p) => (
          <button
            key={p.name}
            onClick={() => setForm({ ...form, name: p.name, percent: String(p.percent), proof: p.proof })}
            className="rounded-full border border-slate-300 px-2.5 py-0.5 text-xs"
          >
            + {p.name}
          </button>
        ))}
      </div>
      <div className="mt-2 flex flex-wrap items-end gap-2">
        <label className="text-xs text-slate-600">
          Name
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            placeholder="Student"
            className="mt-1 block w-36 rounded-md border border-slate-300 px-2 py-1 text-sm"
          />
        </label>
        <label className="text-xs text-slate-600">
          % off
          <input
            type="number"
            min={5}
            max={100}
            value={form.percent}
            onChange={(e) => setForm({ ...form, percent: e.target.value })}
            className="mt-1 block w-16 rounded-md border border-slate-300 px-2 py-1 text-sm"
          />
        </label>
        <label className="text-xs text-slate-600">
          They bring
          <input
            value={form.proof}
            onChange={(e) => setForm({ ...form, proof: e.target.value })}
            placeholder="your student card"
            className="mt-1 block w-48 rounded-md border border-slate-300 px-2 py-1 text-sm"
          />
        </label>
        <label className="text-xs text-slate-600">
          Sport
          <select
            value={form.sport}
            onChange={(e) => setForm({ ...form, sport: e.target.value })}
            className="mt-1 block rounded-md border border-slate-300 px-2 py-1 text-sm"
          >
            <option value="">Every sport</option>
            {SPORTS.map((s) => (
              <option key={s} value={s}>
                {SPORT_LABELS[s]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-1.5 pb-1.5 text-xs text-slate-600">
          <input type="checkbox" checked={form.offPeakOnly} onChange={(e) => setForm({ ...form, offPeakOnly: e.target.checked })} />
          Off-peak only
        </label>
        <button
          disabled={busy || form.name.trim() === ""}
          onClick={() => void add()}
          className="rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
        >
          Offer it
        </button>
      </div>
      {error && <p className="mt-2 text-sm font-medium text-red-700">{error}</p>}
    </section>
  );
}
