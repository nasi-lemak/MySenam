"use client";

import { useCallback, useEffect, useState } from "react";
import type { ApprovalRequirement } from "@/lib/approvals";
import type { HoldBasis, RetentionHold } from "@/lib/approval-retention";
import { sportLabel } from "@/lib/i18n";
import { useStaffT } from "./StaffLanguage";

/**
 * What a venue says about the documents it asks for and how long its
 * applications are kept (lib/approval-retention.ts), inside the settings form
 * (ApprovalsPanel.tsx); and its holds, keeping an application past its time.
 */

const input = "rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-teal-500 focus:outline-none";
const label = "flex flex-col text-xs font-medium text-slate-500";

/** The form's part for these, as text the inputs hold. */
export interface RetentionForm {
  documentPurpose: string;
  reviewDays: string;
  documentDays: string;
  recordDays: string;
}

export const EMPTY_RETENTION: RetentionForm = { documentPurpose: "", reviewDays: "", documentDays: "", recordDays: "" };

export function retentionFormOf(r: ApprovalRequirement): RetentionForm {
  const n = (v: number | null) => (v === null ? "" : String(v));
  return { documentPurpose: r.documentPurpose ?? "", reviewDays: n(r.reviewDays), documentDays: n(r.documentDays), recordDays: n(r.recordDays) };
}

/** What the settings route takes for them. */
export function retentionBody(f: RetentionForm): Record<string, unknown> {
  const n = (v: string) => (v.trim() === "" ? null : Number(v));
  return { documentPurpose: f.documentPurpose || null, reviewDays: n(f.reviewDays), documentDays: n(f.documentDays), recordDays: n(f.recordDays) };
}

/** Why the document is needed: shown with the document's label, which it must accompany. */
export function DocumentPurposeField({ value, onChange }: { value: RetentionForm; onChange: (f: RetentionForm) => void }) {
  const t = useStaffT();
  return (
    <label className={label}>
      {t("apr.doc.purpose")}
      <input value={value.documentPurpose} maxLength={300} onChange={(e) => onChange({ ...value, documentPurpose: e.target.value })} className={`mt-1 ${input}`} />
      <span className="mt-0.5 font-normal text-slate-400">{t("apr.doc.purposeHint")}</span>
    </label>
  );
}

/** The activity's own, shorter retention periods; blank for the install's. */
export function RetentionFields({ value, onChange }: { value: RetentionForm; onChange: (f: RetentionForm) => void }) {
  const t = useStaffT();
  // The install's own periods (lib/retention-policy.ts), and whether a review of them is recorded.
  const [install, setInstall] = useState<{ documentDays: number; reviewDays: number; recordDays: number; review: { reviewedOn: string } | null } | null>(null);
  useEffect(() => {
    fetch("/api/admin/document-policy", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => data && setInstall(data.policy))
      .catch(() => undefined);
  }, []);
  const field = (key: "reviewDays" | "documentDays" | "recordDays", words: "apr.ret.reviewDays" | "apr.ret.documentDays" | "apr.ret.recordDays") => (
    <label className={label}>
      {t(words)}
      <input inputMode="numeric" value={value[key]} onChange={(e) => onChange({ ...value, [key]: e.target.value })} className={`mt-1 w-24 ${input}`} />
    </label>
  );
  return (
    <fieldset className="space-y-1">
      <legend className="text-xs font-medium text-slate-500">{t("apr.ret.title")}</legend>
      <div className="flex flex-wrap items-end gap-2">
        {field("reviewDays", "apr.ret.reviewDays")}
        {field("documentDays", "apr.ret.documentDays")}
        {field("recordDays", "apr.ret.recordDays")}
      </div>
      <p className="text-xs text-slate-400">
        {t("apr.ret.hint", { review: install?.reviewDays ?? 30, docs: install?.documentDays ?? 90, record: install?.recordDays ?? 365 })}{" "}
        {install && (install.review ? t("apr.retx.hintReviewed", { date: install.review.reviewedOn }) : t("apr.retx.hintProvisional"))}
      </p>
    </fieldset>
  );
}

const BASES: HoldBasis[] = ["legal", "safety", "dispute", "incident"];

/**
 * Holds at a venue: in force first, each with why, who placed it in what
 * role, and its review date; a form to place one (or renew one, as a new
 * hold) and a button to release one. Managers and the platform owner only:
 * front desk sees nothing here.
 */
export function ApprovalHolds({ venueId }: { venueId: number }) {
  const t = useStaffT();
  const [holds, setHolds] = useState<RetentionHold[] | null>(null);
  const [form, setForm] = useState({ requestId: "", basis: "legal" as HoldBasis, reason: "", reviewBy: "" });
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const load = useCallback(() => {
    fetch(`/api/admin/approvals/holds?venueId=${venueId}`, { cache: "no-store" })
      .then(async (r) => {
        if (r.status === 403) return setHolds(null);
        const data = await r.json();
        if (!r.ok) throw new Error(t.err(data));
        setHolds(data.holds);
      })
      .catch((err) => setError(err instanceof Error ? err.message : t("c.failed")));
  }, [venueId, t]);
  useEffect(() => load(), [load]);

  async function send(method: "POST" | "PATCH", body: Record<string, unknown>) {
    setError(null);
    setDone(false);
    try {
      const res = await fetch("/api/admin/approvals/holds", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ venueId, ...body }) });
      const data = await res.json();
      if (!res.ok) throw new Error(t.err(data));
      if (method === "POST") {
        setDone(true);
        setForm({ requestId: "", basis: "legal", reason: "", reviewBy: "" });
      }
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("c.failed"));
    }
  }

  function release(h: RetentionHold) {
    const reason = window.prompt(t("apr.ret.releasePrompt"));
    if (reason) void send("PATCH", { id: h.id, reason });
  }

  if (holds === null && !error) return null;
  return (
    <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h3 className="font-semibold">{t("apr.ret.holdsTitle")}</h3>
      <p className="text-sm text-slate-500">{t("apr.ret.holdsIntro")}</p>
      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      {holds && holds.length === 0 && <p className="text-sm text-slate-500">{t("apr.ret.none")}</p>}
      {holds && holds.length > 0 && (
        <ul className="divide-y divide-slate-100 text-sm">
          {holds.map((h) => (
            <li key={h.id} className="flex flex-wrap items-start justify-between gap-2 py-1.5">
              <span className={h.active ? "" : "text-slate-400"}>
                {t("apr.ret.line", { id: h.requestId, name: h.applicant, activity: sportLabel(t.customer, h.sport), date: h.reviewBy })}
                {" · "}
                {t(`apr.ret.basis.${h.basis}`)}: {h.reason}
                <span className="block text-xs text-slate-500">
                  {t("apr.ret.by", { name: h.placedByName, role: t(`apr.ret.role.${h.placedByRole}`), date: h.placedAt.slice(0, 10) })}
                  {!h.active && ` · ${t("apr.ret.ended")}`}
                </span>
              </span>
              {h.active && (
                <button type="button" onClick={() => release(h)} className="text-xs font-medium text-red-700 hover:underline">
                  {t("apr.ret.release")}
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send("POST", { requestId: Number(form.requestId), basis: form.basis, reason: form.reason, reviewBy: form.reviewBy });
        }}
        className="flex flex-wrap items-end gap-2 rounded-lg border border-slate-100 bg-slate-50 p-3"
      >
        <label className={label}>
          {t("apr.ret.application")}
          <input inputMode="numeric" required value={form.requestId} onChange={(e) => setForm({ ...form, requestId: e.target.value })} className={`mt-1 w-28 ${input}`} />
        </label>
        <label className={label}>
          {t("apr.ret.basis")}
          <select value={form.basis} onChange={(e) => setForm({ ...form, basis: e.target.value as HoldBasis })} className={`mt-1 ${input}`}>
            {BASES.map((b) => (
              <option key={b} value={b}>
                {t(`apr.ret.basis.${b}`)}
              </option>
            ))}
          </select>
        </label>
        <label className={`${label} min-w-[14rem] flex-1`}>
          {t("apr.ret.reason")}
          <input required minLength={10} maxLength={1000} value={form.reason} onChange={(e) => setForm({ ...form, reason: e.target.value })} className={`mt-1 ${input}`} />
        </label>
        <label className={label}>
          {t("apr.ret.reviewBy")}
          <input type="date" required value={form.reviewBy} onChange={(e) => setForm({ ...form, reviewBy: e.target.value })} className={`mt-1 ${input}`} />
        </label>
        <button type="submit" className="rounded-lg bg-teal-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-teal-700">
          {t("apr.ret.place")}
        </button>
        {done && <span className="text-sm text-emerald-700">{t("apr.ret.placed")}</span>}
      </form>
    </section>
  );
}
