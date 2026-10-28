"use client";

import { readJson } from "@/lib/read-response";
import { useEffect, useState } from "react";
import type { SystemAlert } from "@/lib/alerts";
import { useStaffClock, useStaffT } from "./StaffLanguage";

/**
 * What has broken lately, for the platform owner: shown only when something
 * has, or the scheduler has stopped. The same news also went by email.
 */
export function SystemHealth() {
  const t = useStaffT();
  const clock = useStaffClock();
  const [state, setState] = useState<{ alerts: SystemAlert[]; scheduler: { enabled: boolean; alive: boolean } } | null>(null);

  useEffect(() => {
    void fetch("/api/admin/system", { cache: "no-store" })
      .then((r) => (r.ok ? readJson(r) : null))
      .then(setState)
      .catch(() => setState(null));
  }, []);

  if (!state) return null;
  const stalled = state.scheduler.enabled && !state.scheduler.alive;
  if (state.alerts.length === 0 && !stalled) return null;

  async function clear(key: string) {
    const res = await fetch("/api/admin/system", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    });
    if (res.ok) {
      const data = await readJson(res);
      setState((s) => (s ? { ...s, alerts: data.alerts } : s));
    }
  }

  return (
    <section className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
      <h2 className="font-bold">⚠ {t("sys.title")}</h2>
      {stalled && <p className="mt-1">{t("sys.stalled")}</p>}
      <ul className="mt-2 space-y-2">
        {state.alerts.map((a) => (
          <li key={a.key} className="rounded-lg bg-white/70 px-3 py-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2">
              <span className="font-semibold">
                {t.say(a.subjectPhrase, a.subject)} <span className="font-normal text-red-700">
                  · {t("sys.countLast", { n: a.count, date: clock.day(a.lastAt), time: clock.time(a.lastAt) })}
                </span>
              </span>
              <button onClick={() => clear(a.key)} className="text-xs font-semibold text-red-800 underline">
                {t("sys.dealtWith")}
              </button>
            </div>
            {/* An error's own text stays as it came; what MySenam wrote, in the staff language. */}
            {a.lastDetail && (
              <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap text-xs text-red-800">
                {a.detailPhrases ? a.detailPhrases.map((p) => t.say(p)).join("\n") : a.lastDetail}
              </pre>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
