import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { aheadFor } from "@/lib/house-rules";
import { coachChoice, lessonRates, lessonSports } from "@/lib/lesson-coaches";
import { mayShowVenue, pageViewer } from "@/lib/listing";
import { serverT } from "@/lib/locale";
import { takesPaymentOnline } from "@/lib/payments";
import { money } from "@/lib/region";
import { getVenue, venueHours } from "@/lib/store";
import { currentStorefront, shows } from "@/lib/storefront";
import { addDays, todayISO } from "@/lib/time";
import { sportLabel } from "@/lib/i18n";
import CoachBooking from "@/components/CoachBooking";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Book a lesson", robots: { index: false } };

/**
 * Booking a one-to-one lesson at a venue that assigns the coach
 * (lib/lesson-coaches.ts): a sport, a day and a time any of its coaches of
 * the sport is free; the coach given is shown once it is booked.
 */
export default async function LessonPage({ params, searchParams }: { params: Promise<{ id: string }>; searchParams: Promise<{ sport?: string }> }) {
  const { id: rawId } = await params;
  const { sport: asked } = await searchParams;
  const id = Number(rawId);
  const viewer = await pageViewer();
  if (!Number.isInteger(id) || !shows(await currentStorefront(), id) || !(await mayShowVenue(id, viewer)).show) notFound();
  const venue = await getVenue(id);
  if (!venue || (await coachChoice(id)) !== "venue") notFound();
  const offered = await lessonSports(id);
  if (offered.length === 0) notFound();
  // The sport asked for first, the form following whichever is picked.
  const sports = [...offered.filter((s) => s === asked), ...offered.filter((s) => s !== asked)];
  const rates = await lessonRates(id, sports[0]);
  const t = await serverT();
  const { zone } = await venueHours(id);
  const today = todayISO(zone);
  const ahead = await aheadFor(id, viewer.userId);
  return (
    <div className="mx-auto max-w-lg space-y-4">
      <Link href={`/venue/${id}`} className="text-sm font-medium text-teal-700 hover:underline">
        ← {venue.name}
      </Link>
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-xl font-bold">🎓 {t("co6.bookSport", { sport: sportLabel(t, sports[0]) })}</h1>
        <p className="mt-1 text-sm text-slate-600">{t("co6.assigns")}</p>
        {rates && (
          <p className="mt-1 text-sm text-slate-600">
            {rates.min === rates.max ? t("co6.rate", { amount: money(rates.min) }) : t("co6.rates", { min: money(rates.min), max: money(rates.max) })}
          </p>
        )}
        <CoachBooking
          venueId={id}
          coach={{ id: null, name: "", sports }}
          dates={Array.from({ length: ahead + 1 }, (_, i) => addDays(today, i))}
          payOnline={await takesPaymentOnline(id)}
          timeZone={zone}
        />
      </div>
    </div>
  );
}
