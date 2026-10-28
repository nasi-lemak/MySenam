"use client";

import { readJson } from "@/lib/read-response";
import { activityIcon } from "@/lib/activity-registry";
import { useEffect, useState } from "react";
import { Pass } from "@/lib/types";
import { useT } from "@/components/Language";
import { sportLabel } from "@/lib/i18n";
import { lengthLabel } from "@/lib/length-label";

/** The signed-in customer's multi-visit passes. */
export default function MyPasses() {
  const t = useT();
  const [passes, setPasses] = useState<Pass[] | null>(null);

  useEffect(() => {
    fetch("/api/my/passes", { cache: "no-store" })
      .then((res) => (res.ok ? readJson(res) : null))
      .then((data) => setPasses(data?.passes ?? []))
      .catch(() => setPasses([]));
  }, []);

  if (passes === null) return null;

  // Shown even with nothing to list: a pass bought at the counter and never
  // linked is invisible here, and silence would read as "it was not sold".
  if (passes.length === 0)
    return (
      <section>
        <h2 className="text-lg font-bold">{t("passes.title")}</h2>
        <p className="mt-1 text-sm text-slate-500">{t("passes.counterNote")}</p>
      </section>
    );

  return (
    <section>
      <h2 className="text-lg font-bold">{t("passes.title")}</h2>
      <p className="mt-1 text-sm text-slate-500">
        {t("passes.intro")}
      </p>
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {passes.map((pass) => {
          // A time pass counts court time; a session pass, entries.
          const amount = (n: number) => (pass.kind === "time" ? lengthLabel(t, n) : String(n));
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
                      ? `${activityIcon(pass.sport)} ${sportLabel(t, pass.sport)}`
                      : t("passes.anySport")}
                  </div>
                </div>
                <span className="whitespace-nowrap font-mono text-xs font-semibold text-slate-500">
                  {pass.code}
                </span>
              </div>

              <div className="mt-3">
                <div className="flex items-baseline justify-between text-sm">
                  <span>
                    <span className="text-2xl font-bold text-teal-700">{amount(pass.remaining)}</span>
                    <span className="text-slate-500">{t(pass.kind === "time" ? "passes.ofLeftTime" : "passes.ofLeft", { n: amount(pass.entries) })}</span>
                  </span>
                  <span className="text-xs text-slate-400">{t(pass.kind === "time" ? "passes.usedTime" : "passes.used", { n: amount(used) })}</span>
                </div>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-200">
                  <div
                    className="h-full rounded-full bg-teal-500"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              </div>

              <p className="mt-3 text-xs text-slate-500">
                {pass.unusableReason ?? t("passes.validUntil", { date: pass.expiresOn })}
              </p>
            </div>
          );
        })}
      </div>
    </section>
  );
}
