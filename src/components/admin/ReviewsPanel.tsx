"use client";

import { useCallback, useEffect, useState } from "react";
import type { StaffReview } from "@/lib/reviews";
import type { ManagedVenue } from "./shared";
import { useStaffT } from "./StaffLanguage";

/**
 * What customers said about the venue (lib/reviews.ts): answer each one
 * publicly, or ask the platform to look at one that breaks the rules. Only
 * the platform's owners hide a review; they see what venues have reported.
 */

const stars = (n: number) => "★".repeat(n) + "☆".repeat(5 - n);

export function ReviewsPanel({ venues, isOwner }: { venues: ManagedVenue[]; isOwner: boolean }) {
  const t = useStaffT();
  const [venueId, setVenueId] = useState(venues[0]?.id ?? 0);
  const [reviews, setReviews] = useState<StaffReview[]>([]);
  const [requests, setRequests] = useState(true);
  const [reported, setReported] = useState<(StaffReview & { venueName: string })[] | null>(null);
  const [drafts, setDrafts] = useState<Record<number, string>>({});
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!venueId) return;
    const res = await fetch(`/api/admin/reviews?venueId=${venueId}`, { cache: "no-store" });
    const data = await res.json();
    if (!res.ok) return setError(t.err(data, t("rev.loadFailed")));
    setReviews(data.reviews);
    setRequests(data.requests);
    setReported(data.reported);
  }, [venueId, t]);

  useEffect(() => {
    load();
  }, [load]);

  async function act(body: Record<string, unknown>, forVenue = venueId) {
    setError(null);
    const res = await fetch("/api/admin/reviews", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ venueId: forVenue, ...body }),
    });
    const data = await res.json();
    if (!res.ok) setError(t.err(data, t("rev.failed")));
    await load();
    return res.ok;
  }

  const row = (r: StaffReview, venueName?: string) => (
    <li key={r.id} className={`p-3 ${r.hiddenAt ? "bg-slate-50 text-slate-400" : ""}`}>
      <p>
        <span className="text-amber-500">{stars(r.rating)}</span> <span className="font-medium">{r.author}</span>{" "}
        <span className="text-slate-500">
          · {t("rev.played", { when: r.playedIn })}
          {r.bookingCode && ` · ${r.bookingCode}`}
          {venueName && ` · ${venueName}`}
        </span>
      </p>
      {r.body && <p className="mt-1 whitespace-pre-line">{r.body}</p>}
      {r.hiddenAt && <p className="mt-1 text-rose-700">{t("rev.hidden", { reason: r.hiddenReason ?? "" })}</p>}
      {r.reportedAt && !r.hiddenAt && <p className="mt-1 text-amber-700">{t("rev.reported", { reason: r.reportReason ?? "" })}</p>}
      {!venueName && !r.hiddenAt && (
        <div className="mt-2 space-y-2">
          <textarea
            rows={2}
            maxLength={1000}
            value={drafts[r.id] ?? r.reply ?? ""}
            onChange={(e) => setDrafts({ ...drafts, [r.id]: e.target.value })}
            placeholder={t("rev.replyPh")}
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
          />
          <div className="flex flex-wrap gap-3 text-sm">
            <button
              type="button"
              className="font-medium text-teal-700 hover:underline"
              onClick={() => void act({ action: "reply", id: r.id, text: drafts[r.id] ?? r.reply ?? "" })}
            >
              {r.reply ? t("rev.update") : t("rev.post")}
            </button>
            {!r.reportedAt && (
              <button
                type="button"
                className="font-medium text-rose-700 hover:underline"
                onClick={() => {
                  const reason = window.prompt(t("rev.reportPrompt"));
                  if (reason) void act({ action: "report", id: r.id, reason });
                }}
              >
                {t("rev.report")}
              </button>
            )}
          </div>
        </div>
      )}
      {isOwner && (
        <div className="mt-2 text-sm">
          {r.hiddenAt ? (
            <button type="button" className="font-medium text-teal-700 hover:underline" onClick={() => void act({ action: "show", id: r.id }, r.venueId)}>
              {t("rev.showAgain")}
            </button>
          ) : (
            <button
              type="button"
              className="font-medium text-rose-700 hover:underline"
              onClick={() => {
                const reason = window.prompt(t("rev.hidePrompt"));
                if (reason) void act({ action: "hide", id: r.id, reason }, r.venueId);
              }}
            >
              {t("rev.hide")}
            </button>
          )}
        </div>
      )}
    </li>
  );

  return (
    <section>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-bold">{t("rev.title")}</h2>
        {venues.length > 1 && (
          <select
            value={venueId}
            onChange={(e) => setVenueId(Number(e.target.value))}
            aria-label={t("c.venue")}
            className="rounded-md border border-slate-300 px-2 py-1 text-sm focus:border-teal-500 focus:outline-none"
          >
            {venues.map((v) => (
              <option key={v.id} value={v.id}>
                {v.name}
              </option>
            ))}
          </select>
        )}
      </div>
      <p className="mt-1 text-sm text-slate-500">
        {t("rev.intro")}
      </p>
      <label className="mt-2 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={requests} onChange={(e) => void act({ action: "requests", on: e.target.checked })} />
        {t("rev.requests")}
      </label>
      {error && <p className="mt-2 text-sm text-rose-700">{error}</p>}
      {isOwner && reported && reported.length > 0 && (
        <div className="mt-3">
          <h3 className="font-semibold text-amber-800">{t("rev.reportedTitle")}</h3>
          <ul className="mt-1 divide-y divide-slate-100 rounded-lg border border-amber-300 text-sm">{reported.map((r) => row(r, r.venueName))}</ul>
        </div>
      )}
      {reviews.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">{t("rev.none")}</p>
      ) : (
        <ul className="mt-3 divide-y divide-slate-100 rounded-lg border border-slate-200 text-sm">{reviews.map((r) => row(r))}</ul>
      )}
    </section>
  );
}
