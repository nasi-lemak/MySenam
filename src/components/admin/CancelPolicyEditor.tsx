"use client";

import { useEffect, useState } from "react";
import type { CancelPolicy } from "@/lib/cancel-policy";

/**
 * What a late cancellation or a no-show costs here: whether customers may
 * still cancel online after the cutoff, for a share of the price, and how
 * many strikes before a number pays online to book.
 */
export function CancelPolicyEditor({ venueId }: { venueId: number }) {
  const [policy, setPolicy] = useState<CancelPolicy | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setPolicy(null);
    void fetch(`/api/admin/cancel-policy?venueId=${venueId}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { policy?: CancelPolicy }) => setPolicy(d.policy ?? null));
  }, [venueId]);

  async function save() {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/cancel-policy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ venueId, ...policy }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not save");
      setPolicy(data.policy);
      setNotice("Saved.");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  if (!policy) return null;
  const input = "w-16 rounded-md border border-slate-300 px-2 py-1 text-sm";
  const num = (v: string) => (v === "" ? null : Number(v));
  return (
    <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4 text-sm">
      <h3 className="font-semibold">Late cancellations and no-shows</h3>
      <p className="mt-1 text-xs text-slate-500">
        Before the cancel cutoff a customer always gets everything back. After it, by default, they cannot cancel online
        and have to call you.
      </p>
      <label className="mt-3 flex flex-wrap items-center gap-2">
        <input
          type="checkbox"
          checked={policy.lateKeep !== null}
          onChange={(e) => setPolicy({ ...policy, lateKeep: e.target.checked ? 50 : null })}
        />
        Let customers cancel late online, and keep
        <input
          type="number"
          min={0}
          max={100}
          aria-label="Percent kept"
          disabled={policy.lateKeep === null}
          value={policy.lateKeep ?? ""}
          onChange={(e) => setPolicy({ ...policy, lateKeep: num(e.target.value) })}
          className={input}
        />
        % of what they paid
      </label>
      <p className="ml-6 text-xs text-slate-500">The rest goes back the way they paid, with a credit note for it.</p>
      <label className="mt-3 flex flex-wrap items-center gap-2">
        <input
          type="checkbox"
          checked={policy.strikeLimit !== null}
          onChange={(e) => setPolicy({ ...policy, strikeLimit: e.target.checked ? 3 : null })}
        />
        After
        <input
          type="number"
          min={1}
          max={20}
          aria-label="Strikes"
          disabled={policy.strikeLimit === null}
          value={policy.strikeLimit ?? ""}
          onChange={(e) => setPolicy({ ...policy, strikeLimit: num(e.target.value) })}
          className={input}
        />
        no-shows or unpaid late cancellations in
        <input
          type="number"
          min={7}
          max={365}
          aria-label="Days"
          disabled={policy.strikeLimit === null}
          value={policy.strikeDays}
          onChange={(e) => setPolicy({ ...policy, strikeDays: Number(e.target.value) })}
          className={input}
        />
        days, a number must pay online to book
      </label>
      <p className="ml-6 text-xs text-slate-500">
        If you take no payment online, they book at the counter instead. Staff bookings are never refused.
      </p>
      <button
        disabled={busy}
        onClick={save}
        className="mt-3 rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
      >
        Save
      </button>
      {error && <p className="mt-2 text-xs font-medium text-red-700">{error}</p>}
      {notice && <p className="mt-2 text-xs text-emerald-700">{notice}</p>}
    </div>
  );
}
