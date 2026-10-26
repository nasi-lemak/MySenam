"use client";

import { useCallback, useEffect, useState } from "react";
import type { ScannerHealth, ScannerProblem } from "@/lib/document-scanning";
import type { RetentionPolicy } from "@/lib/retention-policy";
import { useStaffT } from "./StaffLanguage";

/**
 * The platform owner's view of supporting documents (ADR 0024): whether the
 * malware scanner answers, how old its signatures are and what is waiting or
 * was refused; and the install's retention periods for applications, marked
 * provisional until somebody records a review, with the form to change them
 * and to record that review.
 */

const input = "rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-teal-500 focus:outline-none";
const label = "flex flex-col text-xs font-medium text-slate-500";

type Periods = Pick<RetentionPolicy, "documentDays" | "reviewDays" | "recordDays" | "quarantineDays">;
const FIELDS: { key: keyof Periods; words: "apr.retx.documentDays" | "apr.retx.reviewDays" | "apr.retx.recordDays" | "apr.retx.quarantineDays" }[] = [
  { key: "documentDays", words: "apr.retx.documentDays" },
  { key: "reviewDays", words: "apr.retx.reviewDays" },
  { key: "recordDays", words: "apr.retx.recordDays" },
  { key: "quarantineDays", words: "apr.retx.quarantineDays" },
];

const day = (iso: string | null) => (iso ? iso.slice(0, 10) : "");

export default function DocumentPolicy() {
  const t = useStaffT();
  const [state, setState] = useState<{
    policy: RetentionPolicy;
    scanner?: ScannerHealth;
    events?: { at: string | null; kind: string; by: string; detail: string }[];
  } | null>(null);
  const [form, setForm] = useState<Record<keyof Periods, string>>({ documentDays: "", reviewDays: "", recordDays: "", quarantineDays: "" });
  const [review, setReview] = useState({ reviewedOn: "", reviewedBy: "", basis: "" });
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/admin/document-policy", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok) throw new Error(t.err(data, t("apr.scan.readFailed")));
      setState(data);
      const p = data.policy as RetentionPolicy;
      setForm({ documentDays: String(p.documentDays), reviewDays: String(p.reviewDays), recordDays: String(p.recordDays), quarantineDays: String(p.quarantineDays) });
    } catch (err) {
      setError(err instanceof Error ? err.message : t("apr.scan.readFailed"));
    }
  }, [t]);
  useEffect(() => {
    load();
  }, [load]);

  async function send(body: Record<string, unknown>, done: string) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/document-policy", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) throw new Error(t.err(data, t("apr.retx.failed")));
      setNotice(done);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("apr.retx.failed"));
    } finally {
      setBusy(false);
    }
  }

  const scanner = state?.scanner;
  const policy = state?.policy;
  return (
    <section className="space-y-3">
      <div>
        <h2 className="text-lg font-bold">{t("apr.scan.title")}</h2>
        <p className="mt-1 text-sm text-slate-500">{t("apr.scan.intro")}</p>
      </div>
      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
      {notice && <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{notice}</div>}

      {scanner && (
        <div className="space-y-1 rounded-xl border border-slate-200 bg-white p-4 text-sm shadow-sm">
          <p className="font-medium">
            {scanner.mode === "scanner" ? t("apr.scan.modeScanner") : scanner.mode === "off" ? t("apr.scan.modeOff") : t("apr.scan.modeUnconfigured")}
          </p>
          {scanner.mode === "scanner" && (
            <p className="text-slate-600">{scanner.reachable ? t("apr.scan.answering", { engine: scanner.engine ?? "" }) : t("apr.scan.notAnswering")}</p>
          )}
          {scanner.signaturesAt && (
            <p className="text-slate-600">
              {t("apr.scan.signatures", { date: day(scanner.signaturesAt), hours: Math.floor(scanner.signatureAgeHours ?? 0) })}
            </p>
          )}
          <p className="text-slate-600">
            {t("apr.scan.counts", { pending: scanner.pending, overdue: scanner.overdue, rejected: scanner.rejected, failed: scanner.failed, notScanned: scanner.notScanned })}
          </p>
          {scanner.problems.length > 0 && (
            <ul className="list-disc pl-5 text-amber-800">
              {scanner.problems.map((p: ScannerProblem) => (
                <li key={p}>{t(`apr.scan.problem.${p}`)}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {policy && (
        <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <h3 className="font-semibold">{t("apr.retx.title")}</h3>
          {policy.review ? (
            <p className="text-sm text-emerald-800">
              {t("apr.retx.reviewed", { date: policy.review.reviewedOn, by: policy.review.reviewedBy, basis: policy.review.basis, recorder: policy.review.recordedBy ?? "" })}
            </p>
          ) : (
            <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">{t("apr.retx.provisional")}</p>
          )}
          <div className="flex flex-wrap items-end gap-2">
            {FIELDS.map((f) => (
              <label key={f.key} className={label}>
                {t(f.words)}
                <input inputMode="numeric" value={form[f.key]} onChange={(e) => setForm({ ...form, [f.key]: e.target.value })} className={`mt-1 w-24 ${input}`} />
              </label>
            ))}
            <button
              type="button"
              disabled={busy}
              onClick={() => send({ action: "set", ...Object.fromEntries(FIELDS.map((f) => [f.key, Number(form[f.key])])) }, t("apr.retx.saved"))}
              className="rounded-lg bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
            >
              {t("apr.retx.save")}
            </button>
          </div>
          <p className="text-xs text-slate-500">{t("apr.retx.changeNote")}</p>

          <details className="text-sm">
            <summary className="cursor-pointer font-medium">{t("apr.retx.reviewTitle")}</summary>
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <label className={label}>
                {t("apr.retx.reviewedOn")}
                <input type="date" value={review.reviewedOn} onChange={(e) => setReview({ ...review, reviewedOn: e.target.value })} className={`mt-1 ${input}`} />
              </label>
              <label className={label}>
                {t("apr.retx.reviewedBy")}
                <input value={review.reviewedBy} maxLength={200} onChange={(e) => setReview({ ...review, reviewedBy: e.target.value })} className={`mt-1 ${input}`} />
              </label>
              <label className={`${label} w-full`}>
                {t("apr.retx.basis")}
                <textarea value={review.basis} maxLength={2000} rows={2} onChange={(e) => setReview({ ...review, basis: e.target.value })} className={`mt-1 ${input}`} />
              </label>
              <button
                type="button"
                disabled={busy}
                onClick={() => send({ action: "review", ...review }, t("apr.retx.recorded"))}
                className="rounded-lg border border-teal-600 px-3 py-1.5 text-xs font-semibold text-teal-700 disabled:opacity-50"
              >
                {t("apr.retx.record")}
              </button>
            </div>
          </details>

          {state?.events && state.events.length > 0 && (
            <details className="text-xs text-slate-600">
              <summary className="cursor-pointer font-medium">{t("apr.retx.history")}</summary>
              <ul className="mt-1 space-y-0.5">
                {state.events.map((e, i) => (
                  <li key={i}>
                    {day(e.at)} · {e.by} · {e.detail}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}
    </section>
  );
}
