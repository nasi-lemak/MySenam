import { notFound } from "next/navigation";
import { getVenue, listVenueClosures } from "@/lib/store";
import { todayISO, addDays, formatHour } from "@/lib/time";
import { MAX_ADVANCE_DAYS, MAX_HOURS_PER_BOOKING, Sport, SPORTS } from "@/lib/types";
import BookingBoard from "@/components/BookingBoard";
import LiveOccupancy from "@/components/LiveOccupancy";
import { serverT } from "@/lib/locale";

export const dynamic = "force-dynamic";

export default async function VenuePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const t = await serverT();
  const { id } = await params;
  const query = await searchParams;
  const venueId = Number(id);
  const venue = Number.isInteger(venueId) ? getVenue(venueId) : null;
  if (!venue) notFound();

  const sports = [...new Set(venue.courts.map((c) => c.sport))] as Sport[];
  const today = todayISO();
  const dates = Array.from({ length: MAX_ADVANCE_DAYS + 1 }, (_, i) => addDays(today, i));

  const initial = parseInitialSelection(query, sports, dates);
  // Only closures inside the booking window are worth warning about.
  const closures = listVenueClosures(venue.id, today).filter((c) => dates.includes(c.date));

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold">{venue.name}</h1>
        <p className="mt-1 text-sm text-slate-600">
          📍 {venue.address} · ☎ {venue.phone}
        </p>
        <p className="mt-1 text-sm text-slate-500">
          {t("venue.openDaily", {
            from: formatHour(venue.openHour),
            to: formatHour(venue.closeHour),
          })}{" "}
          ·{" "}
          {venue.cancelCutoffHours > 0
            ? t.plural("venue.freeCancel", venue.cancelCutoffHours)
            : t("venue.cancelAnyTime")}
        </p>
      </div>
      {closures.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <span className="font-semibold">{t("venue.closures")}</span>{" "}
          {closures
            .map((c) => (c.reason ? `${c.date} (${c.reason})` : c.date))
            .join(" · ")}
        </div>
      )}
      <LiveOccupancy venueId={venue.id} />
      <BookingBoard venueId={venue.id} sports={sports} dates={dates} initial={initial} />
    </div>
  );
}

/** Turn ?date=&sport=&court=&hour=&duration= from a search result into a selection. */
function parseInitialSelection(
  query: Record<string, string | string[] | undefined>,
  sports: Sport[],
  dates: string[]
) {
  const one = (key: string) => {
    const value = query[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const sport = one("sport");
  const date = one("date");
  const courtId = Number(one("court"));
  const hour = Number(one("hour"));
  const duration = Number(one("duration") ?? 1);

  const validDuration =
    Number.isInteger(duration) && duration >= 1 && duration <= MAX_HOURS_PER_BOOKING;

  return {
    sport: sport && SPORTS.includes(sport as Sport) && sports.includes(sport as Sport)
      ? (sport as Sport)
      : undefined,
    date: date && dates.includes(date) ? date : undefined,
    courtId: Number.isInteger(courtId) && courtId > 0 ? courtId : undefined,
    hours:
      Number.isInteger(hour) && validDuration
        ? Array.from({ length: duration }, (_, i) => hour + i)
        : undefined,
  };
}
