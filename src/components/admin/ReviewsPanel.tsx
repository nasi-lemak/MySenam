"use client";

import { useCallback, useEffect, useState } from "react";
import type { StaffReview } from "@/lib/reviews";
import type { ManagedVenue } from "./shared";

/**
 * What customers said about the venue (lib/reviews.ts): answer each one
 * publicly, or ask the platform to look at one that breaks the rules. Only
 * the platform's owners hide a review; they see what venues have reported.
 */

const stars = (n: number) => "★".repeat(n) + "☆".repeat(5 - n);

export function ReviewsPanel({ venues, isOwner }: { venues: ManagedVenue[]; isOwner: boolean }) {
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
    if (!res.ok) return setError(data.error ?? "Could not load reviews");
    setReviews(data.reviews);
    setRequests(data.requests);
    setReported(data.reported);
  }, [venueId]);

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
    if (!res.ok) setError(data.error ?? "Request failed");
    await load();
    return res.ok;
  }

  const row = (r: StaffReview, venueName?: string) => (
    <li key={r.id} className={`p-3 ${r.hiddenAt ? "bg-slate-50 text-slate-400" : ""}`}>
      <p>
        <span className="text-amber-500">{stars(r.rating)}</span> <span className="font-medium">{r.author}</span>{" "}
        <span className="text-slate-500">
          · played {r.playedIn}
          {r.bookingCode && ` · ${r.bookingCode}`}
          {venueName && ` · ${venueName}`}
        </span>
      </p>
      {r.body && <p className="mt-1 whitespace-pre-line">{r.body}</p>}
      {r.hiddenAt && <p className="mt-1 text-rose-700">Hidden by the platform: {r.hiddenReason}</p>}
      {r.reportedAt && !r.hiddenAt && <p className="mt-1 text-amber-700">Reported to the platform: {r.reportReason}</p>}
      {!venueName && !r.hiddenAt && (
        <div className="mt-2 space-y-2">
          <textarea
            rows={2}
            maxLength={1000}
            value={drafts[r.id] ?? r.reply ?? ""}
            onChange={(e) => setDrafts({ ...drafts, [r.id]: e.target.value })}
            placeholder="Reply publicly (optional)"
            className="w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
          />
          <div className="flex flex-wrap gap-3 text-sm">
            <button
              type="button"
              className="font-medium text-teal-700 hover:underline"
              onClick={() => void act({ action: "reply", id: r.id, text: drafts[r.id] ?? r.reply ?? "" })}
            >
              {r.reply ? "Update reply" : "Post reply"}
            </button>
            {!r.reportedAt && (
              <button
                type="button"
                className="font-medium text-rose-700 hover:underline"
                onClick={() => {
                  const reason = window.prompt(
                    "Which rule does it break? (abuse, personal details, links or adverts, not about a visit). The platform decides; it stays up until then. A review is not removed for being negative."
                  );
                  if (reason) void act({ action: "report", id: r.id, reason });
                }}
              >
                Report to the platform
              </button>
            )}
          </div>
        </div>
      )}
      {isOwner && (
        <div className="mt-2 text-sm">
          {r.hiddenAt ? (
            <button type="button" className="font-medium text-teal-700 hover:underline" onClick={() => void act({ action: "show", id: r.id }, r.venueId)}>
              Show again
            </button>
          ) : (
            <button
              type="button"
              className="font-medium text-rose-700 hover:underline"
              onClick={() => {
                const reason = window.prompt("Why is it being hidden? The venue is told.");
                if (reason) void act({ action: "hide", id: r.id, reason }, r.venueId);
              }}
            >
              Hide (platform)
            </button>
          )}
        </div>
      )}
    </li>
  );

  return (
    <section>
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-lg font-bold">Reviews</h2>
        {venues.length > 1 && (
          <select
            value={venueId}
            onChange={(e) => setVenueId(Number(e.target.value))}
            aria-label="Venue"
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
        Only customers whose booking went ahead can review, once per phone number. The average shows on your page from
        three reviews. Replies are public. Negative reviews are not removed for being negative: report one only if it
        breaks the rules.
      </p>
      <label className="mt-2 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={requests} onChange={(e) => void act({ action: "requests", on: e.target.checked })} />
        Email customers once, after their first visit, asking how it was
      </label>
      {error && <p className="mt-2 text-sm text-rose-700">{error}</p>}
      {isOwner && reported && reported.length > 0 && (
        <div className="mt-3">
          <h3 className="font-semibold text-amber-800">Reported by venues, to decide</h3>
          <ul className="mt-1 divide-y divide-slate-100 rounded-lg border border-amber-300 text-sm">{reported.map((r) => row(r, r.venueName))}</ul>
        </div>
      )}
      {reviews.length === 0 ? (
        <p className="mt-3 text-sm text-slate-500">No reviews yet.</p>
      ) : (
        <ul className="mt-3 divide-y divide-slate-100 rounded-lg border border-slate-200 text-sm">{reviews.map((r) => row(r))}</ul>
      )}
    </section>
  );
}
