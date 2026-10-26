"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ApprovalRequirement } from "@/lib/approvals";
import { activityIcon } from "@/lib/activity-registry";
import { courtSports } from "@/lib/court-activities";
import { sportLabel } from "@/lib/i18n";
import type { StaffT } from "@/lib/staff-i18n";
import type { Court } from "@/lib/types";
import { ApprovalReview, type Say } from "@/components/ApprovalReview";
import { useStaffT } from "./StaffLanguage";
import { DocumentPurposeField, EMPTY_RETENTION, RetentionFields, retentionBody, retentionFormOf } from "./ApprovalRetention";

/**
 * Online applications to be approved for an activity (lib/approvals.ts):
 * what the venue asks for each activity (managers), and the applications to
 * review (any of its staff, as sign-offs are).
 */

const input = "rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-teal-500 focus:outline-none";

interface CoachChoice {
  id: number;
  name: string;
  sports: string[];
}

const EMPTY = {
  sport: "",
  kind: "operational" as "operational" | "certification",
  intro: "",
  declaration: "",
  documentLabel: "",
  videoUrl: "",
  inPerson: "",
  questions: "",
  waiver: false,
  validDays: "365",
  pendingDays: "14",
  holdHours: "48",
  open: true,
  coachIds: [] as number[],
};

function formOf(r: ApprovalRequirement): typeof EMPTY {
  return {
    sport: r.sport,
    kind: r.kind,
    intro: r.intro ?? "",
    declaration: r.declaration ?? "",
    documentLabel: r.documentLabel ?? "",
    videoUrl: r.videoUrl ?? "",
    inPerson: r.inPerson ?? "",
    questions: r.questions.map((q) => (q.required ? q.text : `~ ${q.text}`)).join("\n"),
    waiver: r.waiver,
    validDays: r.validDays === null ? "" : String(r.validDays),
    pendingDays: String(r.pendingDays),
    holdHours: String(r.holdHours),
    open: r.open,
    coachIds: r.coachIds,
  };
}

/** The staff dictionary as the shared review screen reads it. */
export function staffSay(t: StaffT): Say {
  return (key, vars) => t(key, vars);
}

/** What the venue asks before approving somebody online, per activity. */
export function ApprovalSettings({ venueId, courts }: { venueId: number; courts: Court[] }) {
  const t = useStaffT();
  const [requirements, setRequirements] = useState<ApprovalRequirement[]>([]);
  const [coaches, setCoaches] = useState<CoachChoice[]>([]);
  const [form, setForm] = useState(EMPTY);
  const [kept, setKept] = useState(EMPTY_RETENTION);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const sports = useMemo(() => [...new Set(courts.flatMap(courtSports))], [courts]);

  const load = useCallback(() => {
    fetch(`/api/admin/approvals/settings?venueId=${venueId}`, { cache: "no-store" })
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(t.err(data));
        setRequirements(data.requirements);
        setCoaches(data.coaches);
      })
      .catch((err) => setError(err instanceof Error ? err.message : t("c.failed")));
  }, [venueId, t]);
  useEffect(() => load(), [load]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSaved(false);
    // A line starting with ~ is a question that may be left blank.
    const optional = /^~\s*/;
    const questions = form.questions
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => ({ text: line.replace(optional, ""), required: !optional.test(line) }));
    const body = {
      venueId,
      sport: form.sport,
      kind: form.kind,
      intro: form.intro || null,
      declaration: form.declaration || null,
      documentLabel: form.documentLabel || null,
      videoUrl: form.videoUrl || null,
      inPerson: form.inPerson || null,
      questions,
      waiver: form.waiver,
      validDays: form.validDays.trim() === "" ? null : Number(form.validDays),
      pendingDays: Number(form.pendingDays),
      holdHours: Number(form.holdHours),
      open: form.open,
      coachIds: form.coachIds,
      ...retentionBody(kept),
    };
    try {
      const res = await fetch("/api/admin/approvals/settings", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await res.json();
      if (!res.ok) throw new Error(t.err(data));
      setSaved(true);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("c.failed"));
    }
  }

  const label = "flex flex-col text-xs font-medium text-slate-500";
  return (
    <section className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h3 className="font-semibold">{t("apr.set.title")}</h3>
      <p className="text-sm text-slate-500">{t("apr.set.intro")}</p>
      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      {requirements.length > 0 && (
        <ul className="divide-y divide-slate-100 text-sm">
          {requirements.map((r) => (
            <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
              <span>
                {activityIcon(r.sport)} {sportLabel(t.customer, r.sport)} · {r.open ? t("apr.set.open") : t("apr.set.closed")} ·{" "}
                {[r.declaration && t("apr.set.mDeclaration"), r.documentLabel && t("apr.set.mDocuments"), r.videoUrl && t("apr.set.mVideo"), r.inPerson && t("apr.set.mInPerson")]
                  .filter(Boolean)
                  .join(", ")}
                {" · "}
                {r.validDays ? t("apr.set.lasts", { n: r.validDays }) : t("apr.set.untilTakenBack")}
              </span>
              <button
                type="button"
                onClick={() => {
                  setForm(formOf(r));
                  setKept(retentionFormOf(r));
                }}
                className="text-xs font-medium text-teal-700 hover:underline"
              >
                {t("c.edit")}
              </button>
            </li>
          ))}
        </ul>
      )}
      <form onSubmit={save} className="space-y-2 rounded-lg border border-slate-100 bg-slate-50 p-3">
        <div className="flex flex-wrap items-end gap-2">
          <label className={label}>
            {t("apr.set.activity")}
            <select required value={form.sport} onChange={(e) => setForm({ ...form, sport: e.target.value })} className={`mt-1 ${input}`}>
              <option value="">—</option>
              {sports.map((s) => (
                <option key={s} value={s}>
                  {activityIcon(s)} {sportLabel(t.customer, s)}
                </option>
              ))}
            </select>
          </label>
          <label className={label}>
            {t("apr.set.gives")}
            <select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value as "operational" | "certification" })} className={`mt-1 ${input}`}>
              <option value="operational">{t("apr.set.signOff")}</option>
              <option value="certification">{t("apr.set.certification")}</option>
            </select>
          </label>
          <label className={label}>
            {t("apr.set.validDays")}
            <input inputMode="numeric" value={form.validDays} onChange={(e) => setForm({ ...form, validDays: e.target.value })} className={`mt-1 w-24 ${input}`} />
          </label>
          <label className={label}>
            {t("apr.set.pendingDays")}
            <input inputMode="numeric" required value={form.pendingDays} onChange={(e) => setForm({ ...form, pendingDays: e.target.value })} className={`mt-1 w-24 ${input}`} />
          </label>
          <label className={label}>
            {t("apr.set.holdHours")}
            <input inputMode="numeric" required value={form.holdHours} onChange={(e) => setForm({ ...form, holdHours: e.target.value })} className={`mt-1 w-24 ${input}`} />
          </label>
        </div>
        <label className={label}>
          {t("apr.set.introLabel")}
          <textarea rows={2} value={form.intro} onChange={(e) => setForm({ ...form, intro: e.target.value })} className={`mt-1 ${input}`} />
        </label>
        <p className="text-xs text-slate-500">{t("apr.set.methods")}</p>
        <label className={label}>
          {t("apr.set.declaration")}
          <textarea rows={2} value={form.declaration} onChange={(e) => setForm({ ...form, declaration: e.target.value })} className={`mt-1 ${input}`} />
        </label>
        <label className={label}>
          {t("apr.set.documentLabel")}
          <input value={form.documentLabel} onChange={(e) => setForm({ ...form, documentLabel: e.target.value })} className={`mt-1 ${input}`} />
          <span className="mt-0.5 font-normal text-slate-400">{t("apr.set.noIdentity")}</span>
        </label>
        {form.documentLabel.trim() !== "" && <DocumentPurposeField value={kept} onChange={setKept} />}
        <label className={label}>
          {t("apr.set.videoUrl")}
          <input type="url" value={form.videoUrl} onChange={(e) => setForm({ ...form, videoUrl: e.target.value })} className={`mt-1 ${input}`} />
        </label>
        <label className={label}>
          {t("apr.set.inPerson")}
          <input value={form.inPerson} onChange={(e) => setForm({ ...form, inPerson: e.target.value })} className={`mt-1 ${input}`} />
          <span className="mt-0.5 font-normal text-slate-400">{t("apr.set.inPersonHint")}</span>
        </label>
        <label className={label}>
          {t("apr.set.questions")}
          <textarea rows={3} value={form.questions} onChange={(e) => setForm({ ...form, questions: e.target.value })} className={`mt-1 ${input}`} />
          <span className="mt-0.5 font-normal text-slate-400">{t("apr.set.questionsHint")}</span>
        </label>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.waiver} onChange={(e) => setForm({ ...form, waiver: e.target.checked })} />
          {t("apr.set.waiver")}
        </label>
        {coaches.length > 0 && (
          <fieldset className="text-sm">
            <legend className="text-xs font-medium text-slate-500">{t("apr.set.coaches")}</legend>
            <div className="mt-1 flex flex-wrap gap-3">
              {coaches.map((c) => (
                <label key={c.id} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={form.coachIds.includes(c.id)}
                    onChange={(e) => setForm({ ...form, coachIds: e.target.checked ? [...form.coachIds, c.id] : form.coachIds.filter((id) => id !== c.id) })}
                  />
                  {c.name}
                </label>
              ))}
            </div>
            <p className="mt-0.5 text-xs text-slate-400">{t("apr.set.coachesHint")}</p>
          </fieldset>
        )}
        <RetentionFields value={kept} onChange={setKept} />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={form.open} onChange={(e) => setForm({ ...form, open: e.target.checked })} />
          {t("apr.set.takingApplications")}
        </label>
        <div className="flex items-center gap-3">
          <button type="submit" className="rounded-lg bg-teal-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-teal-700">
            {t("c.save")}
          </button>
          {saved && <span className="text-sm text-emerald-700">{t("apr.set.saved")}</span>}
        </div>
      </form>
    </section>
  );
}

/**
 * Applications to review at a venue. `waitingOnly` shows only those waiting
 * on the venue, and nothing at all when none are (the bookings tab).
 */
export function ApprovalsReview({ venueId, venueName, waitingOnly }: { venueId: number; venueName?: string | null; waitingOnly?: boolean }) {
  const t = useStaffT();
  const say = useMemo(() => staffSay(t), [t]);
  const explain = useCallback((body: unknown) => t.err(body as { error?: string }), [t]);
  const activityLabel = useCallback((sport: string) => sportLabel(t.customer, sport), [t]);
  return (
    <ApprovalReview
      say={say}
      locale={t.locale}
      activityLabel={activityLabel}
      explain={explain}
      title={waitingOnly ? (venueName ? t("apr.waitingAt", { venue: venueName }) : t("apr.r.waitingTitle")) : t("apr.r.allTitle")}
      hideWhenEmpty={waitingOnly}
      listUrl={`/api/admin/approvals?venueId=${venueId}${waitingOnly ? "&waiting=1" : ""}`}
      decideUrl="/api/admin/approvals"
      decideBody={(id, action, reason) => ({ venueId, id, action, reason })}
      documentUrl={(id) => `/api/admin/approvals/document?venueId=${venueId}&id=${id}`}
    />
  );
}
