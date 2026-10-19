"use client";

import { useEffect, useState } from "react";
import type { HoldPolicy } from "@/lib/holds";

/**
 * Ask for payment online to hold a booking: the answer to slots lost to
 * people who never come. Off, a booking stands unpaid until the counter.
 */
export function HoldPolicyEditor({ venueId, canPayOnline }: { venueId: number; canPayOnline: boolean }) {
  const [policy, setPolicy] = useState<HoldPolicy | null>(null);
  const [minutes, setMinutes] = useState("15");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setPolicy(null);
    void fetch(`/api/admin/hold-policy?venueId=${venueId}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { policy?: HoldPolicy }) => {
        if (!d.policy) return;
        setPolicy(d.policy);
        setMinutes(String(d.policy.minutes));
      });
  }, [venueId, canPayOnline]);

  async function save(on: boolean) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/hold-policy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ venueId, on, minutes: Number(minutes) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not save");
      setPolicy(data.policy);
      setNotice(on ? `Online bookings are now held ${data.policy.minutes} minutes for payment.` : "Bookings stand unpaid until the counter again.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  if (!policy) return null;
  return (
    <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4 text-sm">
      <h3 className="font-semibold">Pay online to hold a booking</h3>
      <p className="mt-1 text-xs text-slate-500">
        For no-shows. A customer booking online must pay online within the time below, or the booking is let go for somebody
        else and they are not charged. Paid, it stands, and they get the confirmation. Your staff booking at the counter, and
        anything paid from credit, a pass or free, are never held.
      </p>
      {!canPayOnline && <p className="mt-2 text-xs font-medium text-amber-700">Set up taking payment online above first.</p>}
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2">
          Hold for
          <input
            type="number"
            min={5}
            max={60}
            value={minutes}
            onChange={(e) => setMinutes(e.target.value)}
            className="w-16 rounded-md border border-slate-300 px-2 py-1"
          />
          minutes
        </label>
        {policy.on ? (
          <>
            <button disabled={busy} onClick={() => save(true)} className="rounded-md border border-slate-300 px-3 py-1.5 text-xs font-semibold">
              Save
            </button>
            <button disabled={busy} onClick={() => save(false)} className="rounded-md border border-red-300 px-3 py-1.5 text-xs font-semibold text-red-600">
              Turn off
            </button>
          </>
        ) : (
          <button
            disabled={busy || !canPayOnline}
            onClick={() => save(true)}
            className="rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
          >
            Turn on
          </button>
        )}
        <span className={`text-xs font-semibold ${policy.active ? "text-emerald-700" : "text-slate-500"}`}>
          {policy.active ? "On" : policy.on ? "On, but no way to pay online" : "Off"}
        </span>
      </div>
      {error && <p className="mt-2 text-sm font-medium text-red-700">{error}</p>}
      {notice && <p className="mt-2 text-sm font-medium text-emerald-700">{notice}</p>}
    </div>
  );
}
