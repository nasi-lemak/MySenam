"use client";

import { useEffect, useState } from "react";

/**
 * The venue's bookings in staff's own calendar app: an address to subscribe
 * to, which a manager turns on, replaces (when it has gone somewhere it
 * should not) or turns off.
 */
export function CalendarFeedEditor({ venueId }: { venueId: number }) {
  const [url, setUrl] = useState<string | null | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setUrl(undefined);
    void fetch(`/api/admin/calendar-feed?venueId=${venueId}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d: { url?: string | null }) => setUrl(d.url ?? null));
  }, [venueId]);

  async function set(on: boolean) {
    if (!on && !confirm("Turn the calendar feed off? Calendars subscribed to it stop updating.")) return;
    if (on && url && !confirm("Make a new address? Calendars subscribed to the old one stop updating.")) return;
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      const res = await fetch("/api/admin/calendar-feed", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ venueId, on }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Could not save");
      setUrl(data.url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save");
    } finally {
      setBusy(false);
    }
  }

  if (url === undefined) return null;
  const webcal = url?.replace(/^https?:/, "webcal:");
  return (
    <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4 text-sm">
      <h3 className="font-semibold">Bookings in your own calendar</h3>
      <p className="mt-1 text-xs text-slate-500">
        Subscribe in Google Calendar, Outlook or your phone to see this venue&apos;s bookings and classes, from a week back
        to three months ahead, next to the rest of your day. It shows customers&apos; names and numbers: share it only with
        staff, and make a new address if it goes further.
      </p>
      {url ? (
        <>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input readOnly aria-label="Calendar address" value={url} className="min-w-0 flex-1 rounded-md border border-slate-300 bg-slate-50 px-2 py-1 font-mono text-xs" />
            <button
              onClick={() => navigator.clipboard.writeText(url).then(() => setCopied(true))}
              className="rounded-md border border-slate-300 px-3 py-1 text-xs font-semibold text-slate-700"
            >
              {copied ? "Copied" : "Copy"}
            </button>
          </div>
          <p className="mt-2 flex flex-wrap gap-3 text-xs font-medium">
            <a
              href={`https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal!)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-teal-700 underline"
            >
              Add to Google Calendar
            </a>
            <a href={webcal} className="text-teal-700 underline">
              Open in Apple or Outlook
            </a>
            <button disabled={busy} onClick={() => set(true)} className="text-slate-600 underline">
              Make a new address
            </button>
            <button disabled={busy} onClick={() => set(false)} className="text-red-700 underline">
              Turn off
            </button>
          </p>
        </>
      ) : (
        <button
          disabled={busy}
          onClick={() => set(true)}
          className="mt-2 rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
        >
          Turn on
        </button>
      )}
      {error && <p className="mt-2 text-xs font-medium text-red-700">{error}</p>}
    </div>
  );
}
