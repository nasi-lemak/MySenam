"use client";

import { useCallback, useEffect, useState } from "react";
import type { FailedDocument, OnDemandHealth, ScannerHealth, ScannerProblem } from "@/lib/document-scanning";
import { fileSize } from "@/components/ApprovalDocumentLink";
import type { Jurisdiction, RetentionPolicy, ScopeKey } from "@/lib/retention-policy";
import { useStaffT } from "./StaffLanguage";

// The same lists as lib/retention-policy.ts, which a client component does not import (it reads the database).
const JURISDICTIONS: Jurisdiction[] = ["MY", "SG"];
const REVIEW_SCOPE: ScopeKey[] = ["documentDays", "reviewDays", "recordDays", "quarantineDays"];
const toggle = <T,>(list: T[], item: T): T[] => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);

/**
 * The platform owner's view of supporting documents (ADR 0024): whether the
 * malware scanner answers, how old its signatures are and what is waiting or
 * was refused; documents that could not be scanned, with their retries and
 * the action to scan one again; and the install's retention periods for
 * applications, with each review recorded (per jurisdiction, as recorded by
 * the platform owner, not verified by MySenam) and what stays provisional, marked
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

const when = (iso: string | null) => (iso ? iso.slice(0, 16).replace("T", " ") + " UTC" : "");

/** Problems worded under the amended decision (no opt-out, documents waiting for a scanner) have `apr.scan2.` words; the on-demand scanner's, `apr.scan3.`. */
const problemKey = (p: ScannerProblem) =>
  p === "ondemand_misconfigured" || p === "ondemand_failed" || p === "ondemand_blocked"
    ? (`apr.scan3.problem.${p}` as const)
    : p === "unconfigured" || p === "waiting"
      ? (`apr.scan2.problem.${p}` as const)
      : (`apr.scan.problem.${p}` as const);
/** How many times the owner may have one document scanned again (lib/document-scanning.ts MAX_MANUAL_RETRIES). */
const MAX_RETRIES = 3;

export default function DocumentPolicy() {
  const t = useStaffT();
  const [state, setState] = useState<{
    policy: RetentionPolicy;
    scanner?: ScannerHealth;
    failed?: FailedDocument[];
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
  const [reasons, setReasons] = useState<Record<number, string>>({});

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

  async function retry(documentId: number) {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/document-policy", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "retry", documentId, reason: reasons[documentId] ?? "" }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(t.err(data, t("apr.scan2.retryFailed")));
      setNotice(data.alreadyQueued ? t("apr.scan2.alreadyQueued") : t("apr.scan2.retried"));
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("apr.scan2.retryFailed"));
    } finally {
      setBusy(false);
    }
  }

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
            {scanner.mode !== "scanner"
              ? t("apr.scan2.modeUnconfigured")
              : scanner.onDemand && !scanner.onDemand.error
                ? t("apr.scan3.modeOnDemand", { idle: scanner.onDemand.idleMinutes ?? 0 })
                : t("apr.scan.modeScanner")}
          </p>
          {scanner.onDemand?.error && <p className="text-amber-800">{t("apr.scan3.misconfigured", { error: scanner.onDemand.error })}</p>}
          {scanner.mode === "scanner" && scanner.reachable !== null && (
            <p className="text-slate-600">{scanner.reachable ? t("apr.scan.answering", { engine: scanner.engine ?? "" }) : t("apr.scan.notAnswering")}</p>
          )}
          {scanner.onDemand && !scanner.onDemand.error && <OnDemandLines health={scanner.onDemand} />}
          {scanner.signaturesAt && (
            <p className="text-slate-600">
              {t("apr.scan.signatures", { date: day(scanner.signaturesAt), hours: Math.floor(scanner.signatureAgeHours ?? 0) })}
            </p>
          )}
          <p className="text-slate-600">
            {t("apr.scan2.counts", { pending: scanner.pending, overdue: scanner.overdue, waiting: scanner.waiting, rejected: scanner.rejected, failed: scanner.failed })}
          </p>
          {scanner.legacy.total > 0 && <p className="text-slate-600">{t("apr.scan2.legacy", { ...scanner.legacy })}</p>}
          {scanner.problems.length > 0 && (
            <ul className="list-disc pl-5 text-amber-800">
              {scanner.problems.map((p: ScannerProblem) => (
                <li key={p}>{t(problemKey(p))}</li>
              ))}
            </ul>
          )}
        </div>
      )}

      {state?.failed && (
        <div className="space-y-2 rounded-xl border border-slate-200 bg-white p-4 text-sm shadow-sm">
          <h3 className="font-semibold">{t("apr.scan2.failedTitle")}</h3>
          <p className="text-xs text-slate-500">{t("apr.scan2.failedIntro")}</p>
          {state.failed.length === 0 && <p className="text-slate-500">{t("apr.scan2.failedNone")}</p>}
          <ul className="space-y-3">
            {state.failed.map((d) => (
              <li key={d.id} className="space-y-1 border-t border-slate-100 pt-2">
                <p className="font-medium">
                  {t("apr.scan2.failedRow", {
                    id: d.id,
                    request: d.requestId,
                    venue: d.venueName,
                    sport: d.sport,
                    kind: d.contentType.split("/")[1].toUpperCase(),
                    size: fileSize(d.size),
                  })}
                </p>
                <p className={d.failure === "scanner_unavailable" ? "text-amber-800" : "text-red-700"}>
                  {t(`apr.scan2.failure.${d.failure}`)}
                  {d.legacyReason && <span className="text-slate-500"> · {t(`apr.scan2.legacy.${d.legacyReason}`)}</span>}
                </p>
                {!d.intact && <p className="text-red-700">{t("apr.scan2.notIntact")}</p>}
                <p className="text-xs text-slate-500">{t("apr.scan2.retriesUsed", { n: d.manualRetries, max: MAX_RETRIES })}</p>
                {d.intact && d.manualRetries < MAX_RETRIES && (
                  <div className="flex flex-wrap items-end gap-2">
                    <label className={label}>
                      {t("apr.scan2.reason")}
                      <input
                        value={reasons[d.id] ?? ""}
                        maxLength={500}
                        onChange={(e) => setReasons({ ...reasons, [d.id]: e.target.value })}
                        className={`mt-1 w-72 ${input}`}
                      />
                    </label>
                    <button
                      type="button"
                      disabled={busy || (reasons[d.id] ?? "").trim().length < 5}
                      onClick={() => retry(d.id)}
                      className="rounded-lg border border-teal-600 px-3 py-1.5 text-xs font-semibold text-teal-700 disabled:opacity-50"
                    >
                      {t("apr.scan2.retry")}
                    </button>
                  </div>
                )}
                {d.retries.length > 0 && (
                  <details className="text-xs text-slate-600">
                    <summary className="cursor-pointer font-medium">{t("apr.scan2.history")}</summary>
                    <ul className="mt-1 space-y-0.5">
                      {d.retries.map((r, i) => (
                        <li key={i}>
                          {t("apr.scan2.historyRow", {
                            date: day(r.at),
                            by: r.by,
                            kind: t(`apr.scan2.kind.${r.kind}`),
                            reason: r.reason,
                            outcome: t(`apr.scan2.outcome.${r.outcome}`),
                          })}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </li>
            ))}
          </ul>
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

/** The scanner started on demand: running or not, its last start (load time, peak memory), stop and failure, and why it is held back. */
function OnDemandLines({ health }: { health: OnDemandHealth }) {
  const t = useStaffT();
  const s = health.state;
  return (
    <>
      <p className="text-slate-600">{t(`apr.scan3.phase.${s?.phase ?? "stopped"}`)}</p>
      {s?.lastStartAt && (
        <p className="text-slate-600">
          {s.lastLoadMs !== null
            ? t("apr.scan3.lastStart", { date: when(s.lastStartAt), seconds: (s.lastLoadMs / 1000).toFixed(1), mib: s.peakRssMiB ?? "?" })
            : t("apr.scan3.lastStartNoLoad", { date: when(s.lastStartAt) })}
        </p>
      )}
      {s?.lastStopAt && s.lastStopReason && (
        <p className="text-slate-600">{t("apr.scan3.lastStop", { date: when(s.lastStopAt), reason: t(`apr.scan3.stop.${s.lastStopReason}`) })}</p>
      )}
      {health.memAvailableMiB !== null && health.minAvailableMiB !== null && (
        <p className="text-slate-600">{t("apr.scan3.memory", { mib: health.memAvailableMiB, min: health.minAvailableMiB })}</p>
      )}
      {health.signaturesVersion !== null && <p className="text-slate-600">{t("apr.scan3.signaturesOnDisk", { version: health.signaturesVersion })}</p>}
      {s?.blocked && <p className="text-amber-800">{t(`apr.scan3.blocked.${s.blocked.reason}`, { date: when(s.blocked.since) })}</p>}
      {s?.lastFailureAt && s.lastFailure && s.consecutiveFailures > 0 && (
        <p className="text-amber-800">{t("apr.scan3.lastFailure", { date: when(s.lastFailureAt), detail: s.lastFailure })}</p>
      )}
    </>
  );
}
