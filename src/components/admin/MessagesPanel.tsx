"use client";

import { useCallback, useEffect, useState } from "react";
import type { OutboxMessage, OutboxSummary } from "@/lib/outbox";
import { localTime } from "./shared";
import type { ManagedVenue } from "./shared";

const STATUS_STYLES: Record<string, string> = {
  sent: "bg-emerald-50 text-emerald-700",
  queued: "bg-slate-100 text-slate-600",
  failed: "bg-amber-50 text-amber-800",
  abandoned: "bg-red-50 text-red-700",
};

const KIND_LABELS: Record<string, string> = {
  booking_confirmed: "Booking confirmed",
  booking_series_confirmed: "Weekly series booked",
  booking_cancelled: "Booking cancelled",
  waitlist_offer: "Waitlist offer",
  class_enrolled: "Class enrolment",
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
  const [venueId, setVenueId] = useState(venues[0]?.id ?? 1);
  const [messages, setMessages] = useState<OutboxMessage[] | null>(null);
  const [summary, setSummary] = useState<OutboxSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [fixing, setFixing] = useState<{ id: number; recipient: string } | null>(null);
  const [open, setOpen] = useState<number | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch(venueId === PLATFORM ? "/api/admin/messages?platform=1" : `/api/admin/messages?venueId=${venueId}`, {
        cache: "no-store",
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not load messages");
      setMessages(data.messages);
      setSummary(data.summary);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load messages");
      setMessages(null);
    }
  }, [venueId]);

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
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not put it back in the queue");
      setNotice("Back in the queue.");
      setFixing(null);
      load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not put it back in the queue");
    }
  }

  return (
    <section>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-bold">Messages to customers</h2>
        {(venues.length > 1 || isOwner) && (
          <select
            value={venueId}
            onChange={(e) => setVenueId(Number(e.target.value))}
            className="rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-teal-500 focus:outline-none"
          >
            {venues.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
            {isOwner && <option value={PLATFORM}>Platform emails (applicants, resets, alerts)</option>}
          </select>
        )}
      </div>
      <p className="mt-1 text-sm text-slate-500">
        Confirmations, cancellations and waitlist offers, in whichever language the customer was
        reading. Written down first and sent after, so a booking is never lost to a message that
        would not go.
      </p>

      {summary && summary.transport === null && (
        <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <strong>Nothing is being sent yet.</strong> No WhatsApp or email account is configured,
          so messages are written down and queued — {summary.queued} of them so far. They will go
          out in order once one is set up; nothing is lost in the meantime.
        </div>
      )}

      {summary && summary.transport !== null && (
        <div className="mt-3 flex flex-wrap gap-2 text-sm">
          {(
            [
              ["Sent", summary.sent, "bg-emerald-50 text-emerald-800"],
              ["Waiting", summary.queued, "bg-slate-100 text-slate-700"],
              ["Retrying", summary.failed, "bg-amber-50 text-amber-800"],
              ["Given up", summary.abandoned, "bg-red-50 text-red-700"],
            ] as [string, number, string][]
          ).map(([label, n, style]) => (
            <span key={label} className={`rounded-lg px-3 py-1.5 font-medium ${style}`}>
              {label}: <strong>{n}</strong>
            </span>
          ))}
          <span className="rounded-lg px-3 py-1.5 text-slate-500">
            via{" "}
            {summary.transport
              .split("+")
              .map((name) => (name === "whatsapp" ? "WhatsApp" : name))
              .join(" and ")}
          </span>
        </div>
      )}

      {error && <p className="mt-3 text-sm font-medium text-red-700">{error}</p>}
      {notice && <p className="mt-3 text-sm font-medium text-emerald-700">{notice}</p>}

      <div className="mt-3 overflow-x-auto rounded-xl border border-slate-200 bg-white shadow-sm">
        {messages === null ? (
          <p className="p-8 text-center text-slate-500">Loading…</p>
        ) : messages.length === 0 ? (
          <p className="p-8 text-center text-slate-500">
            Nothing has been sent from this venue yet.
          </p>
        ) : (
          <table className="w-full min-w-[720px] text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                {["When", "What", "To", "Language", "State", ""].map((h) => (
                  <th key={h} className="px-3 py-2 font-semibold">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {messages.map((m) => (
                <tr key={m.id} className="border-b border-slate-100 align-top last:border-0">
                  <td className="whitespace-nowrap px-3 py-2 text-slate-500">
                    {localTime(m.createdAt)}
                  </td>
                  <td className="px-3 py-2">
                    <button
                      onClick={() => setOpen(open === m.id ? null : m.id)}
                      className="font-medium text-teal-700 hover:underline"
                    >
                      {KIND_LABELS[m.kind] ?? m.kind}
                    </button>
                    {m.free && (
                      <span title="Sent as a reply in a chat the customer opened, instead of a template" className="ml-1.5 rounded-full bg-emerald-50 px-2 py-0.5 text-[10px] font-semibold text-emerald-700">
                        reply in chat
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
                          ? "read"
                          : m.deliveredAt
                            ? "delivered"
                            : m.deliveryError
                              ? "not delivered"
                              : "sent"
                        : m.status}
                      {m.attempts > 0 && m.status !== "sent" && ` · ${m.attempts} tries`}
                    </span>
                    {m.deliveryError && <div className="mt-1 text-xs text-red-600">{m.deliveryError}</div>}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {m.status !== "sent" &&
                      (fixing?.id === m.id ? (
                        <div className="flex items-center justify-end gap-1.5">
                          <input
                            value={fixing.recipient}
                            onChange={(e) => setFixing({ id: m.id, recipient: e.target.value })}
                            className="w-32 rounded-md border border-slate-300 px-2 py-1 text-xs focus:border-teal-500 focus:outline-none"
                          />
                          <button
                            onClick={() => resend(m.id, fixing.recipient)}
                            className="rounded-md bg-teal-600 px-2.5 py-1 text-xs font-semibold text-white hover:bg-teal-700"
                          >
                            Send there
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
                            Try again
                          </button>
                          <button
                            onClick={() => setFixing({ id: m.id, recipient: m.recipient })}
                            className="text-xs text-slate-500 underline hover:text-teal-700"
                          >
                            wrong number?
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
