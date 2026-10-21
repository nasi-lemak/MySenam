import { notFound } from "next/navigation";
import { getVenue, listVenueClosures, readNear } from "@/lib/store";
import { distanceM } from "@/lib/geo";
import { todayISO, addDays, formatHour } from "@/lib/time";
import { MAX_ADVANCE_DAYS, MAX_HOURS_PER_BOOKING, Sport, SPORTS } from "@/lib/types";
import BookingBoard from "@/components/BookingBoard";
import LiveOccupancy from "@/components/LiveOccupancy";
import { serverT } from "@/lib/locale";
import { currentStorefront, shows } from "@/lib/storefront";
import { mayShowVenue, pageViewer } from "@/lib/listing";
import { accessSettings, eligible } from "@/lib/access";
import { hasRules, houseRules } from "@/lib/house-rules";
import Link from "next/link";
import { listOutages } from "@/lib/outages";
import PinMap from "@/components/PinMap";
import { VenueFacilities } from "@/components/VenueFacilities";
import { VenueGallery } from "@/components/VenueGallery";
import { NoticeBar } from "@/components/NoticeBar";
import { showingFor } from "@/lib/notices";
import { venuePhotos } from "@/lib/photos";
import { joinTerms, listPlans } from "@/lib/membership-plans";
import { renewalFor, renewsByItself, takesPaymentOnline } from "@/lib/payments";
import JoinMembership, { type JoinStanding } from "@/components/JoinMembership";
import type { Metadata } from "next";
import { siteOrigin, sportsLine, venueIsListed, venueJsonLd } from "@/lib/seo";
import { photoAt } from "@/lib/photos-shared";
import { siteName } from "@/lib/site";

export const dynamic = "force-dynamic";

/**
 * What a search result and a shared link show: the venue, its sports and
 * where it is. A venue a visitor could not find from the home page (private,
 * a members-only one kept out of search, a draft) is not to be indexed.
 */
export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const venueId = Number((await params).id);
  const venue = Number.isInteger(venueId) ? await getVenue(venueId) : null;
  if (!venue || !(await venueIsListed(venue.id)) || !shows(await currentStorefront(), venue.id))
    return { robots: { index: false, follow: false } };
  const sports = sportsLine([...new Set(venue.courts.map((c) => c.sport))] as Sport[]);
  const origin = await siteOrigin();
  const url = `${origin}/venue/${venue.id}`;
  const cover = (await venuePhotos(venue.id))[0];
  const image = cover ? new URL(photoAt(cover, 1200), origin).toString() : null;
  const title = `${venue.name} — ${sports} in ${venue.area}`;
  const description = `Book ${sports.toLowerCase()} at ${venue.name}, ${venue.address}. Open ${formatHour(venue.openHour)} to ${formatHour(venue.closeHour)}; see what is free and book online.`;
  return {
    title: `${title} | ${siteName()}`,
    description,
    alternates: { canonical: url },
    openGraph: { title, description, url, type: "website", ...(image ? { images: [{ url: image }] } : {}) },
  };
}

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
  // A private venue: only its staff and the people on its list. Somebody not
  // signed in is asked to, without being told whose venue it is.
  const viewer = await pageViewer();
  const { show, preview, signIn } = await mayShowVenue(venue.id, viewer);
  if (signIn)
    return (
      <div className="mx-auto max-w-md space-y-3 rounded-xl border border-slate-200 bg-white p-6 text-center shadow-sm">
        <div className="text-4xl">🔒</div>
        <h1 className="text-xl font-bold">{t("access.privateTitle")}</h1>
        <p className="text-sm text-slate-600">{t("access.privateBody")}</p>
        <Link
          href={`/login?next=${encodeURIComponent(`/venue/${venue.id}`)}`}
          className="inline-block rounded-lg bg-teal-600 px-5 py-2.5 font-semibold text-white hover:bg-teal-700"
        >
          {t("access.signIn")}
        </Link>
      </div>
    );
  if (!show) notFound();
  const access = await accessSettings(venue.id);
  const member =
    access.access === "members" && viewer.userId !== null ? await eligible(venue.id, viewer.userId, "members") : false;

  // Membership plans sold online, and where this visitor stands with them.
  const plans = (await takesPaymentOnline(venue.id)) ? await listPlans(venue.id) : [];
  let standing: JoinStanding = { kind: "signIn" };
  if (plans.length > 0 && viewer.userId !== null) {
    const terms = await joinTerms(viewer.userId, plans[0].id);
    standing = terms.ok
      ? terms.terms.renewing
        ? { kind: "renew", until: addDays(terms.terms.startsOn, -1) }
        : { kind: "join" }
      : terms.code === "JOIN_TOO_EARLY"
        ? { kind: "early", until: String(terms.vars?.until), from: String(terms.vars?.from) }
        : { kind: "noPhone" };
  }
  const canAutoRenew = plans.length > 0 && (await renewsByItself(venue.id));
  const renewal = plans.length > 0 && viewer.userId !== null ? await renewalFor(viewer.userId, venue.id) : null;

  const sports = [...new Set(venue.courts.map((c) => c.sport))] as Sport[];
  const today = todayISO();
  // As far ahead as this venue takes bookings, within the site's window.
  const rules = await houseRules(venue.id);
  const ahead = Math.min(rules.aheadDays ?? MAX_ADVANCE_DAYS, MAX_ADVANCE_DAYS);
  const dates = Array.from({ length: ahead + 1 }, (_, i) => addDays(today, i));

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

  // What the venue is, for search engines, where it is listed at all.
  const jsonLd = (await venueIsListed(venue.id))
    ? venueJsonLd({
        ...venue,
        url: `${await siteOrigin()}/venue/${venue.id}`,
        image: photos[0] ? new URL(photoAt(photos[0], 1200), await siteOrigin()).toString() : null,
        sports,
      })
    : null;

  return (
    <div className="space-y-6">
      {jsonLd && (
        // Escaped so nothing in a venue's name can close the script.
        <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd).replace(/</g, "\\u003c") }} />
      )}
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
      {access.access === "members" &&
        (member ? (
          <div className="rounded-xl border border-teal-200 bg-teal-50 px-4 py-3 text-sm text-teal-900">
            🎟️ {t("access.youAreMember")}
          </div>
        ) : (
          <div className="rounded-xl border border-violet-200 bg-violet-50 px-4 py-3 text-sm text-violet-900">
            <p className="font-semibold">🎟️ {t("access.membersBadge")}</p>
            <p className="mt-0.5">{t("access.membersBody")}</p>
            {access.note && <p className="mt-1 whitespace-pre-line">{access.note}</p>}
            {viewer.userId === null && plans.length === 0 && (
              <Link
                href={`/login?next=${encodeURIComponent(`/venue/${venue.id}`)}`}
                className="mt-2 inline-block font-semibold text-violet-800 underline"
              >
                {t("access.signIn")}
              </Link>
            )}
          </div>
        ))}
      {plans.length > 0 && access.access !== "private" && (
        <JoinMembership venueId={venue.id} plans={plans} standing={standing} canAutoRenew={canAutoRenew} renewal={renewal} />
      )}
      {access.access === "private" && (
        <div className="rounded-xl border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
          🔒 {t("access.privateBadge")}
          {access.note && <p className="mt-1 whitespace-pre-line">{access.note}</p>}
        </div>
      )}
      {hasRules(rules) && (
        <p className="rounded-xl border border-slate-200 bg-white px-4 py-2.5 text-sm text-slate-700">
          <span className="font-semibold">📋 {t("rules.title")}:</span>{" "}
          {[
            rules.upcoming !== null && t("rules.upcoming", { n: rules.upcoming }),
            rules.perWeek !== null && t("rules.week", { n: rules.perWeek }),
            rules.perDay !== null && t("rules.day", { n: rules.perDay }),
          ]
            .filter(Boolean)
            .join(", ")}
          {(rules.upcoming !== null || rules.perWeek !== null || rules.perDay !== null) && ` ${t("rules.who")}`}
          {rules.aheadDays !== null &&
            `${rules.upcoming !== null || rules.perWeek !== null || rules.perDay !== null ? "; " : ""}${
              rules.aheadDays === 0 ? t("rules.today") : t("rules.ahead", { n: rules.aheadDays })
            }`}
          .
        </p>
      )}
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
