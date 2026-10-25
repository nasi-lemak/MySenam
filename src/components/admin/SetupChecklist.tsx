"use client";

import { useEffect, useState } from "react";
import { useStaffT } from "./StaffLanguage";

interface VenueSetup {
  venueId: number;
  courts: number;
  detailsChecked: boolean;
  testBooking: boolean;
  onlinePayment: boolean;
  photos: boolean;
  facilities: boolean;
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
  venueName,
  startOpen = true,
  refreshKey,
  onGo,
}: {
  venueId: number;
  /** Shown in full, or as one line to open — for the second branch on. */
  startOpen?: boolean;
  /** Shown when there is more than one branch to set up. */
  venueName?: string | null;
  /** Changes whenever something on the dashboard might have completed a step. */
  refreshKey: string;
  onGo: (tab: Tab) => void;
}) {
  const t = useStaffT();
  const [setup, setSetup] = useState<VenueSetup | null>(null);
  const [open, setOpen] = useState(startOpen);
  // Bumped when something is saved under Venue details ("setup:refresh"), which changes no tab or court count.
  const [saved, setSaved] = useState(0);

  useEffect(() => {
    const bump = () => setSaved((n) => n + 1);
    window.addEventListener("setup:refresh", bump);
    return () => window.removeEventListener("setup:refresh", bump);
  }, []);

  useEffect(() => {
    fetch(`/api/admin/setup?venueId=${venueId}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then(setSetup)
      .catch(() => setSetup(null));
  }, [venueId, refreshKey, saved]);

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
      title: t("set.courts.title"),
      body: t("set.courts.body"),
      actions: <Go onClick={() => onGo("courts")}>{t("sh.tab.courts")}</Go>,
    },
    {
      done: setup.detailsChecked,
      title: t("set.hours.title"),
      body: t("set.hours.body"),
      actions: (
        <>
          <Go onClick={() => onGo("venues")}>{t("sh.tab.venueDetails")}</Go>
          <button onClick={() => act("detailsChecked")} className="text-sm text-slate-500 underline hover:text-teal-700">
            {t("set.hoursRight")}
          </button>
        </>
      ),
    },
    {
      done: setup.testBooking,
      title: t("set.test.title"),
      body: t("set.test.body"),
      actions: (
        <a
          href={`/venue/${venueId}`}
          target="_blank"
          rel="noopener"
          className="inline-flex min-h-9 items-center rounded-md bg-teal-600 px-3 text-sm font-medium text-white hover:bg-teal-700"
        >
          {t("set.openPage")}
        </a>
      ),
    },
    {
      done: setup.onlinePayment,
      optional: true,
      title: t("set.pay.title"),
      body: t("set.pay.body"),
      actions: <Go onClick={() => onGo("venues")}>{t("sh.tab.venueDetails")}</Go>,
    },
    {
      done: setup.photos && setup.facilities,
      optional: true,
      title: t("set.photos.title"),
      body: t("set.photos.body"),
      actions: <Go onClick={() => onGo("venues")}>{t("sh.tab.venueDetails")}</Go>,
    },
  ];
  const left = steps.filter((s) => !s.done && !s.optional).length;

  return (
    <section className="rounded-xl border border-teal-200 bg-teal-50/60 p-5">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-semibold text-teal-900">{venueName ? t("set.titleNamed", { venue: venueName }) : t("set.title")}</h2>
        <span className="text-sm text-teal-800">
          {t.plural("set.stepsLeft", left)}
          {!open && (
            <button onClick={() => setOpen(true)} className="ml-3 font-medium underline">
              {t("c.show")}
            </button>
          )}
        </span>
      </div>
      {open && (
        <>
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
                <span className="sr-only">{step.done ? ` ${t("set.done")}` : ""}</span>
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
        {t("set.hide")}
      </button>
        </>
      )}
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
