"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { ApprovalRequirement, FlaggedBooking, ReviewLevel } from "@/lib/approvals";
import { formatMinute } from "@/lib/interval";
import { activityIcon } from "@/lib/activity-registry";
import { courtSports } from "@/lib/court-activities";
import { sportLabel } from "@/lib/i18n";
import type { StaffT } from "@/lib/staff-i18n";
import type { Court } from "@/lib/types";
import { ApprovalReview, type Say } from "@/components/ApprovalReview";
import { useStaffT } from "./StaffLanguage";

/**
 * Online applications to be approved for an activity (lib/approvals.ts):
 * what the venue asks for each activity and who may grant it (managers), and
 * the applications to review (any of its staff; granting a safety-assessed
 * activity only a manager or front desk delegated for it; ADR 0020).
 */

const input = "rounded-md border border-slate-300 px-2 py-1.5 text-sm focus:border-teal-500 focus:outline-none";

interface CoachChoice {
  id: number;
  name: string;
  sports: string[];
  /** The MySenam account linked to the coach record (its email), through which they review; null: none. */
  account: string | null;
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
  reviewLevel: "safety" as ReviewLevel,
  delegateIds: [] as number[],
  payHours: "24",
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
    reviewLevel: r.reviewLevel,
    delegateIds: r.delegateIds,
    payHours: String(r.payHours),
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
  const [desk, setDesk] = useState<{ id: number; name: string }[]>([]);
  const [emails, setEmails] = useState<Record<number, string>>({});
  const [form, setForm] = useState(EMPTY);
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
        setDesk(data.desk ?? []);
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
      reviewLevel: form.reviewLevel,
      delegateIds: form.reviewLevel === "safety" ? form.delegateIds : [],
      payHours: Number(form.payHours),
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

  /** Link a coach to their own account (by its email), or unlink it: they review only signed in to it. */
  async function linkAccount(coachId: number, email: string | null) {
    setError(null);
    try {
      const res = await fetch("/api/admin/approvals/reviewers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ venueId, coachId, email }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(t.err(data));
      setEmails({ ...emails, [coachId]: "" });
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
                {" · "}
                {r.reviewLevel === "safety" ? t("apr.set.mSafety") : t("apr.set.mAdmin")}
              </span>
              <button type="button" onClick={() => setForm(formOf(r))} className="text-xs font-medium text-teal-700 hover:underline">
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
          <label className={label}>
            {t("apr.set.payHours")}
            <input inputMode="numeric" required value={form.payHours} onChange={(e) => setForm({ ...form, payHours: e.target.value })} className={`mt-1 w-24 ${input}`} />
          </label>
          <label className={label}>
            {t("apr.set.reviewLevel")}
            <select value={form.reviewLevel} onChange={(e) => setForm({ ...form, reviewLevel: e.target.value as ReviewLevel })} className={`mt-1 ${input}`}>
              <option value="safety">{t("apr.set.safety")}</option>
              <option value="administrative">{t("apr.set.administrative")}</option>
            </select>
          </label>
        </div>
        {form.reviewLevel === "safety" && desk.length > 0 && (
          <fieldset className="text-sm">
            <legend className="text-xs font-medium text-slate-500">{t("apr.set.delegates")}</legend>
            <div className="mt-1 flex flex-wrap gap-3">
              {desk.map((d) => (
                <label key={d.id} className="flex items-center gap-1">
                  <input
                    type="checkbox"
                    checked={form.delegateIds.includes(d.id)}
                    onChange={(e) => setForm({ ...form, delegateIds: e.target.checked ? [...form.delegateIds, d.id] : form.delegateIds.filter((id) => id !== d.id) })}
                  />
                  {d.name}
                </label>
              ))}
            </div>
          </fieldset>
        )}
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
            <ul className="mt-1 space-y-1">
              {coaches.map((c) => (
                <li key={c.id} className="flex flex-wrap items-center gap-2">
                  <label className="flex items-center gap-1">
                    <input
                      type="checkbox"
                      checked={form.coachIds.includes(c.id)}
                      onChange={(e) => setForm({ ...form, coachIds: e.target.checked ? [...form.coachIds, c.id] : form.coachIds.filter((id) => id !== c.id) })}
                    />
                    {c.name}
                  </label>
                  {c.account ? (
                    <span className="text-xs text-slate-500">
                      {t("apr.set.account", { email: c.account })}{" "}
                      <button type="button" onClick={() => void linkAccount(c.id, null)} className="text-teal-700 hover:underline">
                        {t("apr.set.unlink")}
                      </button>
                    </span>
                  ) : (
                    <span className="flex items-center gap-1 text-xs text-amber-700">
                      {t("apr.set.noAccount")}
                      <input
                        type="email"
                        placeholder={t("apr.set.accountEmail")}
                        value={emails[c.id] ?? ""}
                        onChange={(e) => setEmails({ ...emails, [c.id]: e.target.value })}
                        className={`w-48 ${input}`}
                      />
                      <button type="button" disabled={!(emails[c.id] ?? "").trim()} onClick={() => void linkAccount(c.id, emails[c.id] ?? null)} className="text-teal-700 hover:underline disabled:opacity-50">
                        {t("apr.set.link")}
                      </button>
                    </span>
                  )}
                </li>
              ))}
            </ul>
            <p className="mt-0.5 text-xs text-slate-400">{t("apr.set.coachesHint")}</p>
          </fieldset>
        )}
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
      decideBody={(id, action, reason, payLater) => ({ venueId, id, action, reason, ...(payLater ? { payLater: true } : {}) })}
      documentUrl={(id) => `/api/admin/approvals/document?venueId=${venueId}&id=${id}`}
      payLaterOption
    />
  );
}

/**
 * Bookings to decide after an approval was taken back: the person's confirmed
 * bookings of that activity here, flagged rather than cancelled. Staff cancel
 * one the ordinary way, arrange supervision, or keep it, and say which.
 */
export function RevocationFlags({ venueId }: { venueId: number }) {
  const t = useStaffT();
  const [flags, setFlags] = useState<FlaggedBooking[]>([]);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    fetch(`/api/admin/approvals?venueId=${venueId}&waiting=1`, { cache: "no-store" })
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(t.err(data));
        setFlags(data.flags ?? []);
      })
      .catch((err) => setError(err instanceof Error ? err.message : t("c.failed")));
  }, [venueId, t]);
  useEffect(() => load(), [load]);

  async function resolve(f: FlaggedBooking) {
    const note = window.prompt(t("apr.flags.resolvePrompt", { code: f.bookingCode }));
    if (note === null || note.trim() === "") return;
    try {
      const res = await fetch("/api/admin/approvals", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ venueId, flagId: f.id, action: "resolve_flag", note }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(t.err(data));
      setFlags(data.flags ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("c.failed"));
    }
  }

  if (flags.length === 0 && !error) return null;
  return (
    <section className="space-y-2 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm">
      <h3 className="font-semibold text-amber-900">{t("apr.flags.title")}</h3>
      <p className="text-xs text-amber-900">{t("apr.flags.intro")}</p>
      {error && <p className="text-red-700">{error}</p>}
      <ul className="divide-y divide-amber-100">
        {flags.map((f) => (
          <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
            <span>
              {t("apr.flags.line", { code: f.bookingCode, name: f.name, date: f.date, time: `${formatMinute(f.start)}–${formatMinute(f.end)}`, court: f.courtName })}
              {f.supervised ? ` · ${t("apr.flags.supervised")}` : ""}
            </span>
            <button type="button" onClick={() => void resolve(f)} className="rounded-md border border-amber-300 px-2 py-0.5 text-xs font-semibold text-amber-900">
              {t("apr.flags.resolve")}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Staff-supervised attendance (managers): where the venue's safety
 * procedures allow it, somebody not signed off attends with staff
 * supervising. On record; the booking gets no door code, and it signs
 * nobody off for later.
 */
export function SupervisedAttendance({ venueId }: { venueId: number }) {
  const t = useStaffT();
  const [code, setCode] = useState("");
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function send(on: boolean) {
    setMessage(null);
    try {
      const res = await fetch("/api/admin/approvals/supervised", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ venueId, code, supervised: on, note }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(t.err(data));
      setMessage({ ok: true, text: t("apr.sup.done") });
      setCode("");
      setNote("");
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : t("c.failed") });
    }
  }

  return (
    <section className="space-y-2 rounded-xl border border-slate-200 bg-white p-4 text-sm shadow-sm">
      <h3 className="font-semibold">{t("apr.sup.title")}</h3>
      <p className="text-xs text-slate-500">{t("apr.sup.intro")}</p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col text-xs font-medium text-slate-500">
          {t("apr.sup.code")}
          <input value={code} onChange={(e) => setCode(e.target.value)} className={`mt-1 w-32 ${input}`} />
        </label>
        <label className="flex flex-1 flex-col text-xs font-medium text-slate-500">
          {t("apr.sup.note")}
          <input value={note} onChange={(e) => setNote(e.target.value)} className={`mt-1 ${input}`} />
        </label>
        <button type="button" disabled={!code.trim() || !note.trim()} onClick={() => void send(true)} className="rounded-lg bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
          {t("apr.sup.on")}
        </button>
        <button type="button" disabled={!code.trim()} onClick={() => void send(false)} className="rounded-lg border border-slate-300 px-3 py-1.5 text-xs disabled:opacity-50">
          {t("apr.sup.off")}
        </button>
      </div>
      {message && <p className={message.ok ? "text-emerald-700" : "text-red-700"}>{message.text}</p>}
    </section>
  );
}
