"use client";

import { readJson } from "@/lib/read-response";
import { useEffect, useState } from "react";
import type { SchedulerHeartbeat, SystemAlert } from "@/lib/alerts";
import type { StaffT } from "@/lib/staff-i18n";
import { useStaffClock, useStaffT } from "./StaffLanguage";

/** A length of time since, as a staff member reads it: the largest whole unit. */
function ago(t: StaffT, seconds: number): string {
  if (seconds < 60) return t("vis.hb.ago.s", { n: seconds });
  if (seconds < 90 * 60) return t("vis.hb.ago.m", { n: Math.round(seconds / 60) });
  if (seconds < 48 * 3600) return t("vis.hb.ago.h", { n: Math.round(seconds / 3600) });
  return t("vis.hb.ago.d", { n: Math.round(seconds / 86400) });
}

/**
 * What has broken lately, for the platform owner, and one read-only line on the scheduler (lib/alerts.ts `schedulerHeartbeat`): healthy, stale,
 * never stamped, just started, or switched off. The line is always there, so a scheduler that has gone quiet is a red line and not an absence.
 * The same news also went by email.
 */
export function SystemHealth() {
  const t = useStaffT();
  const clock = useStaffClock();
  const [state, setState] = useState<{ alerts: SystemAlert[]; scheduler: { enabled: boolean; alive: boolean; heartbeat?: SchedulerHeartbeat } } | null>(null);

  useEffect(() => {
    void fetch("/api/admin/system", { cache: "no-store" })
      .then((r) => (r.ok ? readJson(r) : null))
      .then(setState)
      .catch(() => setState(null));
  }, []);

  if (!state) return null;
  const stalled = state.scheduler.enabled && !state.scheduler.alive;
  const hb = state.scheduler.heartbeat;
  const quiet = !!hb && hb.state !== "healthy" && hb.state !== "off";

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

  const heartbeatLine = hb && (
    <p className={`mt-1 ${hb.state === "healthy" ? "text-emerald-800" : hb.state === "starting" ? "text-amber-800" : "font-semibold"}`} data-testid="scheduler-heartbeat" data-state={hb.state}>
      {t("vis.hb.label")}:{" "}
      {hb.state === "healthy" || hb.state === "stale"
        ? t(hb.state === "healthy" ? "vis.hb.healthy" : "vis.hb.stale", { ago: ago(t, hb.ageSeconds ?? 0), when: clock.when(hb.lastAt ?? "") })
        : t(`vis.hb.${hb.state}`)}
      {hb.lastFailure && (
        <span className="block font-normal">
          {t("vis.hb.failure", { what: t.say(hb.lastFailure.subjectPhrase, hb.lastFailure.subject), when: clock.when(hb.lastFailure.at), n: hb.lastFailure.count })}
        </span>
      )}
      {(quiet || state.alerts.length > 0 || !!hb.lastFailure) && <span className="block text-xs font-normal">{t("vis.hb.where")}</span>}
    </p>
  );

  // Nothing wrong and the scheduler healthy (or off by choice): a slim line, not a warning box.
  if (state.alerts.length === 0 && !stalled && !quiet && !hb?.lastFailure)
    return hb ? <section className="rounded-xl border border-slate-200 bg-white px-4 py-2 text-sm">{heartbeatLine}</section> : null;

  return (
    <section className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-900">
      <h2 className="font-bold">⚠ {t("sys.title")}</h2>
      {heartbeatLine}
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
