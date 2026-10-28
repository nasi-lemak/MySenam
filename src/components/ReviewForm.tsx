"use client";

import { readJson } from "@/lib/read-response";
import { useState } from "react";
import { useT } from "@/components/Language";
import { translateError } from "@/lib/i18n";
import { MAX_REVIEW_BODY } from "@/lib/types";

/** Stars and a few words, with what will be shown and the rules said before posting. */
export function ReviewForm({
  code,
  token,
  venueId,
  initial,
}: {
  code: string;
  token: string;
  venueId: number;
  initial: { rating: number; body: string } | null;
}) {
  const t = useT();
  const [rating, setRating] = useState(initial?.rating ?? 0);
  const [body, setBody] = useState(initial?.body ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/reviews", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, t: token, rating, body }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(translateError(t, data));
      setDone(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (done)
    return (
      <p className="rounded-md bg-emerald-50 p-3 text-emerald-800">
        {t("review.thanks")}{" "}
        <a href={`/venue/${venueId}#reviews`} className="font-semibold underline">
          {t("review.see")}
        </a>
      </p>
    );

  return (
    <form onSubmit={send} className="space-y-3">
      <fieldset>
        <legend className="font-medium text-slate-700">{t("review.stars")}</legend>
        <div className="mt-1 flex gap-1" role="radiogroup" aria-label={t("review.stars")}>
          {[1, 2, 3, 4, 5].map((n) => (
            <button
              key={n}
              type="button"
              role="radio"
              aria-checked={rating === n}
              aria-label={t("review.starN", { n })}
              onClick={() => setRating(n)}
              className={`text-3xl leading-none ${n <= rating ? "text-amber-500" : "text-slate-300"}`}
            >
              ★
            </button>
          ))}
        </div>
      </fieldset>
      <label className="block">
        <span className="font-medium text-slate-700">{t("review.body")}</span>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          maxLength={MAX_REVIEW_BODY}
          rows={4}
          placeholder={t("review.placeholder")}
          className="mt-1 w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-teal-500 focus:outline-none"
        />
      </label>
      <p role="note" className="rounded-md border border-amber-300 bg-amber-50 p-2 text-amber-900">
        {t("review.rules")}
      </p>
      {error && <p className="text-rose-700">{error}</p>}
      <button type="submit" disabled={busy || rating === 0} className="rounded-md bg-teal-600 px-4 py-2 font-semibold text-white disabled:opacity-50">
        {initial ? t("review.update") : t("review.send")}
      </button>
    </form>
  );
}
