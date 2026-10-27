"use client";

import { useCallback, useEffect, useState } from "react";
import type { ScannerHealth, ScannerProblem } from "@/lib/document-scanning";
import type { Jurisdiction, RetentionPolicy, ScopeKey } from "@/lib/retention-policy";
import { useStaffT } from "./StaffLanguage";

// The same lists as lib/retention-policy.ts, which a client component does not import (it reads the database).
const JURISDICTIONS: Jurisdiction[] = ["MY", "SG"];
const REVIEW_SCOPE: ScopeKey[] = ["documentDays", "reviewDays", "recordDays", "quarantineDays"];
const toggle = <T,>(list: T[], item: T): T[] => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);

/**
 * The platform owner's view of supporting documents (ADR 0024): whether the
 * malware scanner answers, how old its signatures are and what is waiting or
 * was refused; and the install's retention periods for applications, with
 * each review recorded (per jurisdiction, as recorded by the platform owner,
 * not verified by MySenam) and what stays provisional, marked
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
  const [review, setReview] = useState<{
    jurisdictions: Jurisdiction[];
    scope: ScopeKey[];
    reviewedOn: string;
    reviewerName: string;
    reviewerRole: string;
    firm: string;
    adviceReference: string;
    basis: string;
  }>({ jurisdictions: [], scope: [], reviewedOn: "", reviewerName: "", reviewerRole: "", firm: "", adviceReference: "", basis: "" });
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
          {policy.provisional ? (
            <p className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-900">{t("apr.retx2.homeProvisional", { jurisdiction: t(`apr.retx2.${policy.home}`) })}</p>
          ) : (
            <p className="text-sm text-slate-700">{t("apr.retx2.homeCovered", { jurisdiction: t(`apr.retx2.${policy.home}`) })}</p>
          )}
          <ul className="space-y-1 text-sm text-slate-700">
            {JURISDICTIONS.flatMap((j) => [
              ...policy.coverage[j].reviews.map((r) => (
                <li key={`r${r.id}`}>
                  {t("apr.retx2.review", {
                    jurisdiction: t(`apr.retx2.${j}`),
                    name: r.reviewerName,
                    role: r.reviewerRole,
                    firm: r.firm,
                    scope: r.scope.map((s) => t(`apr.retx2.cls.${s}`)).join(", "),
                    date: r.reviewedOn,
                    reference: r.adviceReference,
                    basis: r.basis,
                    recorder: r.recordedBy,
                  })}
                </li>
              )),
              ...(policy.coverage[j].provisional.length > 0
                ? [
                    <li key={`p${j}`} className="text-amber-900">
                      {t("apr.retx2.provisionalFor", { jurisdiction: t(`apr.retx2.${j}`), scope: policy.coverage[j].provisional.map((s) => t(`apr.retx2.cls.${s}`)).join(", ") })}
                    </li>,
                  ]
                : []),
            ])}
          </ul>
          <p className="text-xs text-slate-500">{t("apr.retx2.notApproval")}</p>
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
            <p className="mt-2 text-xs text-slate-500">{t("apr.retx2.formNote")}</p>
            <div className="mt-2 flex flex-wrap items-end gap-2">
              <fieldset className={label}>
                <legend>{t("apr.retx2.jurisdictions")}</legend>
                <div className="mt-1 flex gap-3">
                  {JURISDICTIONS.map((j) => (
                    <label key={j} className="flex items-center gap-1 text-sm font-normal text-slate-700">
                      <input type="checkbox" checked={review.jurisdictions.includes(j)} onChange={() => setReview({ ...review, jurisdictions: toggle(review.jurisdictions, j) })} />
                      {t(`apr.retx2.${j}`)}
                    </label>
                  ))}
                </div>
              </fieldset>
              <fieldset className={`${label} w-full`}>
                <legend>{t("apr.retx2.scope")}</legend>
                <div className="mt-1 flex flex-wrap gap-3">
                  {REVIEW_SCOPE.map((s) => (
                    <label key={s} className="flex items-center gap-1 text-sm font-normal text-slate-700">
                      <input type="checkbox" checked={review.scope.includes(s)} onChange={() => setReview({ ...review, scope: toggle(review.scope, s) })} />
                      {t(`apr.retx2.cls.${s}`)}
                    </label>
                  ))}
                </div>
              </fieldset>
              <label className={label}>
                {t("apr.retx.reviewedOn")}
                <input type="date" value={review.reviewedOn} onChange={(e) => setReview({ ...review, reviewedOn: e.target.value })} className={`mt-1 ${input}`} />
              </label>
              <label className={label}>
                {t("apr.retx2.reviewerName")}
                <input value={review.reviewerName} maxLength={200} onChange={(e) => setReview({ ...review, reviewerName: e.target.value })} className={`mt-1 ${input}`} />
              </label>
              <label className={label}>
                {t("apr.retx2.reviewerRole")}
                <input value={review.reviewerRole} maxLength={200} onChange={(e) => setReview({ ...review, reviewerRole: e.target.value })} className={`mt-1 ${input}`} />
              </label>
              <label className={label}>
                {t("apr.retx2.firm")}
                <input value={review.firm} maxLength={200} onChange={(e) => setReview({ ...review, firm: e.target.value })} className={`mt-1 ${input}`} />
              </label>
              <label className={`${label} w-full`}>
                {t("apr.retx2.adviceReference")}
                <input value={review.adviceReference} maxLength={200} onChange={(e) => setReview({ ...review, adviceReference: e.target.value })} className={`mt-1 ${input}`} />
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
