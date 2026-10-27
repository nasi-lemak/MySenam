"use client";

import { useCallback, useEffect, useState } from "react";
import type { ApprovalRequest, Decision } from "@/lib/approvals";
import { activityIcon } from "@/lib/activity-registry";
import { formatMinute } from "@/lib/interval";
import { intlTag, region } from "@/lib/region";
import { DocumentLink } from "@/components/ApprovalDocumentLink";

/**
 * Reviewing applications to be approved for an activity (lib/approvals.ts):
 * the same screen for the venue's staff in the dashboard and for a coach
 * signed in to their own account, each reading it in their own dictionary
 * (the keys below are in both the staff and the customer dictionaries; those
 * about somebody an adult manages are `apr.child.*` for staff and
 * `guard.rv.*` for customers, see `customerKey`).
 */

export type ReviewKey =
  | "apr.r.none"
  | "apr.r.waitingTitle"
  | "apr.r.allTitle"
  | "apr.r.applied"
  | "apr.r.renewal"
  | "apr.r.answers"
  | "apr.r.noAnswer"
  | "apr.r.declared"
  | "apr.r.watched"
  | "apr.r.waiverAgreed"
  | "apr.r.adult"
  | "apr.r.minor"
  | "apr.r.cert"
  | "apr.r.documents"
  | "apr.r.document"
  | "apr.r.slot"
  | "apr.r.booked"
  | "apr.r.inPersonStep"
  | "apr.r.inPersonDone"
  | "apr.r.onlineAccepted"
  | "apr.r.validUntil"
  | "apr.r.untilTakenBack"
  | "apr.r.lapsesOn"
  | "apr.r.history"
  | "apr.r.approve"
  | "apr.r.approveOnline"
  | "apr.r.reject"
  | "apr.r.ask"
  | "apr.r.recordInPerson"
  | "apr.r.askPrompt"
  | "apr.r.rejectPrompt"
  | "apr.r.inPersonPrompt"
  | "apr.r.failed"
  | "apr.r.declaredNote"
  | "apr.r.check"
  | "apr.r.checked"
  | "apr.r.revoke"
  | "apr.r.revokePrompt"
  | "apr.r.revokedBecause"
  | "apr.r.payBy"
  | "apr.r.payLater"
  | "apr.status.pending"
  | "apr.status.info_requested"
  | "apr.status.in_person_due"
  | "apr.status.approved"
  | "apr.status.rejected"
  | "apr.status.withdrawn"
  | "apr.status.expired"
  | "apr.status.lapsed"
  | "apr.status.revoked"
  | "apr.slot.held"
  | "apr.slot.lapsed"
  | "apr.slot.released"
  | "apr.slot.booked"
  | "apr.slot.taken"
  | "apr.slot.awaiting_payment"
  | "apr.slot.payment_lapsed"
  | "apr.ev.submitted"
  | "apr.ev.renewal_submitted"
  | "apr.ev.slot_requested"
  | "apr.ev.answered"
  | "apr.ev.withdrawn"
  | "apr.ev.asked"
  | "apr.ev.rejected"
  | "apr.ev.online_accepted"
  | "apr.ev.in_person_recorded"
  | "apr.ev.approved"
  | "apr.ev.expired"
  | "apr.ev.hold_lapsed"
  | "apr.ev.slot_booked"
  | "apr.ev.session_booked"
  | "apr.ev.slot_taken"
  | "apr.ev.checked"
  | "apr.ev.revoked"
  | "apr.ev.payment_requested"
  | "apr.ev.pay_exception"
  | "apr.ev.paid"
  | "apr.ev.payment_lapsed"
  | "apr.ev.booking_cancelled"
  | "apr.ev.booking_released"
  | "apr.ev.bookings_flagged"
  | "apr.ev.late_payment_booked"
  | "apr.ev.late_payment_refund"
  | "apr.child.appliedBy"
  | "apr.child.rel.parent"
  | "apr.child.rel.guardian"
  | "apr.child.rel.other"
  | "apr.child.bornYear"
  | "apr.child.declaredNote"
  | "apr.child.authorityDeclared"
  | "apr.child.reviewAuthority"
  | "apr.child.authorityPrompt"
  | "apr.child.authorityReviewed"
  | "apr.child.authorityNeeded"
  | "apr.child.evReviewed"
  | "apr.scan.pending"
  | "apr.scan.rejected"
  | "apr.scan.failed"
  | "apr.scan.ev.scan_rejected"
  | "apr.scan.ev.scan_failed"
  | "apr.scan2.waiting"
  | "apr.scan2.ev.scan_requeued";

/** A review key as the customer dictionary has it: those about somebody managed are `guard.rv.*` there, a document's malware scan `scan.rv.*` (and `scan2.rv.*`). */
export function customerKey(key: string): string {
  if (key.startsWith("apr.scan.")) return `scan.rv.${key.slice("apr.scan.".length)}`;
  if (key.startsWith("apr.scan2.")) return `scan2.rv.${key.slice("apr.scan2.".length)}`;
  return key.startsWith("apr.child.") ? `guard.rv.${key.slice("apr.child.".length)}` : key;
}

/** Where a document's malware scan stands, for the reader; nothing for one that passed. */
export function scanText(say: Say, d: Pick<ApprovalRequest["documents"][number], "scan"> & { scanWaiting?: boolean }): string | null {
  if (d.scan === "clean") return null;
  // Failed only because no scanner answered: it waits, and is scanned by itself once one does.
  if (d.scan === "failed" && d.scanWaiting) return say("apr.scan2.waiting");
  return say(`apr.scan.${d.scan}` as ReviewKey);
}

export type Say = (key: ReviewKey, vars?: Record<string, string | number>) => string;

const EVENT_KEYS = new Set<string>([
  "submitted",
  "renewal_submitted",
  "slot_requested",
  "answered",
  "withdrawn",
  "asked",
  "rejected",
  "online_accepted",
  "in_person_recorded",
  "approved",
  "expired",
  "hold_lapsed",
  "slot_booked",
  "session_booked",
  "slot_taken",
  "checked",
  "revoked",
  "payment_requested",
  "pay_exception",
  "paid",
  "payment_lapsed",
  "booking_cancelled",
  "booking_released",
  "bookings_flagged",
  "late_payment_booked",
  "late_payment_refund",
]);

/** A moment, where the venue is, in the reader's language. */
export function when(at: string, locale: string): string {
  return new Date(at).toLocaleString(intlTag(locale), { timeZone: region().timeZone, dateStyle: "medium", timeStyle: "short" });
}

/** What an application's state is called, its lapsed or withdrawn approvals told apart. */
export function statusOf(say: Say, r: Pick<ApprovalRequest, "status" | "lapsed" | "revoked">): string {
  if (r.status === "approved" && r.revoked) return say("apr.status.revoked");
  if (r.status === "approved" && r.lapsed) return say("apr.status.lapsed");
  return say(`apr.status.${r.status}` as ReviewKey);
}

export function eventText(say: Say, action: string): string {
  if (action === "authority_reviewed") return say("apr.child.evReviewed");
  if (action === "scan_rejected" || action === "scan_failed") return say(`apr.scan.ev.${action}` as ReviewKey);
  if (action === "scan_requeued") return say("apr.scan2.ev.scan_requeued");
  return EVENT_KEYS.has(action) ? say(`apr.ev.${action}` as ReviewKey) : action;
}

const STATUS_STYLE: Record<string, string> = {
  pending: "bg-amber-100 text-amber-800",
  info_requested: "bg-sky-100 text-sky-800",
  in_person_due: "bg-violet-100 text-violet-800",
  approved: "bg-emerald-100 text-emerald-800",
};

export function StatusBadge({ say, request }: { say: Say; request: Pick<ApprovalRequest, "status" | "lapsed" | "revoked"> }) {
  const style = request.status === "approved" && (request.lapsed || request.revoked) ? "bg-slate-200 text-slate-700" : (STATUS_STYLE[request.status] ?? "bg-slate-200 text-slate-700");
  return <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${style}`}>{statusOf(say, request)}</span>;
}

/** An application's history, oldest first: who, when, what and why. */
export function History({ say, locale, request }: { say: Say; locale: string; request: ApprovalRequest }) {
  return (
    <details className="text-xs text-slate-600">
      <summary className="cursor-pointer font-medium">{say("apr.r.history")}</summary>
      <ul className="mt-1 space-y-0.5">
        {request.events.map((e, i) => (
          <li key={i}>
            {when(e.at, locale)} · {e.actorName} · {eventText(say, e.action)}
            {e.reason ? ` · “${e.reason}”` : ""}
          </li>
        ))}
      </ul>
    </details>
  );
}

export function slotText(request: ApprovalRequest, locale = "en"): string {
  if (!request.slot) return "";
  return `${request.slot.courtName} · ${request.slot.date} ${formatMinute(request.slot.start, locale)}–${formatMinute(request.slot.end, locale)}`;
}

/**
 * The reviewers' list: each application with what the customer answered and
 * declared, its documents, slot and history, and the decisions open to it.
 */
export function ApprovalReview({
  say,
  locale,
  activityLabel,
  listUrl,
  decideUrl,
  decideBody,
  documentUrl,
  title,
  hideWhenEmpty,
  onChange,
  explain,
  payLaterOption,
}: {
  say: Say;
  locale: string;
  activityLabel: (sport: string) => string;
  listUrl: string;
  decideUrl: string;
  decideBody: (id: number, action: Decision, reason: string | null, payLater: boolean) => Record<string, unknown>;
  documentUrl: (documentId: number) => string;
  title?: string;
  hideWhenEmpty?: boolean;
  onChange?: () => void;
  /** A refusal from the server, in the reader's language. */
  explain: (body: unknown) => string;
  /** Staff: approve without holding the booking for payment, as an exception on record. */
  payLaterOption?: boolean;
}) {
  const [requests, setRequests] = useState<ApprovalRequest[] | null>(null);
  const [payLater, setPayLater] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(() => {
    fetch(listUrl, { cache: "no-store" })
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(explain(data));
        setRequests(data.requests as ApprovalRequest[]);
      })
      .catch((err) => setError(err instanceof Error ? err.message : say("apr.r.failed")));
  }, [listUrl, say, explain]);
  useEffect(() => load(), [load]);

  async function act(r: ApprovalRequest, action: Decision) {
    let reason: string | null = null;
    if (action === "ask" || action === "reject" || action === "in_person" || action === "revoke" || action === "authority") {
      const prompt: ReviewKey =
        action === "ask"
          ? "apr.r.askPrompt"
          : action === "reject"
            ? "apr.r.rejectPrompt"
            : action === "revoke"
              ? "apr.r.revokePrompt"
              : action === "authority"
                ? "apr.child.authorityPrompt"
                : "apr.r.inPersonPrompt";
      reason = window.prompt(say(prompt, { name: r.name, adult: r.appliedBy ?? "" }));
      if (reason === null) return;
      if ((action === "ask" || action === "reject" || action === "revoke") && reason.trim() === "") return;
    }
    setBusy(r.id);
    setError(null);
    try {
      const res = await fetch(decideUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(decideBody(r.id, action, reason, payLater)) });
      const data = await res.json();
      if (!res.ok) throw new Error(explain(data));
      load();
      onChange?.();
    } catch (err) {
      setError(err instanceof Error ? err.message : say("apr.r.failed"));
    } finally {
      setBusy(null);
    }
  }

  if (requests === null) return error ? <p className="text-sm text-red-600">{error}</p> : null;
  if (requests.length === 0 && hideWhenEmpty) return null;
  return (
    <section className="space-y-2 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <h3 className="font-semibold">{title ?? say("apr.r.allTitle")}</h3>
      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      {requests.length === 0 && <p className="text-sm text-slate-500">{say("apr.r.none")}</p>}
      {payLaterOption && requests.some((r) => r.slot && (r.slot.status === "held" || r.slot.status === "lapsed")) && (
        <label className="flex items-center gap-2 text-xs text-slate-600">
          <input type="checkbox" checked={payLater} onChange={(e) => setPayLater(e.target.checked)} />
          {say("apr.r.payLater")}
        </label>
      )}
      <ul className="divide-y divide-slate-100">
        {requests.map((r) => {
          const live = r.status === "pending" || r.status === "info_requested" || r.status === "in_person_due";
          const mayApprove = r.status === "pending" || r.status === "info_requested";
          const approveKey: ReviewKey = r.inPersonStep && !r.inPersonAt ? "apr.r.approveOnline" : "apr.r.approve";
          return (
            <li key={r.id} className="space-y-1 py-3 text-sm">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-medium">
                  {activityIcon(r.sport)} {activityLabel(r.sport)} · {r.name} · {r.phone}
                </span>
                <StatusBadge say={say} request={r} />
              </div>
              <div className="text-xs text-slate-500">
                {say("apr.r.applied", { date: when(r.createdAt, locale) })}
                {r.renewalOf ? ` · ${say("apr.r.renewal")}` : ""}
                {live ? ` · ${say("apr.r.lapsesOn", { date: when(r.expiresAt, locale) })}` : ""}
                {r.status === "approved" ? ` · ${r.validUntil ? say("apr.r.validUntil", { date: r.validUntil }) : say("apr.r.untilTakenBack")}` : ""}
              </div>
              {r.questions.length > 0 && (
                <dl className="rounded-md bg-slate-50 p-2 text-xs">
                  <div className="mb-1 font-semibold text-slate-600">{say("apr.r.answers")}</div>
                  {r.questions.map((q) => (
                    <div key={q.id} className="mb-1">
                      <dt className="text-slate-500">{q.text}</dt>
                      <dd>{r.answers[q.id] ?? <span className="italic text-slate-400">{say("apr.r.noAnswer")}</span>}</dd>
                    </div>
                  ))}
                </dl>
              )}
              <ul className="text-xs text-slate-600">
                {r.declaredAt && <li>✓ {say("apr.r.declared", { date: when(r.declaredAt, locale) })}</li>}
                {r.videoWatchedAt && <li>✓ {say("apr.r.watched", { date: when(r.videoWatchedAt, locale) })}</li>}
                {r.waiverSignedAt && <li>✓ {say("apr.r.waiverAgreed")}</li>}
                {r.forPerson ? (
                  <>
                    <li className="font-medium text-slate-700">
                      {say("apr.child.appliedBy", {
                        adult: r.appliedBy ?? r.guardianName ?? "",
                        relationship: say(`apr.child.rel.${r.forPerson.relationship ?? "other"}` as ReviewKey),
                        name: r.forPerson.name,
                      })}
                      {r.forPerson.birthYear ? ` · ${say("apr.child.bornYear", { year: r.forPerson.birthYear })}` : ""}{" "}
                      <span className="font-normal text-slate-400">({say("apr.child.declaredNote")})</span>
                    </li>
                    {r.authorityDeclaredAt && <li>{say("apr.child.authorityDeclared", { date: when(r.authorityDeclaredAt, locale) })}</li>}
                    {r.authorityReviewedAt ? (
                      <li>✓ {say("apr.child.authorityReviewed", { name: r.authorityReviewedBy ?? "", date: when(r.authorityReviewedAt, locale) })}</li>
                    ) : (
                      r.guardianCheck && live && <li className="text-amber-700">{say("apr.child.authorityNeeded")}</li>
                    )}
                  </>
                ) : (
                  <li>
                    {r.declaredAdult ? say("apr.r.adult") : say("apr.r.minor", { name: r.guardianName ?? "", date: r.guardianDeclaredAt ? when(r.guardianDeclaredAt, locale) : "" })}{" "}
                    <span className="text-slate-400">({say("apr.r.declaredNote")})</span>
                  </li>
                )}
                {r.certReference && <li>📜 {say("apr.r.cert", { reference: r.certReference, date: r.certExpiresOn ?? "" })}</li>}
                {r.inPersonStep && (
                  <li>
                    {say("apr.r.inPersonStep", { step: r.inPersonStep })}:{" "}
                    {r.inPersonAt ? say("apr.r.inPersonDone", { name: r.inPersonBy ?? "", date: when(r.inPersonAt, locale) }) : "—"}
                  </li>
                )}
                {r.onlineOkAt && <li>{say("apr.r.onlineAccepted", { name: r.onlineOkBy ?? "", date: when(r.onlineOkAt, locale) })}</li>}
                {r.adminCheckedAt && <li>✓ {say("apr.r.checked", { name: r.adminCheckedBy ?? "", date: when(r.adminCheckedAt, locale) })}</li>}
                {r.revoked && r.revokeReason && <li>{say("apr.r.revokedBecause", { reason: r.revokeReason })}</li>}
                {r.slot && (
                  <li>
                    {say("apr.r.slot")}: {slotText(r)} · {say(`apr.slot.${r.slot.status}` as ReviewKey)}
                    {r.bookingCode ? ` · ${say("apr.r.booked", { code: r.bookingCode })}` : ""}
                    {r.slot.payBy ? ` · ${say("apr.r.payBy", { date: when(`${r.slot.payBy.replace(" ", "T")}Z`, locale) })}` : ""}
                  </li>
                )}
              </ul>
              {r.documents.length > 0 && (
                <div className="flex flex-wrap gap-2 text-xs">
                  <span className="text-slate-500">{say("apr.r.documents")}</span>
                  {r.documents.map((d) => (
                    <DocumentLink key={d.id} href={documentUrl(d.id)} document={d} status={scanText(say, d)} />
                  ))}
                </div>
              )}
              <History say={say} locale={locale} request={r} />
              {live && (
                <div className="flex flex-wrap gap-2 pt-1">
                  {mayApprove && (
                    <button type="button" disabled={busy === r.id} onClick={() => act(r, "approve")} className="rounded-md bg-teal-600 px-3 py-1 text-xs font-semibold text-white disabled:opacity-50">
                      {say(approveKey)}
                    </button>
                  )}
                  {r.inPersonStep && !r.inPersonAt && (
                    <button type="button" disabled={busy === r.id} onClick={() => act(r, "in_person")} className="rounded-md border border-violet-300 px-3 py-1 text-xs font-semibold text-violet-800 disabled:opacity-50">
                      {say("apr.r.recordInPerson")}
                    </button>
                  )}
                  {mayApprove && (
                    <button type="button" disabled={busy === r.id} onClick={() => act(r, "ask")} className="rounded-md border border-slate-300 px-3 py-1 text-xs disabled:opacity-50">
                      {say("apr.r.ask")}
                    </button>
                  )}
                  {!r.adminCheckedAt && (
                    <button type="button" disabled={busy === r.id} onClick={() => act(r, "check")} className="rounded-md border border-slate-300 px-3 py-1 text-xs disabled:opacity-50">
                      {say("apr.r.check")}
                    </button>
                  )}
                  {r.forPerson && !r.authorityReviewedAt && (
                    <button type="button" disabled={busy === r.id} onClick={() => act(r, "authority")} className="rounded-md border border-slate-300 px-3 py-1 text-xs disabled:opacity-50">
                      {say("apr.child.reviewAuthority")}
                    </button>
                  )}
                  <button type="button" disabled={busy === r.id} onClick={() => act(r, "reject")} className="rounded-md border border-red-200 px-3 py-1 text-xs text-red-700 disabled:opacity-50">
                    {say("apr.r.reject")}
                  </button>
                </div>
              )}
              {r.status === "approved" && !r.revoked && !r.lapsed && (
                <div className="pt-1">
                  <button type="button" disabled={busy === r.id} onClick={() => act(r, "revoke")} className="rounded-md border border-red-200 px-3 py-1 text-xs text-red-700 disabled:opacity-50">
                    {say("apr.r.revoke")}
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
