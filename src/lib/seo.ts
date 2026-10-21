import { getDb } from "./db";
import { LISTED_PUBLICLY, listRule } from "./listing";
import { baseUrl } from "./outbox";
import { currentStorefront } from "./storefront";
import { region } from "./region";
import { SPORT_LABELS, type Sport } from "./types";

/**
 * What search engines are given: where the site is, which venues it lists,
 * and what each venue is, in the words schema.org uses.
 *
 * Only what a visitor could find from the home page goes in a sitemap: a
 * private venue, or a members-only one kept out of search, never does, and a
 * storefront lists only its own venues, under its own address.
 */

/** The address this request is being served on: the storefront's, or the install's. */
export async function siteOrigin(): Promise<string> {
  const storefront = await currentStorefront();
  return storefront ? `https://${storefront.hostname}` : baseUrl();
}

/** The venues a search engine may list here, with when each last changed as far as we know. */
export async function listedVenues(): Promise<{ id: number; publishedAt: string | null }[]> {
  const storefront = await currentStorefront();
  const ids = storefront?.venueIds;
  if (ids && ids.length === 0) return [];
  const rows = (await getDb()
    .prepare(
      `SELECT v.id, v.published_at FROM venues v WHERE ${listRule(ids)}${ids ? ` AND v.id IN (${ids.map(() => "?").join(",")})` : ""} ORDER BY v.id LIMIT 50000`
    )
    .all(...(ids ?? []))) as { id: number; published_at: string | null }[];
  return rows.map((r) => ({ id: r.id, publishedAt: r.published_at }));
}

/** "Badminton and futsal courts in Bangsar": a venue page's description to start from. */
export function sportsLine(sports: Sport[]): string {
  const names = sports.map((s) => SPORT_LABELS[s] ?? s);
  if (names.length === 0) return "Sports courts";
  return names.length === 1 ? names[0] : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** schema.org's description of a venue, for a `<script type="application/ld+json">`. */
export function venueJsonLd(venue: {
  name: string;
  address: string;
  area: string;
  phone: string;
  openHour: number;
  closeHour: number;
  lat: number | null;
  lng: number | null;
  url: string;
  image: string | null;
  sports: Sport[];
  /** From verified bookings, shown only from a few reviews up (lib/reviews.ts). */
  rating?: { average: number; count: number } | null;
}): Record<string, unknown> {
  const hh = (h: number) => `${String(h % 24).padStart(2, "0")}:00`;
  return {
    "@context": "https://schema.org",
    "@type": "SportsActivityLocation",
    name: venue.name,
    url: venue.url,
    telephone: venue.phone,
    address: { "@type": "PostalAddress", streetAddress: venue.address, addressLocality: venue.area, addressCountry: region().country },
    ...(venue.lat !== null && venue.lng !== null ? { geo: { "@type": "GeoCoordinates", latitude: venue.lat, longitude: venue.lng } } : {}),
    ...(venue.image ? { image: venue.image } : {}),
    openingHoursSpecification: {
      "@type": "OpeningHoursSpecification",
      dayOfWeek: ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"],
      opens: hh(venue.openHour),
      closes: hh(venue.closeHour),
    },
    keywords: venue.sports.map((s) => SPORT_LABELS[s] ?? s).join(", "),
    ...(venue.rating
      ? { aggregateRating: { "@type": "AggregateRating", ratingValue: venue.rating.average, reviewCount: venue.rating.count, bestRating: 5, worstRating: 1 } }
      : {}),
  };
}

/** May a search engine list this venue's page: live, and public or members-only but findable? */
export async function venueIsListed(venueId: number): Promise<boolean> {
  return (await getDb().prepare(`SELECT 1 AS ok FROM venues v WHERE v.id = ? AND ${LISTED_PUBLICLY}`).get(venueId)) !== undefined;
}
