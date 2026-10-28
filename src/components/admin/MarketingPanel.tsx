"use client";

import { useCallback, useEffect, useState } from "react";
import type { Audience } from "@/lib/marketing";
import type { ManagedVenue } from "./shared";
import { useStaffClock, useStaffT } from "./StaffLanguage";

/**
 * News and offers by email to customers who asked for them (lib/marketing.ts):
 * write it, send a copy to yourself, then send it. The footer saying why they
 * get it and how to stop is added to every copy.
 */
export function MarketingPanel({ venues }: { venues: ManagedVenue[] }) {
  const t = useStaffT();
  const clock = useStaffClock();
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
    else setError(t.err(d, t("mkt.loadFailed")));
  }, [venueId, t]);

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
      if (!res.ok) throw new Error(t.err(d, t("mkt.sendFailed")));
      if (action === "test") setNotice(t("mkt.testSent", { to: d.sentTo }));
      else {
        setNotice(t("mkt.sending", { n: d.recipients }));
        setSubject("");
        setBody("");
      }
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : t("mkt.sendFailed"));
    } finally {
      setBusy(false);
    }
  }

  // "{n} now", split where the count goes so it can sit in its own element.
  const now = t("mkt.now", { n: "\u0000" }).split("\u0000");
  const input = "w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none";
  return (
    <section>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-bold">{t("mkt.title")}</h2>
        {venues.length > 1 && (
          <select value={venueId} onChange={(e) => setVenueId(Number(e.target.value))} aria-label={t("c.venue")} className="rounded-md border border-slate-300 px-2 py-1 text-sm">
            {venues.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        )}
      </div>
      <p className="mt-1 text-sm text-slate-500">
        {t("mkt.intro")}
        {data && (
          <>
            {": "}
            {now[0]}
            <span className="font-medium text-slate-700">{data.subscribed}</span>
            {now[1]}
            {data.waiting > 0 && `, ${t("mkt.waiting", { n: data.waiting })}`}
            {data.withdrawn > 0 && `, ${t("mkt.stopped", { n: data.withdrawn })}`}
          </>
        )}
        .
      </p>
      <div className="mt-2 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">
        {t("mkt.rules")} {data ? t("mkt.limitLeft", { n: data.left }) : t("mkt.limit")} {t("mkt.noCopying")}
      </div>
      {error && <p className="mt-2 text-sm text-rose-700">{error}</p>}
      {notice && <p className="mt-2 text-sm text-emerald-700">{notice}</p>}
      <div className="mt-3 max-w-2xl space-y-2">
        <input className={input} placeholder={t("mkt.subject")} maxLength={100} value={subject} onChange={(e) => setSubject(e.target.value)} aria-label={t("mkt.subject")} />
        <textarea className={input} rows={6} maxLength={3000} placeholder={t("mkt.bodyPh")} value={body} onChange={(e) => setBody(e.target.value)} aria-label={t("mkt.message")} />
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy} onClick={() => void post("test")} className="rounded-md border border-slate-300 px-4 py-2 text-sm font-medium disabled:opacity-50">
            {t("mkt.test")}
          </button>
          <button
            type="button"
            disabled={busy || !data || data.subscribed === 0 || data.left === 0}
            onClick={() => {
              if (data && window.confirm(t.plural("mkt.sendConfirm", data.subscribed))) void post("send");
            }}
            className="rounded-md bg-teal-600 px-4 py-2 text-sm font-semibold text-white disabled:opacity-50"
          >
            {t("mkt.sendTo", { n: data?.subscribed ?? 0 })}
          </button>
        </div>
      </div>
      {data && data.campaigns.length > 0 && (
        <ul className="mt-3 max-w-2xl divide-y divide-slate-100 rounded-lg border border-slate-200 text-sm">
          {data.campaigns.map((c) => (
            <li key={c.id} className="p-2">
              <p className="font-medium">{c.subject}</p>
              <p className="text-xs text-slate-500">
                {clock.when(c.sentAt, venueId)} · {t("mkt.sentTo", { n: c.recipients })}
                {c.sentBy && ` · ${t("mkt.sentBy", { name: c.sentBy })}`}
              </p>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
