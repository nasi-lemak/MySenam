import { notFound } from "next/navigation";
import { getVenue, listVenueClosures, readNear } from "@/lib/store";
import { distanceM } from "@/lib/geo";
import { todayISO, addDays, formatHour } from "@/lib/time";
import { MAX_ADVANCE_DAYS, MAX_HOURS_PER_BOOKING, Sport, SPORTS } from "@/lib/types";
import BookingBoard from "@/components/BookingBoard";
import LiveOccupancy from "@/components/LiveOccupancy";
import { serverT } from "@/lib/locale";
import { currentStorefront, shows } from "@/lib/storefront";
import { mayShowVenue, pageAdmin } from "@/lib/listing";
import { listOutages } from "@/lib/outages";
import PinMap from "@/components/PinMap";
import { VenueFacilities } from "@/components/VenueFacilities";
import { VenueGallery } from "@/components/VenueGallery";
import { NoticeBar } from "@/components/NoticeBar";
import { showingFor } from "@/lib/notices";
import { venuePhotos } from "@/lib/photos";

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
  const venue = Number.isInteger(venueId) ? await getVenue(venueId) : null;
  // On a storefront, a venue it does not show is not there.
  if (!venue || !shows(await currentStorefront(), venue.id)) notFound();
  // A draft, or a venue taken off for an unpaid invoice, is there only for
  // its own staff, as a preview.
  const { show, preview } = await mayShowVenue(venue.id, await pageAdmin());
  if (!show) notFound();

  const sports = [...new Set(venue.courts.map((c) => c.sport))] as Sport[];
  const today = todayISO();
  const dates = Array.from({ length: MAX_ADVANCE_DAYS + 1 }, (_, i) => addDays(today, i));

  const initial = parseInitialSelection(query, sports, dates);
  // Only closures inside the booking window are worth warning about.
  const closures = (await listVenueClosures(venue.id, today)).filter((c) => dates.includes(c.date));
  // Courts out for a stretch that touches the booking window.
  const outages = (await listOutages([venue.id])).filter((o) => o.startsOn <= dates[dates.length - 1]);
  const photos = await venuePhotos(venue.id);
  const [notice] = await showingFor([venue.id]);
  // Arrived from a search near somewhere: how far this is from there, as the crow flies.
  const one = (key: string) => (Array.isArray(query[key]) ? query[key][0] : query[key]);
  const near = readNear(one("near"));
  const nearWhere = one("where")?.slice(0, 80) || null;
  const awayKm =
    near && venue.lat !== null && venue.lng !== null
      ? Math.round(distanceM(near, { lat: venue.lat, lng: venue.lng }) / 100) / 10
      : null;

  return (
    <div className="space-y-6">
      {preview && (
        <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          <span className="font-semibold">Preview.</span>{" "}
          {venue.publishedAt === null
            ? "Only your staff can see this page until your venue goes live. Bookings you make here are test bookings."
            : "Customers cannot see this page while your venue is off the marketplace for an unpaid invoice."}
        </div>
      )}
      <div>
        <h1 className="text-2xl font-bold">{venue.name}</h1>
        <p className="mt-1 text-sm text-slate-600">
          📍 {venue.address} · ☎ {venue.phone}
          {awayKm !== null && (
            <>
              {" · "}
              <span className="font-medium text-slate-700">
                {nearWhere ? t("venue.distanceFrom", { km: awayKm, where: nearWhere }) : t("venue.distanceFromYou", { km: awayKm })}
              </span>
            </>
          )}
          {venue.lat !== null && venue.lng !== null && (
            <>
              {" · "}
              <a
                href={`https://www.google.com/maps/dir/?api=1&destination=${venue.lat},${venue.lng}`}
                target="_blank"
                rel="noopener"
                className="font-medium text-teal-700 underline"
              >
                {t("venue.directions")}
              </a>
            </>
          )}
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
      {notice && <NoticeBar notice={notice} more={t("notice.more")} />}
      <VenueGallery
        photos={photos}
        venueName={venue.name}
        labels={{ close: t("photos.close"), prev: t("photos.prev"), next: t("photos.next") }}
      />
      {closures.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <span className="font-semibold">{t("venue.closures")}</span>{" "}
          {closures
            .map((c) => (c.reason ? `${c.date} (${c.reason})` : c.date))
            .join(" · ")}
        </div>
      )}
      {outages.length > 0 && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <span className="font-semibold">{t("venue.outages")}</span>{" "}
          {outages
            .map(
              (o) =>
                `${o.courtName}, ` +
                (o.endsOn === null
                  ? `${o.startsOn > today ? `${t("venue.fromDate", { date: o.startsOn })} ` : ""}${t("venue.untilFurtherNotice")}`
                  : o.startsOn === o.endsOn
                    ? o.startsOn
                    : `${o.startsOn > today ? o.startsOn : today} – ${o.endsOn}`) +
                (o.reason ? ` (${o.reason})` : "")
            )
            .join(" · ")}
        </div>
      )}
      {/* Booking first: it is what nearly everybody came for. */}
      <BookingBoard venueId={venue.id} sports={sports} dates={dates} initial={initial} />
      <LiveOccupancy venueId={venue.id} />
      {/* What it has, and where it is, side by side on a wide screen. */}
      <div className="grid gap-4 md:grid-cols-2">
        <VenueFacilities t={t} venue={venue} />
        {venue.lat !== null && venue.lng !== null && <PinMap pin={{ lat: venue.lat, lng: venue.lng }} height={180} />}
      </div>
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
