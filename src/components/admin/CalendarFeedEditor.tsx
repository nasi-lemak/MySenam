"use client";

import { useEffect, useState } from "react";
import type { FeedStatus } from "@/lib/staff-calendar";
import { useStaffClock, useStaffT } from "./StaffLanguage";

type Feed = FeedStatus & { url: string | null };

const feedOf = (d: Partial<Feed>): Feed => ({
  on: d.on === true,
  madeAt: d.madeAt ?? null,
  expiresAt: d.expiresAt ?? null,
  lapsed: d.lapsed === true,
  url: d.url ?? null,
});

/**
 * The venue's bookings in staff's own calendar app: an address to subscribe
 * to, which a manager turns on, replaces (when it has gone somewhere it
 * should not, or has lapsed) or turns off. Each address lapses after a year
 * (lib/staff-calendar.ts).
 */
export function CalendarFeedEditor({ venueId }: { venueId: number }) {
  const t = useStaffT();
  const clock = useStaffClock();
  const [feed, setFeed] = useState<Feed | undefined>(undefined);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setFeed(undefined);
    void fetch(`/api/admin/calendar-feed?venueId=${venueId}`, { cache: "no-store" })
      .then((r) => r.json())
      .then((d: Partial<Feed>) => setFeed(feedOf(d)));
  }, [venueId]);

  async function set(on: boolean) {
    if (!on && !confirm(t("cal.offConfirm"))) return;
    if (on && feed?.on && !feed.lapsed && !confirm(t("cal.newConfirm"))) return;
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
      if (!res.ok) throw new Error(t.err(data, t("vn.couldNotSave")));
      setFeed(feedOf(data));
    } catch (err) {
      setError(err instanceof Error ? err.message : t("vn.couldNotSave"));
    } finally {
      setBusy(false);
    }
  }

  if (feed === undefined) return null;
  const { url } = feed;
  const webcal = url?.replace(/^https?:/, "webcal:");
  const until = feed.expiresAt ? clock.day(feed.expiresAt, venueId) : "";
  const replaceOrOff = (
    <>
      <button disabled={busy} onClick={() => set(true)} className="text-slate-600 underline">
        {t("cal.newAddress")}
      </button>
      <button disabled={busy} onClick={() => set(false)} className="text-red-700 underline">
        {t("cal.turnOff")}
      </button>
    </>
  );
  return (
    <div className="mt-4 rounded-xl border border-slate-200 bg-white p-4 text-sm">
      <h3 className="font-semibold">{t("cal.title")}</h3>
      <p className="mt-1 text-xs text-slate-500">{t("cal.intro")}</p>
      {url ? (
        <>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <input readOnly aria-label={t("cal.address")} value={url} className="min-w-0 flex-1 rounded-md border border-slate-300 bg-slate-50 px-2 py-1 font-mono text-xs" />
            <button
              onClick={() => navigator.clipboard.writeText(url).then(() => setCopied(true))}
              className="rounded-md border border-slate-300 px-3 py-1 text-xs font-semibold text-slate-700"
            >
              {copied ? t("c.copied") : t("c.copy")}
            </button>
          </div>
          {until && <p className="mt-1 text-xs text-slate-500">{t("d8a.cal.until", { date: until })}</p>}
          <p className="mt-2 flex flex-wrap gap-3 text-xs font-medium">
            <a
              href={`https://calendar.google.com/calendar/r?cid=${encodeURIComponent(webcal!)}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-teal-700 underline"
            >
              {t("cal.addGoogle")}
            </a>
            <a href={webcal} className="text-teal-700 underline">
              {t("cal.openApple")}
            </a>
            {replaceOrOff}
          </p>
        </>
      ) : feed.on ? (
        <>
          <p className={`mt-2 text-xs ${feed.lapsed ? "font-medium text-red-700" : "text-slate-600"}`}>
            {t(feed.lapsed ? "d8a.cal.lapsed" : "d8a.cal.onHidden", { date: until })}
          </p>
          <p className="mt-2 flex flex-wrap gap-3 text-xs font-medium">{replaceOrOff}</p>
        </>
      ) : (
        <button
          disabled={busy}
          onClick={() => set(true)}
          className="mt-2 rounded-md bg-teal-600 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50"
        >
          {t("cal.turnOn")}
        </button>
      )}
      {error && <p className="mt-2 text-xs font-medium text-red-700">{error}</p>}
    </div>
  );
}
