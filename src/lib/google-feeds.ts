import { getDb } from "./db";
import { region } from "./region";
import { siteOrigin, venueIsListed } from "./seo";
import { getAvailability, getVenue } from "./store";
import { addDays, slotStartsAt, todayISO } from "./time";
import { SPORT_LABELS, type Sport } from "./types";

/**
 * Feeds for Google's Reserve with Google (the Actions Center), shaped after
 * its merchant, service and availability feed formats: what a partner
 * uploads so that "Book" on a venue's Google listing opens its slots.
 *
 * **Readiness, not integration.** Being listed needs the platform to be
 * accepted as an Actions Center partner, to upload these by SFTP on Google's
 * schedule, and to run the real-time Booking Server API Google calls to
 * check and make bookings, which is not built. The field names follow the
 * published feed specification as last read; check them against the current
 * one during onboarding. Only venues that have opted in, are live and public
 * are included.
 *
 * A service is one sport for an hour at one venue; its availability is the
 * number of that sport's courts free at each hour, over the next 14 days.
 */

const FEED_DAYS = 14;

function metadata() {
  return {
    processing_instruction: "PROCESS_AS_COMPLETE",
    shard_number: 0,
    total_shards: 1,
    nonce: Date.now(),
    generation_timestamp: Math.floor(Date.now() / 1000),
  };
}

async function listedVenues(): Promise<number[]> {
  const rows = (await getDb()
    .prepare("SELECT id FROM venues WHERE google_reserve = 1 AND access = 'public' ORDER BY id")
    .all()) as { id: number }[];
  // Live, on the marketplace and not suspended, as for search engines.
  const out: number[] = [];
  for (const r of rows) if (await venueIsListed(r.id)) out.push(r.id);
  return out;
}

export async function setGoogleReserve(venueId: number, on: boolean): Promise<void> {
  await getDb().prepare("UPDATE venues SET google_reserve = ? WHERE id = ?").run(on ? 1 : 0, venueId);
}

export async function googleReserveOn(venueId: number): Promise<boolean> {
  const r = (await getDb().prepare("SELECT google_reserve FROM venues WHERE id = ?").get(venueId)) as { google_reserve: number } | undefined;
  return r?.google_reserve === 1;
}

const merchantId = (venueId: number) => `venue-${venueId}`;
const serviceId = (venueId: number, sport: Sport) => `venue-${venueId}-${sport}-60`;

export async function merchantFeed(): Promise<Record<string, unknown>> {
  const origin = await siteOrigin();
  const merchant = [];
  for (const id of await listedVenues()) {
    const v = await getVenue(id);
    if (!v) continue;
    merchant.push({
      merchant_id: merchantId(v.id),
      name: v.name,
      telephone: v.phone,
      url: `${origin}/venue/${v.id}`,
      category: "sports_complex",
      geo: {
        ...(v.lat !== null && v.lng !== null ? { latitude: v.lat, longitude: v.lng } : {}),
        address: { country: region().country, locality: v.area, street_address: v.address },
      },
    });
  }
  return { metadata: metadata(), merchant };
}

export async function serviceFeed(): Promise<Record<string, unknown>> {
  const origin = await siteOrigin();
  const service = [];
  for (const id of await listedVenues()) {
    const v = await getVenue(id);
    if (!v) continue;
    const sports = [...new Set(v.courts.map((c) => c.sport))] as Sport[];
    for (const sport of sports) {
      const cheapest = Math.min(...v.courts.filter((c) => c.sport === sport).map((c) => c.offPeakRate));
      service.push({
        merchant_id: merchantId(v.id),
        service_id: serviceId(v.id, sport),
        name: `${SPORT_LABELS[sport] ?? sport} court, 1 hour`,
        description: `Book a ${SPORT_LABELS[sport] ?? sport} court at ${v.name}.`,
        price: { price_micros: Math.round(cheapest * 1_000_000), currency_code: region().currency.code },
        prepayment_type: "OPTIONAL",
        action_link: [{ url: `${origin}/venue/${v.id}?sport=${sport}` }],
      });
    }
  }
  return { metadata: metadata(), service };
}

export async function availabilityFeed(days = FEED_DAYS): Promise<Record<string, unknown>> {
  const availability: Record<string, unknown>[] = [];
  for (const id of await listedVenues()) {
    const v = await getVenue(id);
    if (!v) continue;
    const today = todayISO(v.timeZone);
    const sports = [...new Set(v.courts.map((c) => c.sport))] as Sport[];
    for (let i = 0; i < days; i++) {
      const date = addDays(today, i);
      for (const sport of sports) {
        const grid = await getAvailability(v.id, date, sport);
        const hours = [...new Set(grid.flatMap((g) => g.slots.map((s) => s.hour)))].filter((h) => Number.isInteger(h));
        for (const hour of hours) {
          // Each court's hour from here: whole, so both halves where it sells halves.
          const slots = grid
            .map((g) => g.slots.filter((s) => s.hour >= hour && s.hour < hour + 1))
            .filter((within, i) => within.length * grid[i].unit === 1);
          const open = slots.filter((within) => within.every((s) => s.available)).length;
          if (slots.length === 0) continue;
          availability.push({
            merchant_id: merchantId(v.id),
            service_id: serviceId(v.id, sport),
            start_sec: Math.floor(slotStartsAt(date, hour, v.timeZone).getTime() / 1000),
            duration_sec: 3600,
            spots_total: slots.length,
            spots_open: open,
          });
        }
      }
    }
  }
  return { metadata: metadata(), service_availability: [{ availability }] };
}
