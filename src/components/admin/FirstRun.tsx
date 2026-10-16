"use client";

import { useEffect, useState } from "react";

/* ---------------- First run ---------------- */

interface DemoState {
  empty: boolean;
  seededOn: string | null;
  runsTo: string | null;
  stale: boolean;
  refreshable: boolean;
}

/** A yyyy-mm-dd as a Malaysian would read it. */
function readable(date: string): string {
  return new Date(`${date}T00:00:00+08:00`).toLocaleDateString("en-MY", {
    day: "numeric",
    month: "short",
    year: "numeric",
    timeZone: "Asia/Kuala_Lumpur",
  });
}

/**
 * What an empty install — or a demo that has aged out — says for itself.
 *
 * A fresh MySenam has venues and courts and nothing else, so every tab opens
 * blank and a newcomer has no idea which of the eight to start with. The offer
 * to fill it appears only while nothing has been sold — the moment a real
 * booking exists it is gone for good, which is also what stops demo customers
 * ever appearing in a working venue's day list.
 *
 * The demo is written against the day it was loaded, so it runs out. When it
 * does, this offers to move it onto today instead of leaving somebody looking
 * at an empty day list and concluding the software does not work.
 */
export function FirstRun({ onSeeded }: { onSeeded: () => void }) {
  const [state, setState] = useState<DemoState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<{ bookings: number; extras: string[] } | null>(null);
  // A reload throws data away. Cheap to confirm, expensive to mis-click.
  const [confirming, setConfirming] = useState(false);

  useEffect(() => {
    fetch("/api/admin/demo", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => setState(d))
      .catch(() => setState(null));
  }, []);

  async function loadDemo(refresh = false) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/demo", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not load the demo data");
      setDone({ bookings: data.bookings, extras: data.extras });
      setState(null);
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

  if (state?.stale && state.refreshable)
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3.5">
        <h2 className="text-base font-bold text-amber-900">This demo has run out</h2>
        <p className="mt-1 max-w-2xl text-sm text-amber-900/85">
          It was written on {state.seededOn ? readable(state.seededOn) : "an earlier day"} and only
          has bookings up to {state.runsTo ? readable(state.runsTo) : "a date now past"}, so
          today&apos;s desk list opens empty. Reloading writes the same fortnight again, around
          today.
        </p>
        {confirming ? (
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <button
              onClick={() => loadDemo(true)}
              disabled={busy}
              className="rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
            >
              {busy ? "Rewriting…" : "Yes — clear it and write today's"}
            </button>
            <button
              onClick={() => setConfirming(false)}
              disabled={busy}
              className="rounded-lg px-3 py-2 text-sm font-medium text-amber-900 underline disabled:opacity-50"
            >
              Leave it alone
            </button>
          </div>
        ) : (
          <button
            onClick={() => setConfirming(true)}
            className="mt-3 rounded-lg bg-amber-600 px-4 py-2 text-sm font-semibold text-white hover:bg-amber-700"
          >
            Reload the demo onto today
          </button>
        )}
        <p className="mt-2 text-xs text-amber-900/70">
          This clears every booking, customer, pass and class first. It is offered only because
          every one of them was invented by the seeder — the first real booking withdraws it for
          good.
        </p>
        {error && <p className="mt-3 text-sm font-medium text-red-700">{error}</p>}
      </div>
    );

  if (state?.empty !== true) return null;

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
            onClick={() => loadDemo()}
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
            The four demo venues a new install starts with can stay or go — they are only there so the
            first screen is not blank.
          </p>
        </div>
      </div>

      {error && <p className="mt-3 text-sm font-medium text-red-700">{error}</p>}
    </div>
  );
}
