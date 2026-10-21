import Link from "next/link";
import { notFound } from "next/navigation";
import { serverT } from "@/lib/locale";
import { errorText } from "@/lib/i18n";
import { reviewable, reviewToken } from "@/lib/reviews";
import { ReviewForm } from "@/components/ReviewForm";

export const dynamic = "force-dynamic";

/** Rating a visit, through the signed link a booking was given (lib/reviews.ts). */
export default async function ReviewPage({
  params,
  searchParams,
}: {
  params: Promise<{ code: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const t = await serverT();
  const code = decodeURIComponent((await params).code);
  const token = (await searchParams).t;
  if (typeof token !== "string" || token !== reviewToken(code)) notFound();
  const can = await reviewable(code);
  if (!can.ok) {
    return (
      <div className="mx-auto max-w-lg rounded-2xl border border-slate-200 bg-white p-6 text-sm shadow-sm">
        <p>{can.code ? errorText(t, can.code, can.vars) : can.error}</p>
      </div>
    );
  }
  const { venueId, venueName, courtName, booking, existing } = can.value;
  return (
    <div className="mx-auto max-w-lg space-y-4 rounded-2xl border border-slate-200 bg-white p-6 text-sm shadow-sm">
      <div>
        <h1 className="text-xl font-bold">{t("review.title", { venue: venueName })}</h1>
        <p className="mt-1 text-slate-600">{t("review.what", { court: courtName, date: booking.date })}</p>
      </div>
      {existing && <p className="rounded-md bg-slate-50 p-2 text-slate-700">{t("review.yours", { venue: venueName, n: existing.rating })}</p>}
      <ReviewForm code={code} token={token} venueId={venueId} initial={existing ? { rating: existing.rating, body: existing.body ?? "" } : null} />
      <Link href={`/venue/${venueId}`} className="inline-block font-medium text-teal-700 underline">
        {t("review.see")}
      </Link>
    </div>
  );
}
