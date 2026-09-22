"use client";

import { useCallback, useEffect, useState } from "react";
import {
  BUSYNESS_LABELS,
  Busyness,
  LiveOccupancy as Live,
  SPORT_ICONS,
} from "@/lib/types";

const REFRESH_MS = 30_000;

const BAR_STYLES: Record<Busyness, string> = {
  quiet: "bg-emerald-500",
  filling: "bg-amber-500",
  busy: "bg-orange-500",
  full: "bg-red-500",
};

const TEXT_STYLES: Record<Busyness, string> = {
  quiet: "text-emerald-700",
  filling: "text-amber-700",
  busy: "text-orange-700",
  full: "text-red-700",
};

/** Live "how busy is it right now", from door check-ins. */
export default function LiveOccupancy({ venueId }: { venueId: number }) {
  const [occupancy, setOccupancy] = useState<Live[] | null>(null);
  const [asOf, setAsOf] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/venues/${venueId}/live`, { cache: "no-store" });
      if (!res.ok) return;
      const data = await res.json();
      setOccupancy(data.occupancy);
      setAsOf(data.asOf);
    } catch {
      // A transient failure just leaves the last reading on screen.
    }
  }, [venueId]);

  useEffect(() => {
    load();
    const timer = setInterval(load, REFRESH_MS);
    return () => clearInterval(timer);
  }, [load]);

  // Only shared facilities have a meaningful headcount.
  const shared = (occupancy ?? []).filter((o) => o.capacity > 1);
  if (shared.length === 0) return null;

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">Here right now</h2>
        {asOf && (
          <span className="text-xs text-slate-400">
            live · updated{" "}
            {new Date(asOf).toLocaleTimeString("en-MY", {
              hour: "2-digit",
              minute: "2-digit",
              timeZone: "Asia/Kuala_Lumpur",
            })}
          </span>
        )}
      </div>
      <ul className="mt-3 space-y-3">
        {shared.map((o) => (
          <li key={o.courtId}>
            <div className="flex items-baseline justify-between text-sm">
              <span className="font-medium">
                {SPORT_ICONS[o.sport]} {o.courtName}
              </span>
              <span className={`font-semibold ${TEXT_STYLES[o.level]}`}>
                {BUSYNESS_LABELS[o.level]}
                <span className="ml-2 font-normal text-slate-500">
                  {o.present}/{o.capacity} in
                </span>
              </span>
            </div>
            <div className="mt-1 h-2 overflow-hidden rounded-full bg-slate-100">
              <div
                className={`h-full rounded-full transition-all ${BAR_STYLES[o.level]}`}
                style={{ width: `${Math.min(100, Math.round((o.present / o.capacity) * 100))}%` }}
              />
            </div>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-slate-400">
        Counted from check-ins at the front desk.
      </p>
    </section>
  );
}
