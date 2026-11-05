"use client";

import { useCallback, useEffect, useState } from "react";
import { readJson } from "@/lib/read-response";
import type { Report } from "@/lib/attendance";
import Dialog from "@/components/Dialog";
import { RegisterPanel, type RegisterKey } from "@/components/RegisterPanel";
import { useStaffT } from "./StaffLanguage";

/** The staff's own words for a register (the `clsb.s.` phrases), for `RegisterPanel`. */
function useRegisterSay() {
  const t = useStaffT();
  return useCallback((key: RegisterKey, vars?: Record<string, string | number>) => t(`clsb.s.${key}`, vars), [t]);
}

/**
 * A session's register on the dashboard (lib/attendance.ts): a class's roll or a coached lesson's, in a dialog with a tap list. The desk
 * and managers mark from the session's day; a manager closes the register and corrects it afterwards with a reason.
 */
export function RegisterDialog({ kind, id, onClose }: { kind: "class" | "lesson"; id: number; onClose: () => void }) {
  const t = useStaffT();
  const say = useRegisterSay();
  const load = useCallback(() => fetch(`/api/admin/attendance?kind=${kind}&id=${id}`, { cache: "no-store" }), [kind, id]);
  const send = useCallback(
    (body: Record<string, unknown>) => fetch("/api/admin/attendance", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, id, ...body }) }),
    [kind, id]
  );
  const toggle = useCallback(
    (locked: boolean) => fetch("/api/admin/attendance/lock", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind, id, locked }) }),
    [kind, id]
  );
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/50 px-4">
      <Dialog labelledBy="register-title" onClose={onClose} className="max-h-[85vh] w-full max-w-md overflow-y-auto rounded-2xl bg-white p-5 shadow-2xl">
        <p id="register-title" className="sr-only">
          {t("clsb.s.title")}
        </p>
        <RegisterPanel
          load={load}
          send={send}
          say={say}
          errorText={(data, fallback) => t.err(data, fallback)}
          lock={{
            toggle,
            lockText: t("clsb.s.lock"),
            unlockText: t("clsb.s.unlock"),
            historyTitle: t("clsb.s.history"),
            historyLine: (h) =>
              h.reason
                ? t("clsb.s.historyLineWhy", { by: h.by, was: h.was ? t(`clsb.s.${h.was}`) : "–", now: t(`clsb.s.${h.now}`), reason: h.reason })
                : t("clsb.s.historyLine", { by: h.by, was: h.was ? t(`clsb.s.${h.was}`) : "–", now: t(`clsb.s.${h.now}`) }),
          }}
          onClose={onClose}
        />
      </Dialog>
    </div>
  );
}

/** The button that opens a lesson's or a class's register. */
export function RegisterButton({ kind, id, className = "" }: { kind: "class" | "lesson"; id: number; className?: string }) {
  const t = useStaffT();
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className={className || "rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:border-teal-500"}
      >
        {t("clsb.s.regButton")}
      </button>
      {open && <RegisterDialog kind={kind} id={id} onClose={() => setOpen(false)} />}
    </>
  );
}

/**
 * A class's (or a term's) attendance, for a manager (lib/attendance.ts `attendanceReport`): per person the present rate, who has missed
 * several in a row and what is left on their pass, with a spreadsheet. Shown on request; it reads, and a mark never acts on what it shows.
 */
export function AttendanceReport({ venueId, classId, seriesCode }: { venueId: number; classId: number; seriesCode: string | null }) {
  const t = useStaffT();
  const [report, setReport] = useState<Report | null>(null);
  const [shown, setShown] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const query = `venueId=${venueId}&${seriesCode ? `seriesCode=${encodeURIComponent(seriesCode)}` : `classId=${classId}`}`;
  useEffect(() => {
    if (!shown) return;
    let live = true;
    fetch(`/api/admin/attendance/report?${query}`, { cache: "no-store" })
      .then(async (res) => {
        const data = await readJson(res);
        if (!res.ok) throw new Error(t.err(data, t("clsb.s.failed")));
        if (live) setReport(data.report as Report);
      })
      .catch((err) => live && setError(err instanceof Error ? err.message : t("clsb.s.failed")));
    return () => {
      live = false;
    };
  }, [shown, query, t]);
  return (
    <div className="mt-4 border-t border-slate-200 pt-3 text-sm">
      <button type="button" onClick={() => setShown(!shown)} aria-expanded={shown} className="text-xs font-semibold text-teal-700 underline">
        {shown ? t("clsb.s.rep.hide") : t("clsb.s.rep.show")}
      </button>
      {shown && error && <p className="mt-2 text-xs text-red-700">{error}</p>}
      {shown && report && (
        <div className="mt-2 space-y-2">
          <p className="text-xs text-slate-600">
            {t("clsb.s.rep.sessions", { n: report.sessions.length, marked: report.sessions.reduce((n, s) => n + s.present + s.late + s.absent + s.excused, 0) })}
            {report.totals.presentRate !== null && <> · {t("clsb.s.rep.rate")} {report.totals.presentRate}%</>}
          </p>
          {report.people.length === 0 ? (
            <p className="text-xs text-slate-500">{t("clsb.s.rep.none")}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[420px] text-xs">
                <thead>
                  <tr className="text-left uppercase tracking-wide text-slate-500">
                    <th className="py-1 pr-2">{t("clsb.s.rep.person")}</th>
                    <th className="px-1">{t("clsb.s.rep.present")}</th>
                    <th className="px-1">{t("clsb.s.rep.late")}</th>
                    <th className="px-1">{t("clsb.s.rep.absent")}</th>
                    <th className="px-1">{t("clsb.s.rep.excused")}</th>
                    <th className="px-1">{t("clsb.s.rep.rate")}</th>
                    <th className="px-1">{t("clsb.s.rep.missed")}</th>
                    <th className="px-1">{t("clsb.s.rep.passLeft")}</th>
                  </tr>
                </thead>
                <tbody>
                  {report.people.map((p, i) => (
                    <tr key={i} className="border-t border-slate-100">
                      <td className="py-1 pr-2 font-medium">{p.name}</td>
                      <td className="px-1">{p.present}</td>
                      <td className="px-1">{p.late}</td>
                      <td className="px-1">{p.absent}</td>
                      <td className="px-1">{p.excused}</td>
                      <td className="px-1">{p.presentRate === null ? "–" : `${p.presentRate}%`}</td>
                      <td className={`px-1 ${p.missedInARow >= 2 ? "font-semibold text-rose-700" : ""}`}>{p.missedInARow}</td>
                      <td className="px-1">{p.passEntriesLeft ?? "–"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="text-xs text-slate-500">{t("clsb.s.rep.suggest")}</p>
          <a href={`/api/admin/attendance/report?${query}&format=csv`} className="inline-block text-xs font-semibold text-teal-700 underline">
            {t("clsb.s.rep.csv")}
          </a>
        </div>
      )}
    </div>
  );
}

/** The two numbers of days a manager sets for lessons and registers (lib/lesson-venue-moves.ts `setLessonSettings`). */
export function LessonSettings({ venueId }: { venueId: number }) {
  const t = useStaffT();
  const [values, setValues] = useState<{ refund: string; lock: string } | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`/api/admin/lesson-settings?venueId=${venueId}`, { cache: "no-store" })
      .then(async (res) => {
        const data = await readJson(res);
        if (!res.ok) throw new Error(t.err(data, t("clsb.s.failed")));
        if (live) setValues({ refund: String(data.settings.moveRefundDays), lock: String(data.settings.attendanceLockDays) });
      })
      .catch((err) => live && setError(err instanceof Error ? err.message : t("clsb.s.failed")));
    return () => {
      live = false;
    };
  }, [venueId, t]);
  if (!values) return error ? <p className="text-sm text-red-700">{error}</p> : null;
  return (
    <form
      className="flex flex-wrap items-end gap-3 rounded-xl border border-slate-200 bg-white p-4"
      onSubmit={async (e) => {
        e.preventDefault();
        setError(null);
        setMessage(null);
        try {
          const res = await fetch("/api/admin/lesson-settings", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ venueId, moveRefundDays: Number(values.refund), attendanceLockDays: Number(values.lock) }),
          });
          const data = await readJson(res);
          if (!res.ok) throw new Error(t.err(data, t("clsb.s.failed")));
          setMessage(t("clsb.s.set.saved"));
        } catch (err) {
          setError(err instanceof Error ? err.message : t("clsb.s.failed"));
        }
      }}
    >
      <p className="w-full text-sm font-semibold text-slate-700">{t("clsb.s.set.title")}</p>
      <label className="flex max-w-xs flex-col gap-1 text-xs font-medium text-slate-600">
        {t("clsb.s.set.refund")}
        <input type="number" min={0} max={60} step={1} value={values.refund} onChange={(e) => setValues({ ...values, refund: e.target.value })} className="w-24 rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
      </label>
      <label className="flex max-w-xs flex-col gap-1 text-xs font-medium text-slate-600">
        {t("clsb.s.set.lock")}
        <input type="number" min={0} max={365} step={1} value={values.lock} onChange={(e) => setValues({ ...values, lock: e.target.value })} className="w-24 rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
      </label>
      <button type="submit" className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700">
        {t("clsb.s.set.save")}
      </button>
      {message && <span className="text-xs font-medium text-emerald-700">{message}</span>}
      {error && <span className="text-xs font-medium text-red-700">{error}</span>}
    </form>
  );
}
