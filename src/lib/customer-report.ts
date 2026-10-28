import { getDb } from "./db";
import { roundMoney } from "./region";
import { addDays, todayISO } from "./time";

/**
 * Who the customers are, for a venue's owner: how many came, how many were
 * new, who the best customers are, which regulars have stopped coming, and how
 * often people do not turn up.
 *
 * A customer is a phone number, however it was typed (phone_key), as
 * everywhere else at the counter. Demo bookings and bookings whose names have
 * been removed under the retention policy are left out; so are classes'
 * enrolments, which are counted by the classes' own figures.
 */

export interface TopCustomer {
  name: string;
  phone: string;
  bookings: number;
  hours: number;
  spent: number;
  /** Their first booking here, ever. */
  since: string;
}

export interface LapsedCustomer {
  name: string;
  phone: string;
  /** Bookings in the half year before they stopped. */
  bookings: number;
  last: string;
}

export interface CustomerReport {
  from: string;
  to: string;
  customers: number;
  /** Booked here for the first time ever in the period. */
  newCustomers: number;
  returning: number;
  /** Bookings per customer in the period. */
  perCustomer: number;
  /** Of bookings in the period that have been played (or not): marked no-show. */
  noShows: number;
  noShowRate: number;
  lateCancels: number;
  top: TopCustomer[];
  /** Regulars (4 or more bookings in the six months before) with none since `lapsedSince`, and none coming. */
  lapsed: LapsedCustomer[];
  lapsedSince: string;
}

/** How long without a booking before a regular counts as lapsed. */
export const LAPSED_DAYS = 45;
/** How many bookings in half a year make a regular. */
export const REGULAR_BOOKINGS = 4;

/** Bookings that name a customer: not demo, not a test from before going live, not anonymised, not a class enrolment. */
const COUNTED = "b.demo = 0 AND NOT b.test AND b.phone <> '' AND b.class_id IS NULL";

export async function customerReport(venueId: number, from: string, to: string): Promise<CustomerReport> {
  const db = getDb();
  const at = "b.court_id IN (SELECT id FROM courts WHERE venue_id = ?)";

  const people = (await db
    .prepare(
      `WITH period AS (
         SELECT b.phone_key, COUNT(*)::int AS n FROM bookings b
          WHERE ${at} AND ${COUNTED} AND b.status = 'confirmed' AND b.date BETWEEN ? AND ?
          GROUP BY b.phone_key
       ), firsts AS (
         SELECT b.phone_key, MIN(b.date) AS first FROM bookings b
          WHERE ${at} AND ${COUNTED} AND b.status = 'confirmed' AND b.phone_key IN (SELECT phone_key FROM period)
          GROUP BY b.phone_key
       )
       SELECT COUNT(*)::int AS customers, COALESCE(SUM(p.n), 0)::int AS bookings,
              COUNT(*) FILTER (WHERE f.first >= ?)::int AS new_customers
         FROM period p JOIN firsts f ON f.phone_key = p.phone_key`
    )
    .get(venueId, from, to, venueId, from)) as { customers: number; bookings: number; new_customers: number };

  const today = todayISO();
  const shows = (await db
    .prepare(
      `SELECT COUNT(*) FILTER (WHERE b.status = 'confirmed' AND b.date < ?)::int AS played,
              COUNT(*) FILTER (WHERE b.status = 'confirmed' AND b.no_show = 1)::int AS no_shows,
              COUNT(*) FILTER (WHERE b.late_cancelled = 1)::int AS late
         FROM bookings b WHERE ${at} AND ${COUNTED} AND b.date BETWEEN ? AND ?`
    )
    .get(today, venueId, from, to)) as { played: number; no_shows: number; late: number };

  const top = (await db
    .prepare(
      `SELECT b.phone_key, (array_agg(b.name ORDER BY b.date DESC, b.id DESC))[1] AS name,
              (array_agg(b.phone ORDER BY b.date DESC, b.id DESC))[1] AS phone,
              COUNT(*)::int AS bookings, (SUM(b.end_min - b.start_min) / 60.0)::float AS hours, SUM(b.total_price)::float AS spent,
              (SELECT MIN(x.date) FROM bookings x WHERE x.phone_key = b.phone_key AND x.court_id IN (SELECT id FROM courts WHERE venue_id = ?)
                 AND x.status = 'confirmed' AND x.demo = 0 AND NOT x.test) AS since
         FROM bookings b
        WHERE ${at} AND ${COUNTED} AND b.status = 'confirmed' AND b.date BETWEEN ? AND ?
        GROUP BY b.phone_key ORDER BY spent DESC, bookings DESC LIMIT 10`
    )
    .all(venueId, venueId, from, to)) as { name: string; phone: string; bookings: number; hours: number; spent: number; since: string }[];

  const lapsedSince = addDays(to < today ? to : today, -LAPSED_DAYS);
  const lapsed = (await db
    .prepare(
      `SELECT (array_agg(b.name ORDER BY b.date DESC, b.id DESC))[1] AS name,
              (array_agg(b.phone ORDER BY b.date DESC, b.id DESC))[1] AS phone,
              COUNT(*) FILTER (WHERE b.date >= ?)::int AS bookings, MAX(b.date) AS last
         FROM bookings b
        WHERE ${at} AND ${COUNTED} AND b.status = 'confirmed'
        GROUP BY b.phone_key
       HAVING MAX(b.date) < ? AND COUNT(*) FILTER (WHERE b.date >= ?) >= ?
        ORDER BY bookings DESC, last DESC LIMIT 20`
    )
    .all(addDays(lapsedSince, -182), venueId, lapsedSince, addDays(lapsedSince, -182), REGULAR_BOOKINGS)) as LapsedCustomer[];

  return {
    from,
    to,
    customers: people.customers,
    newCustomers: people.new_customers,
    returning: people.customers - people.new_customers,
    perCustomer: people.customers === 0 ? 0 : Math.round((people.bookings / people.customers) * 10) / 10,
    noShows: shows.no_shows,
    noShowRate: shows.played === 0 ? 0 : Math.round((shows.no_shows / shows.played) * 1000) / 10,
    lateCancels: shows.late,
    top: top.map((r) => ({ name: r.name, phone: r.phone, bookings: r.bookings, hours: Number(r.hours), spent: roundMoney(Number(r.spent)), since: r.since })),
    lapsed: lapsed.map((r) => ({ name: r.name, phone: r.phone, bookings: Number(r.bookings), last: r.last })),
    lapsedSince,
  };
}
