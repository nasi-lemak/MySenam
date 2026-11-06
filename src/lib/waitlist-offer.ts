import { getDb } from "./db";
import { struckOut } from "./cancel-policy";
import { holdPolicy } from "./holds";
import { guestSurge } from "./limits";
import { takesPaymentOnline } from "./payments";
import { getClass, getCourt, getVenue, offerEndsAt, quoteFor } from "./store";

/**
 * A waiting-list offer as the person holding its link sees it before
 * claiming (app/waitlist/[token]; docs/features/booking.md#waitlists):
 * what is offered (the venue, the court or class, the day and time, who it is
 * for), what it costs now, until when the offer stands, and whether, once
 * claimed, the booking is held until it is paid online and for how long, as
 * the claim will do it (`claimHold`). Claiming is still what books it and
 * checks everything again; this changes nothing.
 */
export interface OfferView {
  venue: { id: number; name: string; area: string; address: string; timeZone: string };
  kind: "court" | "class";
  /** The court's or the class's name. */
  what: string;
  instructor: string | null;
  date: string;
  startMin: number;
  endMin: number;
  places: number;
  /** Named on the entry besides (or instead of) its customer: a child, by the name kept. */
  forNames: string[];
  /** As it would be booked now, for every place; null where it cannot be priced (the claim says why). */
  price: number | null;
  /** When the offer passes to the next person (UTC, "YYYY-MM-DD HH:MM:SS"). */
  offerEnds: string;
  /** Claimed, it is held this many minutes until paid online, and let go after; null: booked outright. */
  holdMinutes: number | null;
  /** The venue takes payment online at all. */
  payOnline: boolean;
}

interface OfferRow {
  id: number;
  class_id: number | null;
  court_id: number | null;
  date: string | null;
  start_min: number | null;
  end_min: number | null;
  phone: string;
  user_id: number | null;
  status: string;
  offered_at: string | null;
  offer_minutes: number | null;
  places: number | null;
  customer_takes_part: boolean | null;
  made_by: "customer" | "staff" | "api" | null;
}

/**
 * Held until paid once claimed? As the claim route decides it
 * (app/api/waitlist/claim): where the venue holds unpaid bookings, or this
 * number is past its no-shows, or it books without an account while the
 * venue is flooded with unpaid guest bookings (lib/limits.ts), and the venue
 * takes payment online.
 */
export async function claimHold(venueId: number, phone: string, hasAccount: boolean): Promise<{ hold: boolean; minutes: number }> {
  const policy = await holdPolicy(venueId);
  if (policy.active) return { hold: true, minutes: policy.minutes };
  const mustPay = ((await struckOut(venueId, phone)).out || (!hasAccount && (await guestSurge(venueId)))) && (await takesPaymentOnline(venueId));
  return { hold: mustPay, minutes: policy.minutes };
}

export type OfferLookup = { ok: true; offer: OfferView } | { ok: false; code: "OFFER_INVALID" | "OFFER_EXPIRED" };

export async function describeOffer(token: string): Promise<OfferLookup> {
  const db = getDb();
  const row = (await db.prepare("SELECT * FROM waitlist WHERE offer_token = ?").get(token.trim())) as OfferRow | undefined;
  if (!row) return { ok: false, code: "OFFER_INVALID" };
  const ends = row.offered_at ? offerEndsAt(row.offered_at, row.offer_minutes) : 0;
  if (row.status !== "offered" || ends <= Date.now()) return { ok: false, code: "OFFER_EXPIRED" };

  const session = row.class_id ? await getClass(row.class_id) : null;
  const court = await getCourt(session ? session.courtId : (row.court_id ?? 0));
  if (!court) return { ok: false, code: "OFFER_INVALID" };
  const venue = await getVenue(court.venueId);
  if (!venue) return { ok: false, code: "OFFER_INVALID" };
  const named = (await db
    .prepare("SELECT participant_id AS id, name FROM waitlist_participants WHERE waitlist_id = ? ORDER BY id")
    .all(row.id)) as { id: number | null; name: string | null }[];
  const places = row.places ?? 1;
  const date = session ? session.date : row.date!;
  const startMin = session ? session.startMin : row.start_min!;
  const endMin = session ? session.endMin : row.end_min!;

  let price: number | null = null;
  if (session) price = Math.round(session.price * places * 100) / 100;
  else {
    const ids = named.filter((p) => p.id !== null).map((p) => ({ id: p.id as number }));
    const quoted = await quoteFor({
      courtId: court.id,
      date,
      start: startMin,
      end: endMin,
      phone: row.phone,
      userId: row.user_id,
      by: row.made_by ?? "customer",
      ...(places > 1 ? { players: places } : {}),
      ...(ids.length > 0 ? { people: { participants: ids, customerTakesPart: row.customer_takes_part !== false } } : {}),
    });
    if (quoted.ok) price = quoted.quote.total;
  }
  const hold = await claimHold(venue.id, row.phone, row.user_id !== null);
  return {
    ok: true,
    offer: {
      venue: { id: venue.id, name: venue.name, area: venue.area, address: venue.address, timeZone: venue.timeZone },
      kind: session ? "class" : "court",
      what: session ? session.name : court.name,
      instructor: session ? session.instructor : null,
      date,
      startMin,
      endMin,
      places,
      forNames: named.map((p) => p.name ?? "").filter(Boolean),
      price,
      offerEnds: new Date(ends).toISOString().replace("T", " ").slice(0, 19),
      holdMinutes: hold.hold && (price ?? 1) > 0 ? hold.minutes : null,
      payOnline: await takesPaymentOnline(venue.id),
    },
  };
}
