"use client";

import { readJson } from "@/lib/read-response";
import { useState } from "react";
import type { IntegrityProblem } from "@/lib/integrity";
import type { ManagedVenue } from "./shared";
import { useStaffClock, useStaffT } from "./StaffLanguage";

/**
 * Ask now whether bookings and the court time they hold agree, and whether
 * refunds are stuck (`GET /api/admin/integrity`, lib/integrity.ts): the same
 * check the scheduler makes once a day and raises as an alert, to run again
 * after putting something right (docs/operations/monitoring.md). The
 * platform owner's covers every venue; a manager's (`own`) only their own
 * venues, which the server decides.
 */
export function IntegrityCheck({ venues, own = false }: { venues: ManagedVenue[]; own?: boolean }) {
  const t = useStaffT();
  const clock = useStaffClock();
  const [problems, setProblems] = useState<IntegrityProblem[] | null>(null);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function check() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/admin/integrity", { cache: "no-store" });
      const data = await readJson(res).catch(() => null);
      if (!res.ok) throw new Error(t.err(data, t("ow5.int.failed")));
      setProblems((data?.problems ?? []) as IntegrityProblem[]);
      setCheckedAt(new Date());
    } catch (err) {
      setError(err instanceof Error ? err.message : t("ow5.int.failed"));
    } finally {
      setBusy(false);
    }
  }

  const venueName = (id: number) => (id === 0 ? t("ow5.int.noVenue") : venues.find((v) => v.id === id)?.name ?? t("ow5.int.venue", { id }));

  return (
    <details className="rounded-xl border border-slate-200 bg-white px-4 py-3 text-sm">
      <summary className="cursor-pointer font-semibold text-slate-800">
        {t("ow5.int.title")}
        {problems && problems.length > 0 && (
          <span className="font-normal text-red-700">
            {" · "}
            {t.plural("ow5.int.found", problems.length)}
          </span>
        )}
      </summary>
      <p className="mt-2 text-slate-600">{t("ow5.int.intro")}</p>
      {own && <p className="mt-1 text-xs text-slate-500">{t("fin6.int.own")}</p>}
      <button
        onClick={() => void check()}
        disabled={busy}
        className="mt-2 rounded-lg bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
      >
        {busy ? t("ow5.int.checking") : t("ow5.int.check")}
      </button>
      {error && <p className="mt-2 text-red-600">{error}</p>}
      {problems && problems.length === 0 && (
        <p className="mt-2 font-medium text-teal-700">
          {t("ow5.int.allClear", { time: checkedAt ? clock.time(checkedAt) : "" })}
        </p>
      )}
      {problems && problems.length > 0 && (
        <ul className="mt-3 space-y-2">
          {problems.map((p, i) => (
            <li key={`${p.kind}-${p.bookingId ?? p.classId ?? ""}-${i}`} className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-red-950">
              <p className="font-semibold">{t(`ow5.int.kind.${p.kind}`)}</p>
              <p className="text-xs text-red-800">
                {venueName(p.venueId)}
                {p.bookingId !== undefined && <> · {t("ow5.int.booking", { id: p.bookingId })}</>}
                {p.classId !== undefined && <> · {t("ow5.int.class", { id: p.classId })}</>}
              </p>
              {/* The server's own record of what it found, as it wrote it. */}
              <pre className="mt-1 whitespace-pre-wrap text-xs text-slate-700">{p.detail}</pre>
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
