"use client";

import { useCallback, useEffect, useState } from "react";
import type { UrgentNotice } from "@/lib/urgent";
import type { OverdueRefunds } from "@/lib/payments";
import { money } from "@/lib/region";
import { formatHour } from "@/lib/time";

const REACH: Record<UrgentNotice["reach"], { label: string; style: string }> = {
  unreachable: { label: "No email or WhatsApp — call them", style: "bg-red-100 text-red-800" },
  failed: { label: "Message failed — call them", style: "bg-red-100 text-red-800" },
  waiting: { label: "Waiting to send", style: "bg-slate-100 text-slate-700" },
  sent: { label: "Sent, not yet seen", style: "bg-amber-100 text-amber-800" },
  delivered: { label: "Delivered to phone, not yet seen", style: "bg-amber-100 text-amber-800" },
  read: { label: "Read on WhatsApp", style: "bg-sky-100 text-sky-800" },
  acknowledged: { label: "Customer tapped “seen it”", style: "bg-emerald-100 text-emerald-800" },
  told: { label: "Told by staff", style: "bg-emerald-100 text-emerald-800" },
};

function channelLine(n: UrgentNotice) {
  return n.messages
    .map((m) => {
      const state = m.readAt ? "read" : m.deliveredAt ? "delivered" : m.error ? `failed: ${m.error}` : m.status;
      return `${m.channel === "whatsapp" ? "WhatsApp" : "Email"} ${state}`;
    })
    .join(" · ");
}

/**
 * News the venue gave a customer that the customer must not miss — a
 * cancellation, a closure, a move — until the customer says they have seen
 * it or staff record that they told them. Soonest booking first: that is the
 * one somebody might turn up for.
 */
export function AttentionPanel() {
  const [data, setData] = useState<{ open: UrgentNotice[]; recent: UrgentNotice[]; refundsOverdue?: OverdueRefunds[] } | null>(null);
  const [showRecent, setShowRecent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const res = await fetch("/api/admin/attention", { cache: "no-store" });
    if (res.ok) setData(await res.json());
  }, []);
  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), 60_000);
    // Straight after staff cancel or move something.
    const now = () => void load();
    window.addEventListener("attention:refresh", now);
    return () => {
      clearInterval(timer);
      window.removeEventListener("attention:refresh", now);
    };
  }, [load]);

  const overdue = data?.refundsOverdue ?? [];
  if (!data?.open || !data.recent || (data.open.length === 0 && data.recent.length === 0 && overdue.length === 0)) return null;

  return (
    <section className="rounded-xl border border-amber-300 bg-amber-50 p-4" aria-label="Needs attention">
      {overdue.length > 0 && (
        <div className="mb-3 rounded-lg border border-red-200 bg-white px-3 py-2 text-sm text-red-800">
          <strong>Refunds overdue.</strong>{" "}
          {overdue
            .map((v) => `${v.venueName}: ${v.count} (${money(v.amount)}), the oldest owed ${v.oldestDays} day${v.oldestDays === 1 ? "" : "s"}`)
            .join("; ")}
          . Customers were told a date that has passed: refund them under Online payments → Refunds owed.
        </div>
      )}
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-bold text-amber-900">
          {data.open.length > 0 ? `Needs attention (${data.open.length})` : overdue.length > 0 ? "Needs attention" : "Nothing needs attention"}
        </h2>
        {data.recent.length > 0 && (
          <button onClick={() => setShowRecent(!showRecent)} className="text-xs text-amber-800 underline">
            {showRecent ? "Hide" : `Closed this week (${data.recent.length})`}
          </button>
        )}
      </div>
      {data.open.length > 0 && (
        <p className="mt-1 text-xs text-amber-800">
          Customers the venue cancelled or moved, who have not yet said they have seen it. Ring anyone in red; mark
          them told once you have.
        </p>
      )}
      {error && <p className="mt-2 text-sm text-red-700">{error}</p>}
      <ul className="mt-3 space-y-2">
        {[...data.open, ...(showRecent ? data.recent : [])].map((n) => (
          <li key={n.id} className="rounded-lg bg-white p-3 text-sm shadow-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">
                {n.date} {formatHour(n.startHour)}
              </span>
              <span className="text-slate-500">{n.kind === "cancelled" ? "Cancelled" : "Moved"}</span>
              <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${REACH[n.reach].style}`}>{REACH[n.reach].label}</span>
            </div>
            <div className="mt-1">
              {n.name} ·{" "}
              <a href={`tel:${n.phone}`} className="text-teal-700 underline">
                {n.phone}
              </a>
              {n.email && <span className="text-slate-500"> · {n.email}</span>}
            </div>
            <div className="mt-1 text-xs text-slate-500">{n.summary}</div>
            {n.messages.length > 0 && <div className="mt-1 text-xs text-slate-500">{channelLine(n)}</div>}
            {n.resolvedAt === null && (
              <button
                onClick={async () => {
                  setError(null);
                  const res = await fetch("/api/admin/attention", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ id: n.id, action: "told" }),
                  });
                  const out = await res.json();
                  if (!res.ok) setError(out.error ?? "Could not save that.");
                  else setData(out);
                }}
                className="mt-2 rounded-md border border-teal-600 px-2.5 py-1 text-xs font-semibold text-teal-700 hover:bg-teal-50"
              >
                I have told them
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
