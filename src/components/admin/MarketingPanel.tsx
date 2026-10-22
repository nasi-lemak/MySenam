"use client";

import { useCallback, useEffect, useState } from "react";
import type { Audience } from "@/lib/marketing";
import { localTime } from "./shared";
import type { ManagedVenue } from "./shared";

/**
 * News and offers by email to customers who asked for them (lib/marketing.ts):
 * write it, send a copy to yourself, then send it. The footer saying why they
 * get it and how to stop is added to every copy.
 */
export function MarketingPanel({ venues }: { venues: ManagedVenue[] }) {
  const [venueId, setVenueId] = useState(venues[0]?.id ?? 0);
  const [data, setData] = useState<Audience | null>(null);
  const [subject, setSubject] = useState("");
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!venueId) return;
    const res = await fetch(`/api/admin/marketing?venueId=${venueId}`, { cache: "no-store" });
    const d = await res.json();
    if (res.ok) setData(d);
    else setError(d.error ?? "Could not load");
  }, [venueId]);

  useEffect(() => {
    load();
  }, [load]);

  async function post(action: "test" | "send") {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/marketing", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ venueId, action, subject, body }),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error ?? "Could not send");
      if (action === "test") setNotice(`A test copy is on its way to ${d.sentTo}.`);
      else {
        setNotice(`Sending to ${d.recipients}.`);
        setSubject("");
        setBody("");
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not send");
    } finally {
      setBusy(false);
    }
  }

  const input = "w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none";
  return (
    <section>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-bold">News to customers</h2>
        {venues.length > 1 && (
          <select value={venueId} onChange={(e) => setVenueId(Number(e.target.value))} aria-label="Venue" className="rounded-md border border-slate-300 px-2 py-1 text-sm">
            {venues.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        )}
      </div>
      <p className="mt-1 text-sm text-slate-500">
        By email, only to customers who ticked the box asking for news from this venue when they booked
        {data && (
          <>
            {": "}
            <span className="font-medium text-slate-700">{data.subscribed}</span> now
            {data.waiting > 0 && `, ${data.waiting} not yet confirmed (sent nothing until they do)`}
            {data.withdrawn > 0 && `, ${data.withdrawn} stopped`}
          </>
        )}
        .
      </p>
      <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
        Send only what you told them to expect: news and offers from this venue. Every copy ends with why they get it
        and a one-click unsubscribe, which you cannot remove. Booking messages are not for marketing, and there is no
        WhatsApp option. At most 4 in 30 days{data && ` (${data.left} left now)`}. Do not copy addresses out to send
        from elsewhere: they agreed to hear from you here.
      </div>
      {error && <p className="mt-2 text-sm text-rose-700">{error}</p>}
      {notice && <p className="mt-2 text-sm text-emerald-700">{notice}</p>}
      <div className="mt-3 max-w-2xl space-y-2">
        <input className={input} placeholder="Subject" maxLength={100} value={subject} onChange={(e) => setSubject(e.target.value)} aria-label="Subject" />
        <textarea className={input} rows={6} maxLength={3000} placeholder="What you want to tell them" value={body} onChange={(e) => setBody(e.target.value)} aria-label="Message" />
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy} onClick={() => void post("test")} className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium disabled:opacity-50">
            Send me a test
          </button>
          <button
            type="button"
            disabled={busy || !data || data.subscribed === 0 || data.left === 0}
            onClick={() => {
              if (data && window.confirm(`Email this to ${data.subscribed} customer${data.subscribed === 1 ? "" : "s"}? It cannot be called back.`)) void post("send");
            }}
            className="rounded-md bg-teal-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            Send to {data?.subscribed ?? 0}
          </button>
        </div>
      </div>
      {data && data.campaigns.length > 0 && (
        <ul className="mt-3 max-w-2xl divide-y divide-slate-100 rounded-lg border border-slate-200 text-sm">
          {data.campaigns.map((c) => (
            <li key={c.id} className="p-2">
              <p className="font-medium">{c.subject}</p>
              <p className="text-xs text-slate-500">
                {c.sentAt.slice(0, 10)} {localTime(c.sentAt)} · to {c.recipients}
                {c.sentBy && ` · by ${c.sentBy}`}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
