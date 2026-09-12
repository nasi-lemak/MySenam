import { notFound } from "next/navigation";
import { getVenue } from "@/lib/store";
import { todayISO, addDays } from "@/lib/time";
import { MAX_ADVANCE_DAYS, Sport } from "@/lib/types";
import BookingBoard from "@/components/BookingBoard";

export const dynamic = "force-dynamic";

export default async function VenuePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const venueId = Number(id);
  const venue = Number.isInteger(venueId) ? getVenue(venueId) : null;
  if (!venue) notFound();

  const sports = [...new Set(venue.courts.map((c) => c.sport))] as Sport[];
  const today = todayISO();
  const dates = Array.from({ length: MAX_ADVANCE_DAYS + 1 }, (_, i) => addDays(today, i));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{venue.name}</h1>
        <p className="mt-1 text-sm text-slate-600">
          📍 {venue.address} · ☎ {venue.phone}
        </p>
        <p className="mt-1 text-sm text-slate-500">Open daily 8:00 AM – 11:00 PM</p>
      </div>
      <BookingBoard venueId={venue.id} sports={sports} dates={dates} />
    </div>
  );
}
