import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { coachById } from "@/lib/coaching";
import { aheadFor } from "@/lib/house-rules";
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

/** Booking a one-to-one lesson with one of a venue's coaches. */
export default async function CoachPage({ params }: { params: Promise<{ id: string; coachId: string }> }) {
  const { id: rawId, coachId } = await params;
  const id = Number(rawId);
  const viewer = await pageViewer();
  if (!Number.isInteger(id) || !shows(await currentStorefront(), id) || !(await mayShowVenue(id, viewer)).show) notFound();
  const [venue, coach] = await Promise.all([getVenue(id), coachById(Number(coachId))]);
  if (!venue || !coach || !coach.active || coach.venueId !== id) notFound();
  const t = await serverT();
  const { step, zone } = await venueHours(id);
  const today = todayISO(zone);
  const ahead = await aheadFor(id, viewer.userId);
  return (
    <div className="mx-auto max-w-lg space-y-4">
      <Link href={`/venue/${id}`} className="text-sm font-medium text-teal-700 hover:underline">
        ← {venue.name}
      </Link>
      <div className="rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <h1 className="text-xl font-bold">🎓 {coach.name}</h1>
        <p className="mt-1 text-sm text-slate-600">
          {coach.sports.map((s) => sportLabel(t, s)).join(", ")} · {t("coach.rate", { amount: money(coach.rate) })}
        </p>
        {coach.bio && <p className="mt-2 whitespace-pre-line text-sm text-slate-700">{coach.bio}</p>}
        <CoachBooking
          venueId={id}
          coach={{ id: coach.id, name: coach.name, sports: coach.sports }}
          dates={Array.from({ length: ahead + 1 }, (_, i) => addDays(today, i))}
          step={step}
          payOnline={await takesPaymentOnline(id)}
        />
      </div>
    </div>
  );
}
