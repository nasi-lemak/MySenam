"use client";

import { readJson } from "@/lib/read-response";
import { useState } from "react";
import type { AuthorityReview } from "@/lib/youth-authority";
import type { EvidenceHold, ReviewDue } from "@/lib/youth-evidence";
import type { CaseOut, EscalationKind } from "@/lib/youth-report-cases";
import type { AppealItem } from "@/lib/youth-restrictions";
import { useStaffClock, useStaffT } from "./StaffLanguage";

/**
 * The staff screens of youth messaging's interim safeguards (docs/features/player-messages.md#interim-safeguards-pending-legal-review; ADR 0052): authority
 * reviews, legal holds and the retention review (the platform's owner), requests for a review of a restriction, and what a restriction in a case is and when it
 * is to be reviewed. Every wording says what the software does today as an interim measure and that the legal questions are pending review.
 */

const small = "min-h-9 rounded-md border border-slate-300 px-2 py-1 text-xs font-medium text-slate-700 hover:border-teal-500";
const field = "mt-1 w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm";
const ESCALATIONS: EscalationKind[] = ["suspected_abuse", "imminent_danger", "possible_reportable_incident", "other"];

/** The authority reviews that are this staff member's (a manager of the group's venue, or the owner): resolve, leave unclear, or escalate to the platform's owner. */
export function AuthorityReviewsSection({ reviews, onChanged }: { reviews: AuthorityReview[]; onChanged: () => void }) {
  const t = useStaffT();
  const clock = useStaffClock();
  const [error, setError] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<number, string>>({});

  async function act(body: Record<string, unknown>) {
    setError(null);
    const res = await fetch("/api/admin/youth-groups", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const data = await readJson(res).catch(() => null);
    if (!res.ok) return setError(t.err(data, t("ysg.actionFailed")));
    onChanged();
  }

  if (reviews.length === 0) return null;
  return (
    <section className="mt-4 space-y-2" aria-label={t("msg4.rev.title")} data-testid="authority-reviews">
      <h3 className="font-semibold text-slate-800">{t("msg4.rev.title")}</h3>
      <p className="text-xs text-slate-500">{t("msg4.rev.note")}</p>
      {error && (
        <p role="alert" className="text-red-600">
          {error}
        </p>
      )}
      <ul className="space-y-2">
        {reviews.map((r) => (
          <li key={r.id} className="space-y-1 rounded-lg border border-slate-200 px-3 py-2">
            <p className="font-medium">{t("msg4.rev.item", { child: r.child, group: r.groupName, cause: t(`msg4.rev.cause.${r.cause}`), when: clock.when(r.openedAt) })}</p>
            <ul className="text-xs text-slate-600">
              {r.guardians.map((g) => (
                <li key={g.guardianshipId}>
                  {t("msg4.rev.guardian", { name: g.name, status: t(`msg4.auth.status.${g.status}`), basis: t(`msg4.auth.basis.${g.basis}`), restrictions: t(`msg4.auth.restrictions.${g.restrictions}`) })}
                  {g.standard && <> · {t("msg4.auth.standard", { standard: g.standard })}</>}
                </li>
              ))}
            </ul>
            {r.escalated && <p className="text-xs text-slate-600">{t("msg4.rev.escalated")}</p>}
            <label className="block text-xs font-medium text-slate-600">
              {t("msg4.reasonLabel")}
              <input value={reasons[r.id] ?? ""} onChange={(e) => setReasons((had) => ({ ...had, [r.id]: e.target.value }))} maxLength={300} className={field} />
            </label>
            <div className="flex flex-wrap gap-2">
              <button className={small} onClick={() => void act({ action: "reviewClose", reviewId: r.id, outcome: "resolved", reason: reasons[r.id] ?? "" })}>
                {t("msg4.rev.resolve")}
              </button>
              <button className={small} onClick={() => void act({ action: "reviewClose", reviewId: r.id, outcome: "remains_unclear", reason: reasons[r.id] ?? "" })}>
                {t("msg4.rev.remains")}
              </button>
              {!r.escalated && (
                <button className={small} onClick={() => void act({ action: "reviewEscalate", reviewId: r.id })}>
                  {t("msg4.rev.escalate")}
                </button>
              )}
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** Legal holds and the retention review: the platform's owner only (anybody else gets nothing). A hold is a legal preservation measure, pending legal review. */
export function HoldsSection({ data, onChanged }: { data: { holds: EvidenceHold[]; due: ReviewDue } | null; onChanged: () => void }) {
  const t = useStaffT();
  const clock = useStaffClock();
  const [error, setError] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [form, setForm] = useState({ scope: "case", reportId: "", groupId: "", minorUserId: "", reference: "", reviewOn: "" });

  async function act(body: Record<string, unknown>) {
    setError(null);
    const res = await fetch("/api/admin/youth-groups", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const out = await readJson(res).catch(() => null);
    if (!res.ok) return setError(t.err(out, t("ysg.actionFailed")));
    onChanged();
  }

  if (!data) return null;
  const reason = (key: string) => reasons[key] ?? "";
  const setReason = (key: string, value: string) => setReasons((had) => ({ ...had, [key]: value }));
  const due = data.due;
  return (
    <section className="mt-4 space-y-2" aria-label={t("msg4.hold.title")} data-testid="evidence-holds">
      <h3 className="font-semibold text-slate-800">{t("msg4.hold.title")}</h3>
      <p className="text-xs text-slate-500">{t("msg4.hold.intro")}</p>
      {error && (
        <p role="alert" className="text-red-600">
          {error}
        </p>
      )}
      {(due.cases.length > 0 || due.holds.length > 0) && (
        <div className="space-y-1 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-amber-900">
          <p>{t("msg4.hold.dueCases", { cases: due.cases.length, holds: due.holds.length, months: due.months })}</p>
          <ul className="space-y-1 text-xs">
            {due.cases.map((c) => (
              <li key={c.reportId} className="flex flex-wrap items-center gap-2">
                <span>{t("msg4.hold.closedCase", { id: c.reportId, group: c.groupName ?? String(c.groupId), when: clock.when(c.closedAt) })}</span>
                <input aria-label={t("msg4.reasonLabel")} value={reason(`k${c.reportId}`)} onChange={(e) => setReason(`k${c.reportId}`, e.target.value)} maxLength={300} className="min-w-40 rounded-md border border-slate-300 px-2 py-1" />
                <button className={small} onClick={() => void act({ action: "keepCase", reportId: c.reportId, reason: reason(`k${c.reportId}`) })}>
                  {t("msg4.hold.keep")}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {data.holds.length === 0 && <p className="text-slate-500">{t("msg4.hold.none")}</p>}
      <ul className="space-y-2">
        {data.holds.map((h) => (
          <li key={h.id} className="space-y-1 rounded-lg border border-slate-200 px-3 py-2">
            <p>
              {t("msg4.hold.item", {
                id: h.id,
                group: h.groupName ?? String(h.groupId),
                reason: h.reason,
                scope: h.scope === "case" ? t("msg4.hold.scope.case", { report: h.reportId ?? 0 }) : t("msg4.hold.scope.child_group", { child: h.child ?? "" }),
              })}
              {h.reviewDue && <strong className="ml-2 text-amber-800">{t("msg4.hold.due")}</strong>}
            </p>
            {h.reference && <p className="text-xs text-slate-600">{h.reference}</p>}
            <input aria-label={t("msg4.reasonLabel")} value={reason(`h${h.id}`)} onChange={(e) => setReason(`h${h.id}`, e.target.value)} maxLength={300} className="w-full rounded-md border border-slate-300 px-2 py-1" />
            <div className="flex flex-wrap gap-2">
              <button className={small} onClick={() => void act({ action: "holdReview", holdId: h.id, reason: reason(`h${h.id}`) })}>
                {t("msg4.hold.review")}
              </button>
              <button className={small} onClick={() => void act({ action: "holdRelease", holdId: h.id, reason: reason(`h${h.id}`) })}>
                {t("msg4.hold.release")}
              </button>
            </div>
          </li>
        ))}
      </ul>
      <div className="space-y-2 rounded-lg border border-slate-200 px-3 py-2">
        <label className="block text-xs font-medium text-slate-600">
          {t("msg4.hold.scopeLabel")}
          <select value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value })} className={field}>
            <option value="case">{t("msg4.hold.reportLabel")}</option>
            <option value="child_group">{t("msg4.hold.childLabel")}</option>
          </select>
        </label>
        {form.scope === "case" ? (
          <label className="block text-xs font-medium text-slate-600">
            {t("msg4.hold.reportLabel")}
            <input inputMode="numeric" value={form.reportId} onChange={(e) => setForm({ ...form, reportId: e.target.value })} className={field} />
          </label>
        ) : (
          <>
            <label className="block text-xs font-medium text-slate-600">
              {t("msg4.hold.groupLabel")}
              <input inputMode="numeric" value={form.groupId} onChange={(e) => setForm({ ...form, groupId: e.target.value })} className={field} />
            </label>
            <label className="block text-xs font-medium text-slate-600">
              {t("msg4.hold.childLabel")}
              <input inputMode="numeric" value={form.minorUserId} onChange={(e) => setForm({ ...form, minorUserId: e.target.value })} className={field} />
            </label>
          </>
        )}
        <label className="block text-xs font-medium text-slate-600">
          {t("msg4.reasonLabel")}
          <input value={reason("new")} onChange={(e) => setReason("new", e.target.value)} maxLength={300} className={field} />
        </label>
        <label className="block text-xs font-medium text-slate-600">
          {t("msg4.hold.referenceLabel")}
          <input value={form.reference} onChange={(e) => setForm({ ...form, reference: e.target.value })} maxLength={200} className={field} />
        </label>
        <label className="block text-xs font-medium text-slate-600">
          {t("msg4.hold.reviewOnLabel")}
          <input value={form.reviewOn} onChange={(e) => setForm({ ...form, reviewOn: e.target.value })} placeholder="2027-01-31" className={field} />
        </label>
        <button
          className={small}
          onClick={() =>
            void act({
              action: "holdSet",
              scope: form.scope,
              reportId: Number(form.reportId) || undefined,
              groupId: Number(form.groupId) || undefined,
              minorUserId: Number(form.minorUserId) || undefined,
              reason: reason("new"),
              reference: form.reference,
              reviewOn: form.reviewOn,
            })
          }
        >
          {t("msg4.hold.set")}
        </button>
      </div>
    </section>
  );
}

/** Requests for a review of a restriction that are this staff member's to decide: never why the person is restricted, and never who reported (ADR 0052). */
export function AppealsSection({ items, onChanged }: { items: AppealItem[]; onChanged: () => void }) {
  const t = useStaffT();
  const clock = useStaffClock();
  const [error, setError] = useState<string | null>(null);
  const [reasons, setReasons] = useState<Record<string, string>>({});

  async function decide(id: number, outcome: "lifted" | "continues") {
    setError(null);
    const res = await fetch("/api/admin/message-moderation", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "appeal", id, outcome, reason: reasons[`r${id}`] ?? "", text: reasons[`t${id}`] ?? "" }),
    });
    const data = await readJson(res).catch(() => null);
    if (!res.ok) return setError(t.err(data, t("pmg.actionFailed")));
    onChanged();
  }

  if (items.length === 0) return null;
  return (
    <section className="mt-4 space-y-2" aria-label={t("msg4.app.title")} data-testid="restriction-appeals">
      <h3 className="font-semibold text-slate-800">{t("msg4.app.title")}</h3>
      <p className="text-xs text-slate-500">{t("msg4.app.note")}</p>
      {error && (
        <p role="alert" className="text-red-600">
          {error}
        </p>
      )}
      <ul className="space-y-2">
        {items.map((a) => (
          <li key={a.id} className="space-y-1 rounded-lg border border-slate-200 px-3 py-2">
            <p>{t("msg4.app.item", { person: a.person, group: a.groupName, when: clock.when(a.createdAt) })}</p>
            <p className="text-xs text-slate-600">{t(`msg4.app.kind.${a.restriction.kind}`)}</p>
            {a.message && <p className="whitespace-pre-wrap rounded bg-slate-50 px-2 py-1 text-slate-700">{a.message}</p>}
            <label className="block text-xs font-medium text-slate-600">
              {t("msg4.reasonLabel")}
              <input value={reasons[`r${a.id}`] ?? ""} onChange={(e) => setReasons((had) => ({ ...had, [`r${a.id}`]: e.target.value }))} maxLength={300} className={field} />
            </label>
            <label className="block text-xs font-medium text-slate-600">
              {t("msg4.app.textLabel")}
              <input value={reasons[`t${a.id}`] ?? ""} onChange={(e) => setReasons((had) => ({ ...had, [`t${a.id}`]: e.target.value }))} maxLength={600} className={field} />
            </label>
            <div className="flex flex-wrap gap-2">
              <button className={small} onClick={() => void decide(a.id, "lifted")}>
                {t("msg4.app.lift")}
              </button>
              <button className={small} onClick={() => void decide(a.id, "continues")}>
                {t("msg4.app.continue")}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * What a restriction in a case is (protective and not a finding, or a moderator's recorded decision), its age and when it is to be reviewed, the safeguarding
 * escalations recorded, the static guidance about danger and reporting, and the two controls that belong to it: convert to a decision, and escalate (safeguarding).
 */
export function CaseRestriction({
  c,
  reason,
  act,
}: {
  c: CaseOut;
  reason: string;
  act: (step: string, body?: Record<string, unknown>) => void;
}) {
  const t = useStaffT();
  const clock = useStaffClock();
  const [outcome, setOutcome] = useState("messaging_suspended");
  const [kind, setKind] = useState<EscalationKind>("suspected_abuse");
  const r = c.restriction;
  return (
    <div className="space-y-2" data-testid="case-restriction">
      {r && (
        <div className="space-y-1 rounded bg-white px-2 py-1 text-xs text-slate-700">
          <p>
            {r.kind === "decision" && r.decision
              ? t("msg4.case.kind.decision", { outcome: t(`msg4.case.outcome.${r.decision.outcome}`), reason: r.decision.reason ?? "" })
              : t("msg4.case.kind.protective")}
          </p>
          <p>
            {t("msg4.case.age", { days: r.ageDays })} {r.reviewBy && t("msg4.case.reviewBy", { when: clock.when(r.reviewBy) })}
          </p>
          {r.overdue && <p className="font-semibold text-red-700">{t("msg4.case.overdue")}</p>}
        </div>
      )}
      {c.appeals.length > 0 && (
        <ul className="space-y-0.5 text-xs text-slate-600">
          {c.appeals.map((a) => (
            <li key={a.id}>{t("msg4.case.appeal", { when: clock.when(a.at), state: t(a.status === "open" ? "msg4.case.appeal.open" : "msg4.case.appeal.decided") })}</li>
          ))}
        </ul>
      )}
      {c.safeguardingEscalations.length > 0 && (
        <ul className="space-y-0.5 text-xs text-red-800">
          {c.safeguardingEscalations.map((e, i) => (
            <li key={i}>{t("msg4.case.esc.done", { by: e.by, when: clock.when(e.at), kind: t(`msg4.esc.${e.kind}`) })}</li>
          ))}
        </ul>
      )}
      {r && r.kind === "protective" && c.reported.adult && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs font-medium text-slate-600">
            {t("msg4.case.outcomeLabel")}
            <select value={outcome} onChange={(e) => setOutcome(e.target.value)} className="mt-1 block rounded-md border border-slate-300 px-2 py-1.5 text-sm">
              <option value="removed_from_group">{t("msg4.case.outcome.removed_from_group")}</option>
              <option value="messaging_suspended">{t("msg4.case.outcome.messaging_suspended")}</option>
            </select>
          </label>
          <button className={small} onClick={() => act("decide", { reason, outcome })}>
            {t("msg4.case.decide")}
          </button>
        </div>
      )}
      {r && r.kind === "protective" && <p className="text-xs text-slate-500">{t("msg4.case.decideNote")}</p>}
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-xs font-medium text-slate-600">
          {t("msg4.case.esc.kindLabel")}
          <select value={kind} onChange={(e) => setKind(e.target.value as EscalationKind)} className="mt-1 block rounded-md border border-slate-300 px-2 py-1.5 text-sm">
            {ESCALATIONS.map((k) => (
              <option key={k} value={k}>
                {t(`msg4.esc.${k}`)}
              </option>
            ))}
          </select>
        </label>
        <button className={small} onClick={() => act("safeguarding", { reason, kind })}>
          {t("msg4.case.esc.go")}
        </button>
      </div>
      <p className="text-xs text-slate-500">{t("msg4.case.esc.note")}</p>
      <p role="note" className="rounded border border-red-200 bg-red-50 px-2 py-1 text-xs text-red-900" data-testid="safeguarding-guidance">
        {t("msg4.guidance")}
      </p>
    </div>
  );
}
