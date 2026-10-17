"use client";

import { useEffect, useState } from "react";

interface VenueSetup {
  venueId: number;
  courts: number;
  detailsChecked: boolean;
  testBooking: boolean;
  onlinePayment: boolean;
  dismissed: boolean;
  complete: boolean;
}

type Tab = "courts" | "venues" | "bookings";

/**
 * Where a newly approved venue starts.
 *
 * Without it, the first thing an owner saw was an empty day list and eight
 * tabs. This says what to do, in order, and ticks itself off from what the
 * venue has actually done. It goes once the three required steps are done, or
 * when the owner says they know their way round.
 */
export function SetupChecklist({
  venueId,
  refreshKey,
  onGo,
}: {
  venueId: number;
  /** Changes whenever something on the dashboard might have completed a step. */
  refreshKey: string;
  onGo: (tab: Tab) => void;
}) {
  const [setup, setSetup] = useState<VenueSetup | null>(null);

  useEffect(() => {
    fetch(`/api/admin/setup?venueId=${venueId}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then(setSetup)
      .catch(() => setSetup(null));
  }, [venueId, refreshKey]);

  async function act(action: "detailsChecked" | "dismiss") {
    const res = await fetch("/api/admin/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ venueId, action }),
    });
    if (res.ok) setSetup(await res.json());
  }

  if (!setup || setup.dismissed || setup.complete) return null;

  const steps: { done: boolean; title: string; body: string; actions: React.ReactNode; optional?: boolean }[] = [
    {
      done: setup.courts > 0,
      title: "Add your courts and rates",
      body: "Customers can find your venue once it has its first court. Add each court, room or lane, with its off-peak and peak rate per hour.",
      actions: <Go onClick={() => onGo("courts")}>Courts &amp; rates</Go>,
    },
    {
      done: setup.detailsChecked,
      title: "Check your opening hours",
      body: "New venues open 8 am to 11 pm. Change the hours, address, phone and how late customers may cancel under Venue details.",
      actions: (
        <>
          <Go onClick={() => onGo("venues")}>Venue details</Go>
          <button onClick={() => act("detailsChecked")} className="text-sm text-slate-500 underline hover:text-teal-700">
            They are right as they are
          </button>
        </>
      ),
    },
    {
      done: setup.testBooking,
      title: "Make a test booking",
      body: "Book a slot on your own page to see what customers see. It then appears under Bookings, where you can cancel it.",
      actions: (
        <a
          href={`/venue/${venueId}`}
          target="_blank"
          rel="noopener"
          className="inline-flex min-h-9 items-center rounded-md bg-teal-600 px-3 text-sm font-medium text-white hover:bg-teal-700"
        >
          Open your booking page ↗
        </a>
      ),
    },
    {
      done: setup.onlinePayment,
      optional: true,
      title: "Take payment online",
      body: "Optional. Customers can pay at the counter as they are. To take FPX and cards, connect your Billplz account under Venue details.",
      actions: <Go onClick={() => onGo("venues")}>Venue details</Go>,
    },
  ];
  const left = steps.filter((s) => !s.done && !s.optional).length;

  return (
    <section className="rounded-xl border border-teal-200 bg-teal-50/60 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold text-teal-900">Set up your venue</h2>
        <span className="text-sm text-teal-800">
          {left === 1 ? "1 step to go" : `${left} steps to go`}
        </span>
      </div>
      <ol className="mt-3 space-y-3">
        {steps.map((step, i) => (
          <li key={step.title} className="flex gap-3">
            <span
              aria-hidden
              className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs font-bold ${
                step.done ? "bg-teal-600 text-white" : "bg-white text-teal-700 ring-1 ring-teal-300"
              }`}
            >
              {step.done ? "✓" : i + 1}
            </span>
            <div className="min-w-0">
              <p className={`font-medium ${step.done ? "text-slate-500 line-through" : "text-slate-900"}`}>
                {step.title}
                <span className="sr-only">{step.done ? " (done)" : ""}</span>
              </p>
              {!step.done && (
                <>
                  <p className="mt-0.5 text-sm text-slate-600">{step.body}</p>
                  <div className="mt-2 flex flex-wrap items-center gap-3">{step.actions}</div>
                </>
              )}
            </div>
          </li>
        ))}
      </ol>
      <button
        onClick={() => act("dismiss")}
        className="mt-4 text-xs text-slate-500 underline hover:text-teal-700"
      >
        Hide this; I know my way round
      </button>
    </section>
  );
}

function Go({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="inline-flex min-h-9 items-center rounded-md bg-teal-600 px-3 text-sm font-medium text-white hover:bg-teal-700"
    >
      {children}
    </button>
  );
}
