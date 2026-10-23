"use client";

import { useEffect, useState } from "react";

/**
 * Whether a venue's sports are booked by the hour or the half hour, unless a
 * sport has its own (Rules by sport). Rates stay per hour; a half hour costs half.
 */
export function SlotLengthEditor({ venueId }: { venueId: number }) {
  const [minutes, setMinutes] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setMinutes(null);
    void fetch(`/api/admin/slot-length?venueId=${venueId}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { slotMinutes?: number }) => setMinutes(d.slotMinutes ?? 60));
  }, [venueId]);

  async function choose(next: 30 | 60) {
    if (next === minutes) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/slot-length", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ venueId, minutes: next }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not save");
      setMinutes(data.slotMinutes);
      setNotice(
        next === 30
          ? "Saved. Sports without their own rule are now booked by the half hour; bookings already made are unchanged."
          : "Saved. Sports without their own rule are booked by the hour again; bookings already made are unchanged."
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  if (minutes === null) return null;
  const option = (value: 30 | 60, label: string) => (
    <button
      type="button"
      disabled={busy}
      aria-pressed={minutes === value}
      onClick={() => choose(value)}
      className={`rounded-md border px-3 py-1.5 text-xs font-semibold disabled:opacity-50 ${
        minutes === value ? "border-teal-600 bg-teal-50 text-teal-800" : "border-slate-300 text-slate-600"
      }`}
    >
      {label}
    </button>
  );
  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 text-sm shadow-sm">
      <h3 className="font-semibold">Booked by</h3>
      <p className="mt-1 text-xs text-slate-500">
        By the hour, or by the half hour (18:00, 18:30, 19:00…), for every sport here unless Rules by sport gives it its own
        (padel is by the half hour unless told otherwise). Rates stay per hour, so a half hour costs half. Classes and
        tournaments stay on the hour.
      </p>
      <div className="mt-2 flex gap-2">
        {option(60, "The hour")}
        {option(30, "The half hour")}
      </div>
      {error && <p className="mt-2 text-xs font-medium text-red-700">{error}</p>}
      {notice && <p className="mt-2 text-xs text-emerald-700">{notice}</p>}
    </section>
  );
}
