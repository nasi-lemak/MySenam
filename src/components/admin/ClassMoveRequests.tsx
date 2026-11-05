"use client";

import { readJson } from "@/lib/read-response";
import { useCallback, useEffect, useState } from "react";
import type { MoveRequestView } from "@/lib/class-move-requests";
import { formatMinute } from "@/lib/interval";
import { shortDate } from "@/lib/region";
import { useStaffT } from "./StaffLanguage";
import { useStaffMay } from "./StaffMay";

/**
 * Front desk's class moves that wait for a manager (lib/class-move-requests.ts, ADR 0045), on the classes screen and in Needs attention: what was asked, why it
 * needs approval, who is affected (counts only), and for a manager Approve (the class moves and everyone is told) and Decline (with a reason; nothing moves).
 * The desk sees the same, without the buttons, and what became of what it asked.
 */
export function ClassMoveRequestList({
  requests,
  onChanged,
  onNotice,
}: {
  requests: MoveRequestView[];
  /** Something was decided: read the lists again. */
  onChanged: () => void;
  onNotice?: (text: string) => void;
}) {
  const t = useStaffT();
  const may = useStaffMay();
  const canDecide = may("classMoveDecide");
  const [declining, setDeclining] = useState<number | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(id: number, body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/class-move-requests/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const data = await readJson(res);
      if (!res.ok) {
        onChanged();
        throw new Error(t.err(data, t("cls3.req.failed")));
      }
      setDeclining(null);
      setReason("");
      onNotice?.(body.approve === true ? t("cls3.req.done.approved", { told: data.told ?? 0 }) : t("cls3.req.done.declined"));
      onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("cls3.req.failed"));
    } finally {
      setBusy(false);
    }
  }

  const at = (w: MoveRequestView["from"]) => `${shortDate(w.date, t.locale, true)} ${formatMinute(w.startMin, t.locale)}–${formatMinute(w.endMin, t.locale)}, ${w.courtName}`;
  const why = (r: MoveRequestView) => r.reasons.map((x) => t(`cls3.why.${x.code}`, { n: x.n ?? 0, limit: x.limit ?? 0 })).join("; ");
  const outcome = (r: MoveRequestView): string => {
    if (r.status === "approved") return t("cls3.req.approved", { by: r.decidedBy ?? "" });
    if (r.status === "declined") return t("cls3.req.declined", { by: r.decidedBy ?? "", reason: r.decisionNote ?? "" });
    if (r.status === "expired") return t("cls3.req.expired");
    return t(`cls3.req.closed.${r.closedReason === "started" || r.closedReason === "cancelled" ? r.closedReason : "changed"}`);
  };

  const open = requests.filter((r) => r.status === "open");
  const decided = requests.filter((r) => r.status !== "open");
  const card = (r: MoveRequestView) => (
    <li key={r.id} className="rounded-lg bg-white p-3 text-sm shadow-sm" data-testid={`move-request-${r.id}`}>
      <p className="font-medium">{t("cls3.req.line", { class: r.className, was: at(r.from), now: at(r.to) })}</p>
      <p className="text-xs text-slate-600">
        {t("cls3.req.by", { by: r.requestedBy, when: shortDate(r.createdAt.slice(0, 10), t.locale, true) })}
        {r.sessions > 1 ? ` · ${t("cls3.req.sessions", { n: r.sessions })}` : ""} · {t("cls3.req.counts", { enrolled: r.enrolled, waiting: r.waiting })}
      </p>
      <p className="mt-1 text-xs text-amber-900">{t("cls3.req.why", { why: why(r) })}</p>
      {r.note && <p className="mt-1 text-xs text-slate-600">{t("cls3.req.note", { note: r.note })}</p>}
      {r.status === "open" ? (
        <>
          <p className="mt-1 text-xs text-slate-500">{t("cls3.req.closes", { when: shortDate(r.expiresAt.slice(0, 10), t.locale, true) })}</p>
          {canDecide ? (
            declining === r.id ? (
              <div className="mt-2 flex flex-wrap items-end gap-2">
                <label className="flex flex-col gap-1 text-xs font-medium text-slate-600">
                  {t("cls3.req.reason")}
                  <input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} className="w-64 rounded-md border border-slate-300 px-2 py-1.5 text-sm" />
                </label>
                <button type="button" disabled={busy || reason.trim() === ""} onClick={() => void decide(r.id, { decline: true, reason })} className="rounded-md bg-red-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
                  {t("cls3.req.declineSend")}
                </button>
                <button type="button" onClick={() => setDeclining(null)} className="rounded-md border border-slate-300 px-3 py-1.5 text-xs">
                  {t("c.close")}
                </button>
              </div>
            ) : (
              <div className="mt-2 flex gap-2">
                <button type="button" disabled={busy} onClick={() => void decide(r.id, { approve: true })} className="rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-700 disabled:opacity-50">
                  {t("cls3.req.approve")}
                </button>
                <button type="button" disabled={busy} onClick={() => { setDeclining(r.id); setReason(""); }} className="rounded-md border border-red-300 px-3 py-1.5 text-xs font-medium text-red-700 hover:bg-red-50">
                  {t("cls3.req.decline")}
                </button>
              </div>
            )
          ) : (
            <p className="mt-1 text-xs font-medium text-slate-600">{t("cls3.req.waitingFor")}</p>
          )}
        </>
      ) : (
        <p className="mt-1 text-xs font-medium text-slate-700">{outcome(r)}</p>
      )}
    </li>
  );

  return (
    <div className="space-y-2" data-testid="class-move-requests">
      {error && <p className="text-sm font-medium text-red-700">{error}</p>}
      {open.length > 0 && (
        <div>
          <p className="text-sm font-semibold text-amber-900">{t("cls3.req.title", { n: open.length })}</p>
          <ul className="mt-1 space-y-2">{open.map(card)}</ul>
        </div>
      )}
      {decided.length > 0 && (
        <div>
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">{t("cls3.req.recent")}</p>
          <ul className="mt-1 space-y-2">{decided.map(card)}</ul>
        </div>
      )}
    </div>
  );
}

/** The classes screen's own list for a venue: loaded here, read again after a decision (and when a move was just asked for). */
export function ClassMoveRequestsSection({ venueId, refresh, onNotice, onDecided }: { venueId: number; refresh: number; onNotice: (text: string) => void; onDecided: () => void }) {
  const [requests, setRequests] = useState<MoveRequestView[]>([]);
  const load = useCallback(async () => {
    const res = await fetch(`/api/admin/class-move-requests?venueId=${venueId}`, { cache: "no-store" });
    if (res.ok) setRequests(((await readJson(res)).requests as MoveRequestView[]) ?? []);
  }, [venueId]);
  useEffect(() => {
    void load();
  }, [load, refresh]);
  if (requests.length === 0) return null;
  return (
    <section className="rounded-xl border border-amber-300 bg-amber-50 p-4">
      <ClassMoveRequestList
        requests={requests}
        onNotice={onNotice}
        onChanged={() => {
          void load();
          onDecided();
          window.dispatchEvent(new Event("attention:refresh"));
        }}
      />
    </section>
  );
}

interface Rules {
  deskMayMove: boolean;
  maxDays: number;
  maxSeries: number;
  withinHours: number;
  paidPeople: number | null;
  priceCheck: boolean;
  requestDays: number;
}

/** A manager's settings for front desk's class moves (lib/class-move-requests.ts `ClassMoveRules`): advanced, closed until opened. */
export function ClassMoveSettings({ venueId }: { venueId: number }) {
  const t = useStaffT();
  const [rules, setRules] = useState<Rules | null>(null);
  const [paid, setPaid] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    fetch(`/api/admin/class-move-settings?venueId=${venueId}`, { cache: "no-store" })
      .then(async (res) => {
        const data = await readJson(res);
        if (!res.ok) throw new Error(t.err(data, t("cls3.set.failed")));
        if (live) {
          setRules(data.rules as Rules);
          setPaid(data.rules.paidPeople === null ? "" : String(data.rules.paidPeople));
        }
      })
      .catch((err) => live && setError(err instanceof Error ? err.message : t("cls3.set.failed")));
    return () => {
      live = false;
    };
  }, [venueId, t]);
  if (!rules) return error ? <p className="text-sm text-red-700">{error}</p> : null;
  const num = "w-24 rounded-md border border-slate-300 px-2 py-1.5 text-sm";
  const field = "flex max-w-xs flex-col gap-1 text-xs font-medium text-slate-600";
  return (
    <details className="rounded-xl border border-slate-200 bg-white p-4">
      <summary className="cursor-pointer text-sm font-semibold text-slate-700">{t("cls3.set.title")}</summary>
      <form
        className="mt-3 flex flex-wrap items-end gap-3"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          setMessage(null);
          try {
            const res = await fetch("/api/admin/class-move-settings", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ venueId, ...rules, paidPeople: paid.trim() === "" ? null : Number(paid) }),
            });
            const data = await readJson(res);
            if (!res.ok) throw new Error(t.err(data, t("cls3.set.failed")));
            setRules(data.rules as Rules);
            setMessage(t("cls3.set.saved"));
          } catch (err) {
            setError(err instanceof Error ? err.message : t("cls3.set.failed"));
          }
        }}
      >
        <p className="w-full text-xs text-slate-600">{t("cls3.set.help")}</p>
          <label className="flex w-full items-center gap-2 text-sm">
            <input type="checkbox" checked={rules.deskMayMove} onChange={(e) => setRules({ ...rules, deskMayMove: e.target.checked })} />
            {t("cls3.set.deskMay")}
          </label>
          <label className={field}>
            {t("cls3.set.maxDays")}
            <input type="number" min={0} max={365} step={1} value={rules.maxDays} onChange={(e) => setRules({ ...rules, maxDays: Number(e.target.value) })} className={num} />
          </label>
          <label className={field}>
            {t("cls3.set.maxSeries")}
            <input type="number" min={0} max={52} step={1} value={rules.maxSeries} onChange={(e) => setRules({ ...rules, maxSeries: Number(e.target.value) })} className={num} />
          </label>
          <label className={field}>
            {t("cls3.set.within")}
            <input type="number" min={0} max={720} step={1} value={rules.withinHours} onChange={(e) => setRules({ ...rules, withinHours: Number(e.target.value) })} className={num} />
          </label>
          <label className={field}>
            {t("cls3.set.paid")}
            <input type="number" min={0} max={1000} step={1} value={paid} onChange={(e) => setPaid(e.target.value)} className={num} />
          </label>
          <label className="flex w-full items-center gap-2 text-sm">
            <input type="checkbox" checked={rules.priceCheck} onChange={(e) => setRules({ ...rules, priceCheck: e.target.checked })} />
            {t("cls3.set.price")}
          </label>
          <label className={field}>
            {t("cls3.set.requestDays")}
            <input type="number" min={1} max={60} step={1} value={rules.requestDays} onChange={(e) => setRules({ ...rules, requestDays: Number(e.target.value) })} className={num} />
          </label>
          <button type="submit" className="rounded-lg bg-teal-600 px-4 py-2 text-sm font-semibold text-white hover:bg-teal-700">
            {t("cls3.set.save")}
          </button>
        {message && <span className="text-xs font-medium text-emerald-700">{message}</span>}
        {error && <span className="text-xs font-medium text-red-700">{error}</span>}
      </form>
    </details>
  );
}
