import type { T } from "@/lib/i18n";
import { intlTag } from "@/lib/region";
import type { Rating, Review } from "@/lib/reviews";

const stars = (n: number) => "★".repeat(n) + "☆".repeat(5 - n);

/** What players said, newest first, with the venue's answers (lib/reviews.ts). Nothing until somebody has. */
export function VenueReviews({
  t,
  locale,
  venueName,
  rating,
  reviews,
}: {
  t: T;
  locale: string;
  venueName: string;
  rating: Rating | null;
  reviews: Review[];
}) {
  if (reviews.length === 0) return null;
  const month = (ym: string) =>
    new Date(`${ym}-15T00:00:00Z`).toLocaleDateString(intlTag(locale), { month: "long", year: "numeric", timeZone: "UTC" });
  return (
    <section id="reviews" className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold">{t("review.heading")}</h2>
        <p className="text-sm text-slate-600">
          {rating ? (
            <>
              <span className="text-amber-500" aria-hidden>
                ★
              </span>{" "}
              {t("review.summary", { avg: rating.average.toFixed(1), count: rating.count })}
            </>
          ) : (
            t("review.few")
          )}
        </p>
      </div>
      <ul className="mt-3 space-y-4 text-sm">
        {reviews.map((r) => (
          <li key={r.id}>
            <p>
              <span className="text-amber-500" aria-label={t("review.starN", { n: r.rating })}>
                {stars(r.rating)}
              </span>{" "}
              <span className="font-medium">{r.author}</span>{" "}
              <span className="text-slate-500">· {t("review.played", { month: month(r.playedIn) })}</span>
            </p>
            {r.body && <p className="mt-1 whitespace-pre-line text-slate-700">{r.body}</p>}
            {r.reply && (
              <div className="mt-2 border-l-2 border-teal-200 pl-3 text-slate-600">
                <p className="text-xs font-semibold text-teal-800">{t("review.reply", { venue: venueName })}</p>
                <p className="whitespace-pre-line">{r.reply}</p>
              </div>
            )}
          </li>
        ))}
      </ul>
      <p className="mt-3 text-xs text-slate-500">{t("review.verified")}</p>
    </section>
  );
}
