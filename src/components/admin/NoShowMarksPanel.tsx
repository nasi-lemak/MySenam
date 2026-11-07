"use client";

import { useCallback, useEffect, useState } from "react";
import { readJson } from "@/lib/read-response";
import type { FlaggedHost, MarkView } from "@/lib/no-show-marks";
import { formatHour } from "@/lib/time";
import { useStaffT } from "./StaffLanguage";

/**
 * Hosts' no-show marks in open games, for a manager (their own venues') or the platform owner (all; `/api/admin/no-show-marks`,
 * lib/no-show-marks.ts, ADR 0072): the answers players made, waiting for a decision, and every mark of the last 90 days. A decision is
 * taking the mark off, letting it stand, or (the owner's alone) making it count at every venue, each with a written note that is kept;
 * the player is told by email.
 */
export function NoShowMarksPanel() {
  const t = useStaffT();
  const [tab, setTab] = useState<"review" | "recent">("review");
  const [marks, setMarks] = useState<MarkView[] | null>(null);
  const [hosts, setHosts] = useState<FlaggedHost[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (which: "review" | "recent") => {
      setError(null);
      const res = await fetch(`/api/admin/no-show-marks?show=${which}`, { cache: "no-store" });
      const out = await readJson(res).catch(() => null);
      if (!res.ok) return setError(t.err(out, t("ppls.ns.loadFailed")));
      setMarks(out?.marks ?? []);
      setHosts(out?.hosts ?? []);
    },
    [t]
  );
  useEffect(() => {
    void load(tab);
  }, [load, tab]);

  async function decide(m: MarkView, decision: "reverse" | "uphold" | "platform") {
    const note = window.prompt(decision === "platform" ? t("ppls.ns.promptPlatform") : t("ppls.ns.promptNote"));
    if (note === null) return;
    setError(null);
    const res = await fetch("/api/admin/no-show-marks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: m.id, decision, note }),
    });
    const out = await readJson(res).catch(() => null);
    if (!res.ok) return setError(t.err(out, t("ppls.ns.failed")));
    await load(tab);
    window.dispatchEvent(new Event("attention:refresh"));
  }

  const when = (m: MarkView) => `${m.date} ${formatHour(m.startHour, t.locale)}`;
  const button = "rounded-md border px-2 py-0.5 text-xs font-semibold";
  return (
    <details className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm" data-testid="no-show-marks-panel">
      <summary className="cursor-pointer font-semibold text-slate-800">{t("ppls.ns.title")}</summary>
      <p className="mt-2 text-slate-600">{t("ppls.ns.intro")}</p>
      <div className="mt-2 flex flex-wrap gap-2" role="group" aria-label={t("ppls.ns.title")}>
        {(["review", "recent"] as const).map((w) => (
          <button
            key={w}
            type="button"
            aria-pressed={tab === w}
            onClick={() => setTab(w)}
            className={`rounded-full px-3 py-1 text-xs font-medium ${tab === w ? "bg-teal-600 text-white" : "bg-white text-slate-600 ring-1 ring-slate-200 hover:ring-teal-400"}`}
          >
            {w === "review" ? t("ppls.ns.tabReview") : t("ppls.ns.tabRecent")}
          </button>
        ))}
      </div>
      {error && <p className="mt-2 text-red-600">{error}</p>}
      {hosts.map((h) => (
        <p key={h.hostId} className="mt-2 text-amber-900">
          {t("ppls.ns.host", { name: h.name, marked: h.marked, reversed: h.reversed })}
        </p>
      ))}
      {marks && marks.length === 0 && <p className="mt-3 text-slate-500">{t("ppls.ns.none")}</p>}
      <ul className="mt-3 space-y-2">
        {(marks ?? []).map((m) => (
          <li key={m.id} className="rounded-lg border border-slate-200 px-3 py-2" data-testid={`mark-${m.id}`}>
            <div className="font-medium">{t("ppls.ns.line", { player: m.playerName, venue: m.venueName, when: when(m), host: m.hostName })}</div>
            <div>{m.reason ? t("ppls.ns.reason", { reason: m.reason }) : t("ppls.ns.noReason")}</div>
            <div className="text-slate-600">
              {t(`ppls.ns.status.${m.status}`)} · {t(`ppls.ns.scope.${m.scope}`)}
            </div>
            {m.answer && <div>{t("ppls.ns.answer", { answer: m.answer })}</div>}
            {m.waitingDays !== null && <div className="text-slate-600">{t("ppls.ns.waiting", { days: m.waitingDays })}</div>}
            {m.reviewedAt && m.reviewNote && <div className="text-slate-600">{t("ppls.ns.decided", { by: m.reviewedBy ?? "", date: m.reviewedAt.slice(0, 10), note: m.reviewNote })}</div>}
            {m.platformNote && <div className="text-slate-600">{t("ppls.ns.platformWhy", { note: m.platformNote })}</div>}
            <div className="mt-1 flex flex-wrap gap-2">
              {m.may.reverse && (
                <button type="button" onClick={() => void decide(m, "reverse")} className={`${button} border-red-300 text-red-700 hover:bg-red-50`}>
                  {t("ppls.ns.reverse")}
                </button>
              )}
              {m.may.uphold && (
                <button type="button" onClick={() => void decide(m, "uphold")} className={`${button} border-teal-600 text-teal-700 hover:bg-teal-50`}>
                  {t("ppls.ns.uphold")}
                </button>
              )}
              {m.may.platform && (
                <button type="button" onClick={() => void decide(m, "platform")} className={`${button} border-slate-400 text-slate-700 hover:bg-slate-50`}>
                  {t("ppls.ns.platform")}
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </details>
  );
}
