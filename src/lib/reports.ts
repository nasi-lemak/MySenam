import { getDb } from "./db";
import { SAME_CREDIT } from "./branches";
import { creditScope } from "./mode";
import { Sport } from "./types";
import { addDays, todayISO } from "./time";

/**
 * Reporting for the person who pays for the software.
 *
 * The dashboard already answers "what is happening today". A venue owner asks
 * a different set of questions once a month — what did we take, how full were
 * we, which courts are carrying the place, and what do we still owe people —
 * and none of them could be answered without exporting the database.
 *
 * Everything here is keyed on the date the slot was *played*, not the date the
 * booking was made, because that is how an operator thinks about a month.
 */

export interface RevenueLine {
  /** What confirmed bookings in the period came to. */
  expected: number;
  /** What has actually been marked paid. */
  collected: number;
  outstanding: number;
}

export interface SportLine {
  sport: Sport;
  bookings: number;
  hours: number;
  expected: number;
  collected: number;
}

export interface CourtLine {
  courtId: number;
  courtName: string;
  sport: Sport;
  /** Place-hours sold. A gym floor selling 3 places for an hour counts 3. */
  hours: number;
  /** Place-hours that could have been sold, after closures and blocks. */
  sellableHours: number;
  utilisation: number;
  expected: number;
}

export interface MonthLine {
  /** `YYYY-MM`. */
  month: string;
  expected: number;
  collected: number;
  hours: number;
}

export interface HourLine {
  hour: number;
  hours: number;
}

export interface VenueReport {
  venueId: number;
  venueName: string;
  from: string;
  to: string;
  days: number;
  /** Days in the period the venue was shut for the whole day. */
  closedDays: number;
  bookings: { confirmed: number; cancelled: number; noShows: number; hours: number };
  revenue: RevenueLine;
  /**
   * Split, because one number across both would be meaningless. A forty-place
   * gym floor offers more place-hours in a fortnight than every court in the
   * building put together, so blending them lets the gym decide the headline
   * and an owner learns nothing about either.
   */
  utilisation: {
    courts: { soldHours: number; sellableHours: number; percent: number };
    shared: { soldHours: number; sellableHours: number; percent: number };
  };
  bySport: SportLine[];
  byCourt: CourtLine[];
  byMonth: MonthLine[];
  /** Place-hours sold per hour of the day — where peak actually is. */
  byHour: HourLine[];
  liabilities: {
    /** Entries sold and not yet spent on live passes: hours the venue owes. */
    passEntriesUnspent: number;
    passesLive: number;
    membershipsActive: number;
    membershipsExpiringSoon: number;
  };
}

/** How many days the expiry window for "expiring soon" covers. */
export const EXPIRING_SOON_DAYS = 30;

function monthsIn(from: string, to: string): string[] {
  const months: string[] = [];
  for (let d = from.slice(0, 7); d <= to.slice(0, 7); ) {
    months.push(d);
    const [y, m] = d.split("-").map(Number);
    d = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  }
  return months;
}

/**
 * Everything a venue owner asks at the end of a month.
 *
 * Cancelled bookings are counted but earn nothing: they are shown as their own
 * number rather than folded into revenue, so a month that looks thin can be
 * read as either "we sold less" or "they cancelled".
 */
export async function venueReport(venueId: number, from: string, to: string): Promise<VenueReport | null> {
  const db = getDb();
  const venue = await db.prepare("SELECT * FROM venues WHERE id = ?").get(venueId) as
    | { id: number; name: string; open_hour: number; close_hour: number }
    | undefined;
  if (!venue) return null;

  const courts = await db
    .prepare("SELECT id, name, sport, capacity FROM courts WHERE venue_id = ? ORDER BY id")
    .all(venueId) as { id: number; name: string; sport: Sport; capacity: number }[];

  const days = Math.max(
    1,
    Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1
  );

  const { closedDays } = await db
    .prepare(
      `SELECT COUNT(*) AS "closedDays" FROM venue_closures WHERE venue_id = ? AND date >= ? AND date <= ?`
    )
    .get(venueId, from, to) as { closedDays: number };

  // Every query below picks the venue's rows by their own court_id rather than
  // by joining to courts and filtering there: the index on (court_id, date)
  // can then go straight to this venue's period. Filtering on the join reads
  // every venue's bookings for the period, so a report slowed down with each
  // venue added to the platform rather than with this venue's own trade.

  // --- bookings and money, one row per booking -----------------------------
  const counts = await db
    .prepare(`
      SELECT
        SUM(CASE WHEN b.status = 'confirmed' THEN 1 ELSE 0 END) AS confirmed,
        SUM(CASE WHEN b.status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
        SUM(CASE WHEN b.no_show = 1 THEN 1 ELSE 0 END) AS "noShows",
        SUM(CASE WHEN b.status = 'confirmed' THEN b.total_price ELSE 0 END) AS expected,
        SUM(CASE WHEN b.status = 'confirmed' AND b.payment_status = 'paid' THEN b.total_price ELSE 0 END) AS collected
      FROM bookings b
      JOIN courts c ON c.id = b.court_id
      WHERE b.court_id IN (SELECT id FROM courts WHERE venue_id = ?) AND b.date >= ? AND b.date <= ?
    `)
    .get(venueId, from, to) as {
    confirmed: number | null;
    cancelled: number | null;
    noShows: number | null;
    expected: number | null;
    collected: number | null;
  };

  const expected = counts.expected ?? 0;
  const collected = counts.collected ?? 0;

  // --- place-hours sold ----------------------------------------------------
  const { soldHours } = await db
    .prepare(`
      SELECT COUNT(*) AS "soldHours" FROM booking_slots s
      JOIN bookings b ON b.id = s.booking_id
      JOIN courts c ON c.id = b.court_id
      WHERE s.court_id IN (SELECT id FROM courts WHERE venue_id = ?) AND s.date >= ? AND s.date <= ? AND b.status = 'confirmed'
    `)
    .get(venueId, from, to) as { soldHours: number };

  // --- what could have been sold ------------------------------------------
  // The trading day, times capacity, times the days the venue was open, less
  // whatever staff took out of service.
  const tradingHours = Math.max(0, venue.close_hour - venue.open_hour);
  const openDays = days - closedDays;
  const blockedByCourt = new Map<number, number>();
  for (const row of await db
    .prepare(`
      SELECT b.court_id AS "courtId", SUM(COALESCE(b.places, c.capacity)) AS blocked
      FROM blocks_between(?, ?) b
      JOIN courts c ON c.id = b.court_id
      WHERE b.court_id IN (SELECT id FROM courts WHERE venue_id = ?)
      GROUP BY b.court_id
    `)
    .all(from, to, venueId) as { courtId: number; blocked: number }[])
    blockedByCourt.set(row.courtId, row.blocked);

  const sellableFor = (court: { id: number; capacity: number }) =>
    Math.max(0, tradingHours * court.capacity * openDays - (blockedByCourt.get(court.id) ?? 0));

  // --- per court -----------------------------------------------------------
  const soldByCourt = new Map<number, { hours: number; expected: number }>();
  for (const row of await db
    .prepare(`
      SELECT b.court_id AS "courtId", COUNT(*) AS hours
      FROM booking_slots s
      JOIN bookings b ON b.id = s.booking_id
      JOIN courts c ON c.id = b.court_id
      WHERE s.court_id IN (SELECT id FROM courts WHERE venue_id = ?) AND s.date >= ? AND s.date <= ? AND b.status = 'confirmed'
      GROUP BY b.court_id
    `)
    .all(venueId, from, to) as { courtId: number; hours: number }[])
    soldByCourt.set(row.courtId, { hours: row.hours, expected: 0 });

  for (const row of await db
    .prepare(`
      SELECT b.court_id AS "courtId", SUM(b.total_price) AS expected
      FROM bookings b
      JOIN courts c ON c.id = b.court_id
      WHERE b.court_id IN (SELECT id FROM courts WHERE venue_id = ?) AND b.date >= ? AND b.date <= ? AND b.status = 'confirmed'
      GROUP BY b.court_id
    `)
    .all(venueId, from, to) as { courtId: number; expected: number }[]) {
    const entry = soldByCourt.get(row.courtId) ?? { hours: 0, expected: 0 };
    entry.expected = row.expected;
    soldByCourt.set(row.courtId, entry);
  }

  const byCourt: CourtLine[] = courts.map((court) => {
    const sold = soldByCourt.get(court.id) ?? { hours: 0, expected: 0 };
    const sellableHours = sellableFor(court);
    return {
      courtId: court.id,
      courtName: court.name,
      sport: court.sport,
      hours: sold.hours,
      sellableHours,
      utilisation: sellableHours === 0 ? 0 : sold.hours / sellableHours,
      expected: sold.expected,
    };
  });

  // --- per sport -----------------------------------------------------------
  const bySport: SportLine[] = (
    await db
      .prepare(`
        SELECT c.sport AS sport, COUNT(*) AS bookings,
               SUM(b.total_price) AS expected,
               SUM(CASE WHEN b.payment_status = 'paid' THEN b.total_price ELSE 0 END) AS collected
        FROM bookings b
        JOIN courts c ON c.id = b.court_id
        WHERE b.court_id IN (SELECT id FROM courts WHERE venue_id = ?) AND b.date >= ? AND b.date <= ? AND b.status = 'confirmed'
        GROUP BY c.sport
        ORDER BY expected DESC
      `)
      .all(venueId, from, to) as {
      sport: Sport;
      bookings: number;
      expected: number;
      collected: number;
    }[]
  ).map((row) => ({
    ...row,
    hours: byCourt
      .filter((c) => c.sport === row.sport)
      .reduce((sum, c) => sum + c.hours, 0),
  }));

  // --- per month, for the trend -------------------------------------------
  const monthRows = await db
    .prepare(`
      SELECT substr(b.date, 1, 7) AS month,
             SUM(b.total_price) AS expected,
             SUM(CASE WHEN b.payment_status = 'paid' THEN b.total_price ELSE 0 END) AS collected
      FROM bookings b
      JOIN courts c ON c.id = b.court_id
      WHERE b.court_id IN (SELECT id FROM courts WHERE venue_id = ?) AND b.date >= ? AND b.date <= ? AND b.status = 'confirmed'
      GROUP BY month
    `)
    .all(venueId, from, to) as { month: string; expected: number; collected: number }[];
  const monthHours = await db
    .prepare(`
      SELECT substr(s.date, 1, 7) AS month, COUNT(*) AS hours
      FROM booking_slots s
      JOIN bookings b ON b.id = s.booking_id
      JOIN courts c ON c.id = b.court_id
      WHERE s.court_id IN (SELECT id FROM courts WHERE venue_id = ?) AND s.date >= ? AND s.date <= ? AND b.status = 'confirmed'
      GROUP BY month
    `)
    .all(venueId, from, to) as { month: string; hours: number }[];

  const byMonth: MonthLine[] = monthsIn(from, to).map((month) => ({
    month,
    expected: monthRows.find((r) => r.month === month)?.expected ?? 0,
    collected: monthRows.find((r) => r.month === month)?.collected ?? 0,
    hours: monthHours.find((r) => r.month === month)?.hours ?? 0,
  }));

  // --- when the place is actually busy ------------------------------------
  const hourRows = await db
    .prepare(`
      SELECT s.hour AS hour, COUNT(*) AS hours
      FROM booking_slots s
      JOIN bookings b ON b.id = s.booking_id
      JOIN courts c ON c.id = b.court_id
      WHERE s.court_id IN (SELECT id FROM courts WHERE venue_id = ?) AND s.date >= ? AND s.date <= ? AND b.status = 'confirmed'
      GROUP BY s.hour
    `)
    .all(venueId, from, to) as { hour: number; hours: number }[];
  const byHour: HourLine[] = Array.from({ length: tradingHours }, (_, i) => {
    const hour = venue.open_hour + i;
    return { hour, hours: hourRows.find((r) => r.hour === hour)?.hours ?? 0 };
  });

  // --- what the venue still owes people -----------------------------------
  const today = todayISO();
  const { passEntriesUnspent, passesLive } = await db
    .prepare(`
      SELECT
        COALESCE(SUM(p.entries + COALESCE((SELECT SUM(e.delta) FROM pass_entries e WHERE e.pass_id = p.id), 0)), 0) AS "passEntriesUnspent",
        COUNT(*) AS "passesLive"
      FROM passes p
      WHERE p.venue_id = ? AND p.status = 'active' AND p.expires_on >= ?
    `)
    .get(venueId, today) as { passEntriesUnspent: number; passesLive: number };

  const { membershipsActive } = await db
    .prepare(`
      SELECT COUNT(*) AS "membershipsActive" FROM memberships
      WHERE venue_id = ? AND status = 'active' AND starts_on <= ? AND expires_on >= ?
    `)
    .get(venueId, today, today) as { membershipsActive: number };

  const { membershipsExpiringSoon } = await db
    .prepare(`
      SELECT COUNT(*) AS "membershipsExpiringSoon" FROM memberships
      WHERE venue_id = ? AND status = 'active' AND expires_on >= ? AND expires_on <= ?
    `)
    .get(venueId, today, addDays(today, EXPIRING_SOON_DAYS)) as {
    membershipsExpiringSoon: number;
  };

  const split = (rows: CourtLine[]) => {
    const sold = rows.reduce((n, c) => n + c.hours, 0);
    const sellable = rows.reduce((n, c) => n + c.sellableHours, 0);
    return { soldHours: sold, sellableHours: sellable, percent: sellable === 0 ? 0 : sold / sellable };
  };
  const exclusive = courts.filter((c) => c.capacity === 1).map((c) => c.id);

  return {
    venueId,
    venueName: venue.name,
    from,
    to,
    days,
    closedDays,
    bookings: {
      confirmed: counts.confirmed ?? 0,
      cancelled: counts.cancelled ?? 0,
      noShows: counts.noShows ?? 0,
      hours: soldHours,
    },
    revenue: { expected, collected, outstanding: expected - collected },
    utilisation: {
      courts: split(byCourt.filter((c) => exclusive.includes(c.courtId))),
      shared: split(byCourt.filter((c) => !exclusive.includes(c.courtId))),
    },
    bySport,
    byCourt,
    byMonth,
    byHour,
    liabilities: {
      passEntriesUnspent,
      passesLive,
      membershipsActive,
      membershipsExpiringSoon,
    },
  };
}

/**
 * Credit customers hold and have not spent, that the platform owes.
 *
 * Where credit is platform-wide, that is all of it: bought at one counter and
 * spendable at any, so the platform owes it, not the venue that happened to
 * sell it. Where credit is per venue, it is only what is spendable anywhere —
 * credit from before the switch — and each venue's own is that venue's (see
 * `venueCreditLiability`).
 */
export async function walletLiability(): Promise<{ customers: number; balance: number }> {
  const perVenue = creditScope() === "venue";
  const row = await getDb()
    .prepare(`
      SELECT COUNT(*) AS customers, COALESCE(SUM(balance), 0) AS balance FROM (
        SELECT user_id, SUM(amount) AS balance FROM wallet_entries
        ${perVenue ? "WHERE venue_id IS NULL" : ""}
        GROUP BY user_id HAVING SUM(amount) > 0
      ) AS owed
    `)
    .get() as { customers: number; balance: number };
  return row;
}

/**
 * Credit sold by this venue and not yet spent: what it owes, where credit is
 * per venue. For a branch, that is its whole business's: credit bought at one
 * branch is spent at any of them, so it is owed by the business, not by
 * whichever branch happened to sell it.
 */
export async function venueCreditLiability(venueId: number): Promise<{ customers: number; balance: number }> {
  return await getDb()
    .prepare(`
      SELECT COUNT(*) AS customers, COALESCE(SUM(balance), 0) AS balance FROM (
        SELECT user_id, SUM(amount) AS balance FROM wallet_entries
        WHERE ${SAME_CREDIT}
        GROUP BY user_id HAVING SUM(amount) > 0
      ) AS owed
    `)
    .get(venueId) as { customers: number; balance: number };
}
