"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ApprovalRequest } from "@/lib/approvals";
import { activityIcon } from "@/lib/activity-registry";
import { sportLabel, type Phrase, type T } from "@/lib/i18n";
import { useT } from "@/components/Language";
import { ApprovalForm, SlotFields, explainApproval, slotBody, type ApplyInfo } from "@/components/ApprovalForm";
import { History, StatusBadge, slotText, when, type Say } from "@/components/ApprovalReview";

/**
 * The customer's applications to be approved for an activity, and where they
 * stand (lib/approvals.ts): what is waiting on whom, a question to answer, a
 * slot held or booked, when an approval runs out; and, from a venue's page,
 * the form to apply.
 */
export default function ApprovalsPage() {
  const t = useT();
  const say: Say = useCallback((key, vars) => t(key as Phrase, vars), [t]);
  const [requests, setRequests] = useState<ApprovalRequest[] | null>(null);
  const [courts, setCourts] = useState<Record<string, { id: number; name: string }[]>>({});
  const [info, setInfo] = useState<ApplyInfo | null | undefined>(undefined);
  const [signedOut, setSignedOut] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const asked = useMemo(() => {
    if (typeof window === "undefined") return null;
    const q = new URLSearchParams(window.location.search);
    const venueId = Number(q.get("venueId"));
    const sport = q.get("sport");
    return Number.isInteger(venueId) && venueId > 0 && sport ? { venueId, sport } : null;
  }, []);

  const load = useCallback(async () => {
    const res = await fetch(`/api/my/approvals${asked ? `?venueId=${asked.venueId}&sport=${encodeURIComponent(asked.sport)}` : ""}`, { cache: "no-store" });
    if (res.status === 401) return setSignedOut(true);
    const data = await res.json();
    if (!res.ok) return setError(explainApproval(t, data));
    setRequests(data.requests);
    setCourts(data.courts ?? {});
    setInfo(asked ? (data.apply ?? null) : undefined);
  }, [asked, t]);
  useEffect(() => {
    void load();
  }, [load]);

  if (signedOut)
    return (
      <div className="mx-auto max-w-xl space-y-3">
        <h1 className="text-2xl font-bold">{t("apr.title")}</h1>
        <p className="text-sm text-slate-600">{t("apr.signInFirst")}</p>
        <Link href={`/login?next=${encodeURIComponent(typeof window === "undefined" ? "/account/approvals" : window.location.pathname + window.location.search)}`} className="text-teal-700 underline">
          {t("nav.signIn")}
        </Link>
      </div>
    );
  if (requests === null) return error ? <p className="text-sm text-red-600">{error}</p> : null;
  const live = asked ? requests.find((r) => r.venueId === asked.venueId && r.sport === asked.sport && ["pending", "info_requested", "in_person_due"].includes(r.status)) : undefined;
  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <div>
        <h1 className="text-2xl font-bold">{t("apr.title")}</h1>
        <p className="mt-1 text-sm text-slate-600">{t("apr.intro")}</p>
      </div>
      {notice && <div className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800">{notice}</div>}
      {error && <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>}
      {asked && info === null && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{t("apr.notOffered")}</p>}
      {asked && info && !live && (
        <ApprovalForm
          info={info}
          onDone={() => {
            setNotice(t("apr.sent"));
            window.history.replaceState(null, "", "/account/approvals");
            setInfo(undefined);
            void load();
          }}
        />
      )}
      {requests.length === 0 && !asked && <p className="text-sm text-slate-500">{t("apr.none")}</p>}
      <ul className="space-y-3">
        {requests.map((r) => (
          <RequestCard
            key={r.id}
            t={t}
            say={say}
            request={r}
            courts={courts[`${r.venueId}:${r.sport}`] ?? []}
            onChange={(msg) => {
              if (msg) setNotice(msg);
              void load();
            }}
            onError={setError}
          />
        ))}
      </ul>
      <Link href="/account" className="text-sm text-teal-700 underline">
        {t("apr.backToAccount")}
      </Link>
    </div>
  );
}

function RequestCard({
  t,
  say,
  request: r,
  courts,
  onChange,
  onError,
}: {
  t: T;
  say: Say;
  request: ApprovalRequest;
  courts: { id: number; name: string }[];
  onChange: (notice?: string) => void;
  onError: (e: string | null) => void;
}) {
  const [answer, setAnswer] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [slot, setSlot] = useState({ courtId: r.slot ? String(r.slot.courtId) : "", date: "", start: "", end: "" });
  const [busy, setBusy] = useState(false);
  const live = r.status === "pending" || r.status === "info_requested" || r.status === "in_person_due";
  const question = [...r.events].reverse().find((e) => e.action === "asked");
  const decision = [...r.events].reverse().find((e) => e.action === "rejected");
  const renewable = (r.status === "approved" && (r.lapsed || r.revoked || (r.validUntil !== null && daysUntil(r.validUntil) <= 30))) || r.status === "expired" || r.status === "withdrawn" || r.status === "rejected";
  const mayAskSlot = live && !r.bookingCode && courts.length > 0 && (!r.slot || r.slot.status !== "held");

  async function send(body: Record<string, unknown>, done: string, withFiles = false) {
    setBusy(true);
    onError(null);
    try {
      let init: RequestInit = { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
      if (withFiles && files.length > 0) {
        const form = new FormData();
        form.set("data", JSON.stringify(body));
        for (const f of files) form.append("document", f);
        init = { method: "POST", body: form };
      }
      const res = await fetch(`/api/my/approvals/${r.id}`, init);
      const data = await res.json();
      if (!res.ok) throw new Error(explainApproval(t, data));
      onChange(done);
    } catch (err) {
      onError(err instanceof Error ? err.message : t("apr.failed"));
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="space-y-2 rounded-xl border border-slate-200 bg-white p-4 text-sm shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="font-semibold">
          {activityIcon(r.sport)} {t("apr.cardTitle", { activity: sportLabel(t, r.sport), venue: r.venueName })}
        </span>
        <StatusBadge say={say} request={r} />
      </div>
      <p className="text-slate-700">{explainStatus(t, r)}</p>
      {r.status === "info_requested" && question?.reason && (
        <div className="space-y-2 rounded-lg bg-sky-50 p-3">
          <p className="text-sky-900">
            <span className="font-medium">{t("apr.theyAsked", { name: question.actorName })}</span> {question.reason}
          </p>
          <textarea rows={3} maxLength={2000} value={answer} onChange={(e) => setAnswer(e.target.value)} className="block w-full rounded-md border border-slate-300 px-2 py-1.5" />
          {r.documents.length < 3 && (
            <input type="file" multiple accept="image/jpeg,image/png,image/webp" onChange={(e) => setFiles([...(e.target.files ?? [])].slice(0, 3))} className="block text-xs" />
          )}
          <button type="button" disabled={busy} onClick={() => send({ action: "answer", answer }, t("apr.answerSent"), true)} className="rounded-md bg-teal-600 px-3 py-1 text-xs font-semibold text-white disabled:opacity-50">
            {t("apr.sendAnswer")}
          </button>
        </div>
      )}
      {r.status === "rejected" && decision?.reason && <p className="rounded-lg bg-red-50 p-2 text-red-800">{t("apr.why", { reason: decision.reason })}</p>}
      {r.slot && (
        <p className="text-slate-600">
          {t("apr.slotLine", { slot: slotText(r) })} · {slotState(t, r)}
          {r.bookingCode && (
            <>
              {" · "}
              <Link href={`/my-booking?code=${r.bookingCode}`} className="text-teal-700 underline">
                {r.bookingCode}
              </Link>
            </>
          )}
        </p>
      )}
      {r.slot && (r.slot.status === "taken" || r.slot.status === "lapsed") && !r.bookingCode && (
        <p className="text-xs text-slate-600">
          {t("apr.slotGoneHelp")}{" "}
          <Link
            href={`/venue/${r.venueId}?date=${r.slot.date}&sport=${r.sport}&court=${r.slot.courtId}&start=${r.slot.start}&minutes=${r.slot.end - r.slot.start}`}
            className="text-teal-700 underline"
          >
            {t("apr.slotGoneLink")}
          </Link>
        </p>
      )}
      {mayAskSlot && (
        <details className="text-xs">
          <summary className="cursor-pointer font-medium text-teal-700">{r.status === "in_person_due" ? t("apr.bookSession") : t("apr.askSlot")}</summary>
          <div className="mt-2 space-y-2">
            <SlotFields courts={courts} value={slot} onChange={setSlot} />
            <button
              type="button"
              disabled={busy || !slotBody(slot)}
              onClick={() => send({ action: "slot", slot: slotBody(slot) }, r.status === "in_person_due" ? t("apr.sessionBooked") : t("apr.slotHeld"))}
              className="rounded-md bg-teal-600 px-3 py-1 font-semibold text-white disabled:opacity-50"
            >
              {t("apr.askSlotSend")}
            </button>
          </div>
        </details>
      )}
      {r.documents.length > 0 && (
        <div className="flex flex-wrap gap-2 text-xs">
          <span className="text-slate-500">{t("apr.yourDocuments")}</span>
          {r.documents.map((d, i) => (
            <a key={d.id} href={`/api/my/approvals/document?id=${d.id}`} target="_blank" rel="noreferrer" className="text-teal-700 underline">
              {t("apr.r.document", { n: i + 1 })}
            </a>
          ))}
        </div>
      )}
      <History say={say} locale={t.locale} request={r} />
      <div className="flex flex-wrap gap-3 text-xs">
        {live && (
          <button
            type="button"
            disabled={busy}
            onClick={() => window.confirm(t("apr.withdrawConfirm")) && void send({ action: "withdraw" }, t("apr.withdrawn"))}
            className="text-red-600 underline"
          >
            {t("apr.withdraw")}
          </button>
        )}
        {renewable && (
          <Link href={`/account/approvals?venueId=${r.venueId}&sport=${encodeURIComponent(r.sport)}`} className="font-medium text-teal-700 underline">
            {r.status === "approved" ? t("apr.renew") : t("apr.applyAgain")}
          </Link>
        )}
      </div>
    </li>
  );
}

function daysUntil(date: string): number {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.now()) / 86_400_000);
}

/** Where an application stands, in a sentence. */
function explainStatus(t: T, r: ApprovalRequest): string {
  if (r.status === "approved") {
    if (r.revoked) return t("apr.explain.revoked");
    if (r.lapsed) return t("apr.explain.lapsed", { date: r.validUntil ?? "" });
    return r.validUntil ? t("apr.explain.approvedUntil", { date: r.validUntil }) : t("apr.explain.approved");
  }
  if (r.status === "in_person_due") return t("apr.explain.in_person_due", { step: r.inPersonStep ?? "" });
  if (r.status === "pending" || r.status === "info_requested") return t(`apr.explain.${r.status}`, { date: when(r.expiresAt, t.locale) });
  return t(`apr.explain.${r.status}`);
}

function slotState(t: T, r: ApprovalRequest): string {
  if (!r.slot) return "";
  if (r.slot.status === "held" && r.slot.holdUntil) return t("apr.slotHeldUntil", { date: when(r.slot.holdUntil, t.locale) });
  return t(`apr.slot.${r.slot.status}`);
}
