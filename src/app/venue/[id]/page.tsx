import { sportsOf } from "@/lib/court-activities";
import { isKnownActivity } from "@/lib/activity-registry";
import { notFound } from "next/navigation";
import { loyaltyEvery } from "@/lib/loyalty";
import { sportRules } from "@/lib/sport-rules";
import { variesByDay, weekLines } from "@/lib/week-hours";
import { activeMembership, getVenue, listMembershipsFor, listVenueClosures, readNear } from "@/lib/store";
import { formatMinute, isMinute, parseClock } from "@/lib/interval";
import { distanceM } from "@/lib/geo";
import { todayISO, addDays } from "@/lib/time";
import { Sport } from "@/lib/types";
import BookingBoard from "@/components/BookingBoard";
import LiveOccupancy from "@/components/LiveOccupancy";
import { serverT } from "@/lib/locale";
import { currentStorefront, shows } from "@/lib/storefront";
import { mayShowVenue, pageViewer } from "@/lib/listing";
import { accountPhone, accessSettings, eligible } from "@/lib/access";
import { aheadFor, hasRules, houseRules, memberAhead } from "@/lib/house-rules";
import Link from "next/link";
import { listOutages } from "@/lib/outages";
import PinMap from "@/components/PinMap";
import { VenueFacilities } from "@/components/VenueFacilities";
import { VenueGallery } from "@/components/VenueGallery";
import { NoticeBar } from "@/components/NoticeBar";
import { showingFor } from "@/lib/notices";
import { venuePhotos } from "@/lib/photos";
import { joinTerms, listPlans, planById } from "@/lib/membership-plans";
import { coverStanding } from "@/lib/membership-purchases";
import { guardianshipsOf } from "@/lib/participants";
import { onlineTopUpsAllowed, renewalsFor, renewsByItself, takesPaymentOnline } from "@/lib/payments";
import { listCoaches } from "@/lib/coaching";
import { coachChoice } from "@/lib/lesson-coaches";
import { sportLabel } from "@/lib/i18n";
import { intlTag, money, shortDate } from "@/lib/region";
import { venueContact } from "@/lib/venue-contact";
import { rankingsPublished } from "@/lib/ratings";
import JoinMembership, { type Dependant, type FamilyMembership, type JoinStanding } from "@/components/JoinMembership";
import BuyPass, { type PassStanding } from "@/components/BuyPass";
import { EntryPanel } from "@/components/EntryPanel";
import { publicEntries } from "@/lib/entries";
import { listOnlinePassProducts } from "@/lib/pass-products";
import { mayBuyAt } from "@/lib/pass-purchases";
import type { Metadata } from "next";
import { siteOrigin, sportsLine, venueIsListed, venueJsonLd } from "@/lib/seo";
import { photoAt } from "@/lib/photos-shared";
import { siteName } from "@/lib/site";
import { venueRating, venueReviews } from "@/lib/reviews";
import { VenueReviews } from "@/components/VenueReviews";
import HireEnquiry from "@/components/HireEnquiry";
import ApprovalOffers from "@/components/ApprovalOffers";
import { currentLocale } from "@/lib/locale";

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
  const sports = sportsLine(sportsOf(venue.courts));
  const origin = await siteOrigin();
  const url = `${origin}/venue/${venue.id}`;
  const cover = (await venuePhotos(venue.id))[0];
  const image = cover ? new URL(photoAt(cover, 1200), origin).toString() : null;
  const title = `${venue.name} — ${sports} in ${venue.area}`;
  const description = `Book ${sports.toLowerCase()} at ${venue.name}, ${venue.address}. Open ${formatMinute(venue.openMin)} to ${formatMinute(venue.closeMin)}; see what is free and book online.`;
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
  // Until when: a members' session after that needs it renewed first, however live it is today (lib/entitlements.ts).
  const memberPhone = member && viewer.userId !== null ? await accountPhone(viewer.userId) : null;
  const memberUntil = memberPhone ? ((await activeMembership(venue.id, memberPhone))?.expiresOn ?? null) : null;

  // Membership plans sold online, and where this visitor stands with them.
  const online = await takesPaymentOnline(venue.id);
  const plans = online ? await listPlans(venue.id) : [];
  const coaches = await listCoaches(venue.id, { activeOnly: true });
  // Who chooses the coach of a lesson here (lib/lesson-coaches.ts): the venue assigning, a lesson is booked by sport.
  const venueAssigns = coaches.length > 0 && (await coachChoice(venue.id)) === "venue";
  const lessonSports = [...new Set(coaches.flatMap((c) => c.sports))];
  // Gift vouchers sold online, where credit bought here stays here (lib/vouchers.ts).
  const gifts = online && onlineTopUpsAllowed() && access.access !== "private";
  // Rankings, once the venue's manager has published them and anything has been rated (lib/ratings.ts): a page of people who chose to be listed.
  const hasRankings = await rankingsPublished(venue.id);
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
  // Passes sold online (lib/pass-purchases.ts): a private venue's only to the people on its list.
  const passProducts =
    online && (viewer.userId === null ? access.access !== "private" : await mayBuyAt(venue.id, viewer.userId)) ? await listOnlinePassProducts(venue.id) : [];
  const passStanding: PassStanding = viewer.userId === null ? "signIn" : (await accountPhone(viewer.userId)) ? "ok" : "noPhone";
  const passPeople =
    viewer.userId !== null && passProducts.some((p) => p.scope === "participant")
      ? (await guardianshipsOf(viewer.userId)).map((g) => ({ id: g.participant.id, name: g.participant.displayName }))
      : [];
  const canAutoRenew = plans.length > 0 && (await renewsByItself(venue.id));
  const renewals = plans.length > 0 && viewer.userId !== null ? await renewalsFor(viewer.userId, venue.id) : [];
  // Whom this account may buy for (lib/membership-purchases.ts): the people it looks after now, and its family memberships here.
  const people: Dependant[] = [];
  const families: FamilyMembership[] = [];
  if (plans.some((p) => p.offeredFor !== "account") && viewer.userId !== null) {
    for (const g of await guardianshipsOf(viewer.userId)) people.push({ id: g.participant.id, name: g.participant.displayName });
    for (const m of await listMembershipsFor(viewer.userId)) {
      if (m.venueId !== venue.id || m.status !== "active" || m.expiresOn < todayISO() || m.holderParticipantId !== null || !m.tierId) continue;
      const plan = await planById(m.tierId, { retired: true });
      if (plan?.offeredFor === "family" && plan.familyLimit !== null)
        families.push({
          id: m.id,
          code: m.code,
          expiresOn: m.expiresOn,
          limit: plan.familyLimit,
          covers: m.covers ?? [],
          ...(await coverStanding(m.id).then((s) => (s ? { standing: { left: s.left, renews: s.renews, nextCovers: s.nextCovers } } : {}))),
        });
    }
  }

  const sports = sportsOf(venue.courts);
  const today = todayISO();
  // As far ahead as this venue takes bookings from this viewer: further for its members.
  const rules = await houseRules(venue.id);
  const ahead = await aheadFor(venue.id, viewer.userId);
  const dates = Array.from({ length: ahead + 1 }, (_, i) => addDays(today, i));

  const loyalty = await loyaltyEvery(venue.id);
  // Sports with their own cancellation cutoff here, said beside the venue's.
  const ownCutoffs = (await sportRules(venue.id)).filter(
    (r) => r.cutoffHours !== null && r.cutoffHours !== venue.cancelCutoffHours && sports.includes(r.sport)
  );
  // A weekday's short name in the reader's language: 0 is Sunday.
  const dayName = (day: number) =>
    new Date(Date.UTC(2026, 0, 4 + day)).toLocaleDateString(intlTag(t.locale), { weekday: "short", timeZone: "UTC" });
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

  const rating = await venueRating(venue.id);
  const reviews = await venueReviews(venue.id);

  // What the venue is, for search engines, where it is listed at all.
  const jsonLd = (await venueIsListed(venue.id))
    ? venueJsonLd({
        ...venue,
        url: `${await siteOrigin()}/venue/${venue.id}`,
        image: photos[0] ? new URL(photoAt(photos[0], 1200), await siteOrigin()).toString() : null,
        sports,
        rating,
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
        {rating && (
          <a href="#reviews" className="mt-1 inline-block text-sm text-slate-700 hover:underline">
            <span className="text-amber-500" aria-hidden>
              ★
            </span>{" "}
            {t("review.summary", { avg: rating.average.toFixed(1), count: rating.count })}
          </a>
        )}
        {variesByDay(venue.weekHours) && (
          <ul className="mt-1 text-sm text-slate-500">
            {weekLines(venue).map((l) => (
              <li key={l.from}>
                <span className="inline-block min-w-24 font-medium text-slate-600">
                  {dayName(l.from)}
                  {l.to !== l.from && `–${dayName(l.to)}`}
                </span>{" "}
                {l.hours === "closed" ? t("venue.closedDay") : `${formatMinute(l.hours.open, t.locale)} – ${formatMinute(l.hours.close, t.locale)}`}
              </li>
            ))}
          </ul>
        )}
        <p className={`mt-1 text-sm text-slate-500 ${variesByDay(venue.weekHours) ? "first-letter:uppercase" : ""}`}>
          {!variesByDay(venue.weekHours) && (
            <>
              {t("venue.openDaily", {
                from: formatMinute(venue.openMin, t.locale),
                to: formatMinute(venue.closeMin, t.locale),
              })}{" "}
              ·{" "}
            </>
          )}
          {venue.cancelCutoffHours > 0
            ? t.plural("venue.freeCancel", venue.cancelCutoffHours)
            : t("venue.cancelAnyTime")}
          {ownCutoffs.map((r) => (
            <span key={r.sport}>
              {" "}
              · {sportLabel(t, r.sport)}: {r.cutoffHours! > 0 ? t.plural("venue.freeCancel", r.cutoffHours!) : t("venue.cancelAnyTime")}
            </span>
          ))}
        </p>
        {loyalty !== null && <p className="mt-1 text-sm font-medium text-teal-700">🎁 {t("loyalty.note", { n: loyalty })}</p>}
      </div>
      {access.access === "members" &&
        (member ? (
          <div className="rounded-xl border border-teal-200 bg-teal-50 px-4 py-3 text-sm text-teal-900">
            🎟️ {t("access.youAreMember")}
            {memberUntil && <p className="mt-0.5 text-xs">{t("mv6.until", { until: memberUntil })}</p>}
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
      {/* No booking needed where a resource takes entries with no set time (lib/entries.ts). */}
      <EntryPanel entries={await publicEntries(venue.id)} t={t} />
      {plans.length > 0 && access.access !== "private" && (
        // Where a refusal's renewal link lands (lib/entitlements.ts renewPath).
        <div id="membership" className="scroll-mt-20">
          <JoinMembership
            venueId={venue.id}
            plans={plans}
            standing={standing}
            canAutoRenew={canAutoRenew}
            renewals={renewals}
            people={people}
            families={families}
          />
        </div>
      )}
      {passProducts.length > 0 && (
        <div id="passes" className="scroll-mt-20">
          <BuyPass venueId={venue.id} products={passProducts} standing={passStanding} people={passPeople} />
        </div>
      )}
      {coaches.length > 0 && (
        <section className="rounded-xl border border-slate-200 bg-white px-4 py-3">
          <h2 className="font-semibold">🎓 {t("coach.title")}</h2>
          <p className="mt-0.5 text-xs text-slate-500">{t("coach.intro")}</p>
          {venueAssigns && (
            <div className="mt-2 space-y-2">
              <p className="text-xs text-slate-500">{t("co6.assigns")}</p>
              <div className="flex flex-wrap gap-2">
                {lessonSports.map((s) => (
                  <Link
                    key={s}
                    href={`/venue/${venue.id}/lesson?sport=${s}`}
                    className="rounded-lg border border-teal-300 px-3 py-1.5 text-xs font-semibold text-teal-700 hover:bg-teal-50"
                  >
                    {t("co6.bookSport", { sport: sportLabel(t, s) })}
                  </Link>
                ))}
              </div>
            </div>
          )}
          <ul className="mt-2 divide-y divide-slate-100">
            {coaches.map((c) => (
              <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <span>
                  <span className="font-medium">{c.name}</span>
                  <span className="text-slate-500"> · {c.sports.map((s) => sportLabel(t, s)).join(", ")} · {t("coach.rate", { amount: money(c.rate) })}</span>
                  {c.bio && <span className="block text-xs text-slate-500">{c.bio}</span>}
                </span>
                {!venueAssigns && (
                  <Link
                    href={`/venue/${venue.id}/coach/${c.id}`}
                    className="rounded-lg border border-teal-300 px-3 py-1.5 text-xs font-semibold text-teal-700 hover:bg-teal-50"
                  >
                    {t("coach.book")}
                  </Link>
                )}
              </li>
            ))}
          </ul>
        </section>
      )}
      {gifts && (
        <Link href={`/venue/${venue.id}/gift`} className="inline-block text-sm font-medium text-teal-700 hover:underline">
          {t("gift.buyLink")}
        </Link>
      )}
      {hasRankings && (
        <Link href={`/venue/${venue.id}/rankings`} className="inline-block text-sm font-medium text-teal-700 hover:underline">
          {t("rt.board.link")}
        </Link>
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
          {(rules.upcoming !== null || rules.perWeek !== null || rules.perDay !== null || rules.aheadDays !== null) && ". "}
          {rules.memberAheadDays !== null && t("rules.membersAhead", { n: memberAhead(rules) })}
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
            .map((c) => (c.reason ? `${shortDate(c.date, t.locale, true)} (${c.reason})` : shortDate(c.date, t.locale, true)))
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
      {/* Activities that need the venue's approval first: apply online. */}
      <ApprovalOffers t={t} venueId={venue.id} />
      {/* Booking first: it is what nearly everybody came for. */}
      <BookingBoard venueId={venue.id} venueName={venue.name} sports={sports} dates={dates} initial={initial} contact={venueContact(venue)} />
      <LiveOccupancy venueId={venue.id} />
      {/* What it has, and where it is, side by side on a wide screen. */}
      <div className="grid gap-4 md:grid-cols-2">
        <VenueFacilities t={t} venue={venue} />
        {venue.lat !== null && venue.lng !== null && <PinMap pin={{ lat: venue.lat, lng: venue.lng }} height={180} />}
      </div>
      <VenueReviews t={t} locale={await currentLocale()} venueName={venue.name} rating={rating} reviews={reviews} />
      <HireEnquiry venueId={venue.id} venueName={venue.name} />
    </div>
  );
}

/**
 * Turn ?date=&sport=&court=&start=&minutes= from a search result (or "Book
 * again") into a selection: `start` in minutes of the day or HH:MM, `minutes`
 * its length; `heading` the kinds of kit to show together. The older
 * `hour=&duration=` (hours) reads the same way. Whether
 * the court takes that time is the board's to check against its starts.
 */
function parseInitialSelection(query: Record<string, string | string[] | undefined>, sports: Sport[], dates: string[]) {
  const one = (key: string) => {
    const value = query[key];
    return Array.isArray(value) ? value[0] : value;
  };

  const sport = one("sport");
  const date = one("date");
  const courtId = Number(one("court"));
  const rawStart = one("start");
  const start =
    rawStart !== undefined
      ? /^\d+$/.test(rawStart)
        ? Number(rawStart)
        : parseClock(rawStart)
      : one("hour") !== undefined
        ? Math.round(Number(one("hour")) * 60)
        : null;
  const minutes = one("minutes") !== undefined ? Number(one("minutes")) : one("duration") !== undefined ? Math.round(Number(one("duration")) * 60) : undefined;

  return {
    sport: sport && isKnownActivity(sport) && sports.includes(sport as Sport)
      ? (sport as Sport)
      : undefined,
    date: date && dates.includes(date) ? date : undefined,
    courtId: Number.isInteger(courtId) && courtId > 0 ? courtId : undefined,
    start: isMinute(start) ? start : undefined,
    minutes: minutes !== undefined && Number.isInteger(minutes) && minutes > 0 ? minutes : undefined,
    // Kinds of kit under one heading, from search: shown on the grid.
    heading: (() => {
      const h = one("heading")?.trim();
      return h && h.length >= 2 && h.length <= 40 ? h : undefined;
    })(),
  };
}
