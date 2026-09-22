"use client";

import { useEffect, useState } from "react";
import { Pass, SPORT_ICONS, SPORT_LABELS } from "@/lib/types";

/** The signed-in customer's multi-visit passes. */
export default function MyPasses() {
  const [passes, setPasses] = useState<Pass[] | null>(null);

  useEffect(() => {
    fetch("/api/my/passes", { cache: "no-store" })
      .then((res) => (res.ok ? res.json() : null))
      .then((data) => setPasses(data?.passes ?? []))
      .catch(() => setPasses([]));
  }, []);

  if (passes === null || passes.length === 0) return null;

  return (
    <section>
      <h2 className="text-lg font-bold">My passes</h2>
      <p className="mt-1 text-sm text-slate-500">
        One entry covers one booked hour. Pick a pass on the booking form, or quote its code at
        the counter.
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {passes.map((pass) => {
          const used = pass.entries - pass.remaining;
          const pct = pass.entries > 0 ? Math.round((pass.remaining / pass.entries) * 100) : 0;
          return (
            <div
              key={pass.id}
              className={`rounded-xl border p-4 shadow-sm ${
                pass.unusableReason
                  ? "border-slate-200 bg-slate-50"
                  : "border-teal-200 bg-white"
              }`}
            >
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="font-semibold">{pass.name}</div>
                  <div className="text-xs text-slate-500">
                    {pass.venueName} ·{" "}
                    {pass.sport
                      ? `${SPORT_ICONS[pass.sport]} ${SPORT_LABELS[pass.sport]}`
                      : "any sport"}
                  </div>
                </div>
                <span className="whitespace-nowrap font-mono text-xs font-semibold text-slate-500">
                  {pass.code}
                </span>
              </div>

              <div className="mt-3">
                <div className="flex items-baseline justify-between text-sm">
                  <span>
                    <span className="text-2xl font-bold text-teal-700">{pass.remaining}</span>
                    <span className="text-slate-500"> of {pass.entries} left</span>
                  </span>
                  <span className="text-xs text-slate-400">{used} used</span>
                </div>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-200">
                  <div
                    className="h-full rounded-full bg-teal-500"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>

              <p className="mt-3 text-xs text-slate-500">
                {pass.unusableReason ?? `Valid until ${pass.expiresOn}`}
              </p>
            </div>
          );
        })}
      </div>
    </section>
  );
}
