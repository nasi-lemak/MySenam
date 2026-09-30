"use client";

import { useEffect, useState } from "react";

/* ---------------- First run ---------------- */

/**
 * What an empty install says for itself.
 *
 * A fresh MySenam has venues and courts and nothing else, so every tab opens
 * blank and a newcomer has no idea which of the eight to start with. This
 * appears only while nothing has been sold — the moment a real booking exists
 * it is gone for good, which is also what stops demo customers ever appearing
 * in a working venue's day list.
 */
export function FirstRun({ onSeeded }: { onSeeded: () => void }) {
  const [empty, setEmpty] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ bookings: number; extras: string[] } | null>(null);

  useEffect(() => {
    fetch("/api/admin/demo", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : { empty: false }))
      .then((d) => setEmpty(d.empty === true))
      .catch(() => setEmpty(false));
  }, []);

  async function loadDemo() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/demo", { method: "POST" });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not load the demo data");
      setDone({ bookings: data.bookings, extras: data.extras });
      setEmpty(false);
      onSeeded();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the demo data");
    } finally {
      setBusy(false);
    }
  }

  if (done)
    return (
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3">
        <p className="text-sm font-semibold text-emerald-900">
          {done.bookings} bookings written across the last two weeks and the next two.
        </p>
        <p className="mt-1 text-sm text-emerald-800">
          Plus {done.extras.join(", ")}. Every tab has something in it now — start with{" "}
          <strong>Reports</strong> to see a month, or <strong>Bookings</strong> for today&apos;s desk.
        </p>
      </div>
    );

  if (empty !== true) return null;

  return (
    <div className="rounded-xl border border-teal-200 bg-teal-50/70 px-4 py-4">
      <h2 className="text-base font-bold text-teal-900">Nothing has been booked here yet</h2>
      <p className="mt-1 max-w-2xl text-sm text-teal-900/80">
        Every tab will look empty until somebody books something. Two ways forward, depending on
        why you are here.
      </p>

      <div className="mt-3 grid gap-3 md:grid-cols-2">
        <div className="rounded-lg border border-teal-200 bg-white p-3.5">
          <p className="text-sm font-semibold">Just looking?</p>
          <p className="mt-1 text-sm text-slate-600">
            Fill this install with a plausible fortnight — bookings across every sport, a class
            with a roster, passes, a membership, a promo code, arrivals and a no-show. Enough to
            see what each screen is for.
          </p>
          <button
            onClick={loadDemo}
            disabled={busy}
            className="mt-3 rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
          >
            {busy ? "Writing…" : "Load demo data"}
          </button>
          <p className="mt-2 text-xs text-slate-500">
            Offered only while this install is empty. Once a real booking exists it is refused, so
            invented customers cannot appear in a working day list.
          </p>
        </div>

        <div className="rounded-lg border border-slate-200 bg-white p-3.5">
          <p className="text-sm font-semibold">Setting up a real venue?</p>
          <ol className="mt-1 list-decimal space-y-1 pl-5 text-sm text-slate-600">
            <li>
              <strong>Venues &amp; staff</strong> — add your venue, its opening hours and its
              cancellation cutoff.
            </li>
            <li>
              <strong>Courts &amp; rates</strong> — add each court with its peak and off-peak
              price. A gym floor or pool takes a capacity above 1.
            </li>
            <li>
              <strong>Venues &amp; staff</strong> again — create a login for whoever works the
              counter, and change the password you signed in with.
            </li>
          </ol>
          <p className="mt-2 text-xs text-slate-500">
            The four demo venues that ship with MySenam can stay or go — they are only there so the
            first screen is not blank.
          </p>
        </div>
      </div>

      {error && <p className="mt-3 text-sm font-medium text-red-700">{error}</p>}
    </div>
  );
}
