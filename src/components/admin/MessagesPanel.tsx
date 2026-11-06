"use client";

import { readJson } from "@/lib/read-response";
import { useCallback, useEffect, useState } from "react";
import type { OutboxMessage, OutboxSummary } from "@/lib/outbox";
import type { ManagedVenue } from "./shared";
import type { StaffPhrase } from "@/lib/staff-i18n";
import { useStaffClock, useStaffT } from "./StaffLanguage";

const STATUS_STYLES: Record<string, string> = {
  sent: "bg-emerald-50 text-emerald-700",
  queued: "bg-slate-100 text-slate-600",
  failed: "bg-amber-50 text-amber-800",
  abandoned: "bg-red-50 text-red-700",
};

const KIND_LABELS: Record<string, StaffPhrase> = {
  booking_confirmed: "msg.kind.bookingConfirmed",
  booking_series_confirmed: "msg.kind.seriesConfirmed",
  booking_cancelled: "msg.kind.bookingCancelled",
  waitlist_offer: "msg.kind.waitlistOffer",
  class_enrolled: "msg.kind.classEnrolled",
  waitlist_joined: "q8b.msg.kindJoined",
  class_changed: "r9d.msg.kindClassChanged",
  waitlist_ended: "fx2.msg.kindWaitlistEnded",
};

const STATE_LABELS: Record<string, StaffPhrase> = {
  sent: "msg.state.sent",
  queued: "msg.state.queued",
  failed: "msg.state.failed",
  abandoned: "msg.state.abandoned",
};

/**
 * What the venue has told its customers.
 *
 * The question this answers is "did they get it?", which until now had no
 * answer at all — a confirmation either arrived or it did not, and the desk
 * found out when somebody turned up confused. A message that could not be
 * delivered is worth seeing, and a wrong number is worth being able to fix
 * without re-making the booking.
 */
/** The choice that shows the platform's own emails (applicants, password resets, alerts to staff): owners only. */
const PLATFORM = 0;

export function MessagesPanel({ venues, isOwner = false }: { venues: ManagedVenue[]; isOwner?: boolean }) {
  const t = useStaffT();
  const clock = useStaffClock();
  const [venueId, setVenueId] = useState(venues[0]?.id ?? 1);
  const [messages, setMessages] = useState<OutboxMessage[] | null>(null);
  const [summary, setSummary] = useState<OutboxSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fixing, setFixing] = useState<{ id: number; recipient: string } | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [window24, setWindow24] = useState(72);
  const [resending, setResending] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(venueId === PLATFORM ? "/api/admin/messages?platform=1" : `/api/admin/messages?venueId=${venueId}`, {
        cache: "no-store",
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(t.err(data, t("msg.loadFailed")));
      setMessages(data.messages);
      setSummary(data.summary);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("msg.loadFailed"));
      setMessages(null);
    }
  }, [venueId, t]);

  useEffect(() => {
    load();
  }, [load]);

  async function resend(id: number, recipient?: string) {
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id, recipient }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(t.err(data, t("msg.requeueFailed")));
      setNotice(t("msg.requeued"));
      setFixing(null);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("msg.requeueFailed"));
    }
  }

  /** Every message of this venue that did not go in the chosen window, back in the queue (after a provider outage). */
  async function resendAll() {
    if (!window.confirm(t("srv.fx6.resend.confirm"))) return;
    setError(null);
    setNotice(null);
    setResending(true);
    try {
      const res = await fetch("/api/admin/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ resendFailed: true, venueId, hours: window24 }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(t.err(data, t("srv.fx6.resend.failed")));
      setNotice(
        (data.left > 0 ? t("srv.fx6.resend.doneSome", { n: data.requeued, left: data.left }) : t("srv.fx6.resend.done", { n: data.requeued })) +
          (data.more ? ` ${t("srv.fx6.resend.more")}` : "")
      );
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("srv.fx6.resend.failed"));
    } finally {
      setResending(false);
    }
  }

  return (
    <section>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-bold">{t("msg.title")}</h2>
        {(venues.length > 1 || isOwner) && (
          <select aria-label={t("q8b.l.venue")}
            value={venueId}
            onChange={(e) => setVenueId(Number(e.target.value))}
            className="rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-teal-500 focus:outline-none"
          >
            {venues.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
            {isOwner && <option value={PLATFORM}>{t("msg.platform")}</option>}
          </select>
        )}
      </div>
      <p className="mt-1 text-sm text-slate-500">
        {t("msg.intro")}
      </p>

      {summary && summary.transport === null && (
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <strong>{t("msg.nothingSent")}</strong> {t("msg.queuedNote", { n: summary.queued })}
        </div>
      )}

      {summary && summary.transport !== null && (
        <div className="mt-3 flex flex-wrap gap-2 text-sm">
          {(
            [
              ["msg.sum.sent", summary.sent, "bg-emerald-50 text-emerald-800"],
              ["msg.sum.waiting", summary.queued, "bg-slate-100 text-slate-700"],
              ["msg.sum.retrying", summary.failed, "bg-amber-50 text-amber-800"],
              ["msg.sum.givenUp", summary.abandoned, "bg-red-50 text-red-700"],
            ] as [StaffPhrase, number, string][]
          ).map(([label, n, style]) => (
            <span key={label} className={`rounded-lg px-3 py-1.5 font-medium ${style}`}>
              {t(label)}: <strong>{n}</strong>
            </span>
          ))}
          <span className="rounded-lg px-3 py-1.5 text-slate-500">
            {t("msg.via", {
              channels: summary.transport
                .split("+")
                .map((name) => (name === "whatsapp" ? "WhatsApp" : (t.known(`srv.transport.${name}`) ?? name)))
                .reduce((a, b) => t("msg.listAnd", { a, b })),
            })}
          </span>
        </div>
      )}

      {venueId !== PLATFORM && summary && summary.transport !== null && summary.failed + summary.abandoned > 0 && (
        <div className="mt-3 rounded-lg border border-slate-200 bg-white px-4 py-3 text-sm shadow-sm">
          <div className="font-semibold">{t("srv.fx6.resend.title")}</div>
          <p className="mt-0.5 text-xs text-slate-500">{t("srv.fx6.resend.intro")}</p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <label className="text-xs text-slate-600" htmlFor="resend-window">
              {t("srv.fx6.resend.window")}
            </label>
            <select
              id="resend-window"
              value={window24}
              onChange={(e) => setWindow24(Number(e.target.value))}
              className="rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-teal-500 focus:outline-none"
            >
              <option value={24}>{t("srv.fx6.resend.d1")}</option>
              <option value={72}>{t("srv.fx6.resend.d3")}</option>
              <option value={168}>{t("srv.fx6.resend.d7")}</option>
            </select>
            <button
              onClick={resendAll}
              disabled={resending}
              className="rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-teal-700 disabled:opacity-50"
            >
              {t("srv.fx6.resend.go")}
            </button>
          </div>
        </div>
      )}

      {error && <p className="mt-3 text-sm font-medium text-red-700">{error}</p>}
      {notice && <p className="mt-3 text-sm font-medium text-emerald-700">{notice}</p>}

      <div className="mt-3 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        {messages === null ? (
          <p className="p-8 text-center text-slate-500">{t("c.loading")}</p>
        ) : messages.length === 0 ? (
          <p className="p-8 text-center text-slate-500">
            {t("msg.none")}
          </p>
        ) : (
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                {(["msg.col.when", "msg.col.what", "msg.col.to", "msg.col.language", "msg.col.state", null] as const).map((h) => (
                  <th key={h ?? "actions"} className="px-3 py-2 font-semibold">
                    {h ? t(h) : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {messages.map((m) => (
                <tr key={m.id} className="border-b border-slate-100 align-top last:border-0">
                  <td className="whitespace-nowrap px-3 py-2 text-slate-500">
                    {clock.time(m.createdAt, venueId)}
                  </td>
                  <td className="px-3 py-2">
                    <button
                      onClick={() => setOpen(open === m.id ? null : m.id)}
                      className="font-medium text-teal-700 hover:underline"
                    >
                      {KIND_LABELS[m.kind] ? t(KIND_LABELS[m.kind]) : (t.known(`srv.msgKind.${m.kind}`) ?? m.kind)}
                    </button>
                    {m.free && (
                      <span title={t("msg.freeTitle")} className="ml-1.5 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                        {t("msg.replyInChat")}
                      </span>
                    )}
                    {open === m.id && (
                      <div className="mt-1.5 max-w-md whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-xs text-slate-700">
                        {m.subject && <div className="font-semibold">{m.subject}</div>}
                        {m.body}
                      </div>
                    )}
                    {m.lastError && (
                      <div className="mt-1 text-xs text-red-600">{m.lastError}</div>
                    )}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">{m.recipient}</td>
                  <td className="px-3 py-2 text-xs uppercase text-slate-500">{m.locale}</td>
                  <td className="px-3 py-2">
                    <span
                      className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${
                        STATUS_STYLES[m.status] ?? "bg-slate-100 text-slate-600"
                      }`}
                    >
                      {m.status === "sent" && m.channel === "whatsapp"
                        ? m.readAt
                          ? t("msg.state.read")
                          : m.deliveredAt
                            ? t("msg.state.delivered")
                            : m.deliveryError
                              ? t("msg.state.notDelivered")
                              : t("msg.state.sent")
                        : STATE_LABELS[m.status]
                          ? t(STATE_LABELS[m.status])
                          : m.status}
                      {m.attempts > 0 && m.status !== "sent" && ` · ${t("msg.tries", { n: m.attempts })}`}
                    </span>
                    {m.deliveryError && <div className="mt-1 text-xs text-red-600">{m.deliveryError}</div>}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {m.status !== "sent" &&
                      (fixing?.id === m.id ? (
                        <div className="flex items-center justify-end gap-1.5">
                          <input aria-label={t("q8b.l.recipient")}
                            value={fixing.recipient}
                            onChange={(e) => setFixing({ id: m.id, recipient: e.target.value })}
                            className="w-32 rounded-md border border-slate-300 px-2 py-1 text-xs focus:border-teal-500 focus:outline-none"
                          />
                          <button
                            onClick={() => resend(m.id, fixing.recipient)}
                            className="rounded-md bg-teal-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-teal-700"
                          >
                            {t("msg.sendThere")}
                          </button>
                          <button
                            onClick={() => setFixing(null)}
                            className="px-1.5 text-xs text-slate-500 hover:text-slate-700"
                          >
                            ✕
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center justify-end gap-2">
                          <button
                            onClick={() => resend(m.id)}
                            className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:border-teal-500 hover:text-teal-700"
                          >
                            {t("msg.tryAgain")}
                          </button>
                          <button
                            onClick={() => setFixing({ id: m.id, recipient: m.recipient })}
                            className="text-xs text-slate-500 underline hover:text-teal-700"
                          >
                            {t("msg.wrongNumber")}
                          </button>
                        </div>
                      ))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
