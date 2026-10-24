import { getDb } from "./db";
import { SAME_CREDIT } from "./branches";
import { creditScope } from "./mode";
import { Sport } from "./types";
import { addDays, todayISO } from "./time";
import { venueTax } from "./tax";
import { venueHours } from "./store";
import { hoursOn, parseWeekHours } from "./week-hours";

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
  /**
   * The sales tax inside what was collected, at each booking's own rate,
   * plus that on the period's other receipts (passes, memberships, fees,
   * shares) less their credit notes, and what the venue calls it; null when
   * none of it was taxed.
   */
  tax: { name: string; amount: number } | null;
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
  /**
   * Hours it could not be sold because it, or a court sharing its floor, was
   * booked: a badminton court under a futsal pitch is in use while the pitch
   * is, though none of its own hours were sold. Equal to `hours` for a court
   * that shares nothing; place-hours on a shared facility.
   */
  inUseHours: number;
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
  /** What was collected, by how it was paid; "unrecorded" for counter payments marked before methods were asked. */
  collectedBy: { via: string; amount: number; bookings: number }[];
  /** Sold over the counter with no booking (lib/counter-sales.ts), not voided: outside the figures above. */
  counterSales: { sales: number; total: number };
  /**
   * Split, because one number across both would be meaningless. A forty-place
   * gym floor offers more place-hours in a fortnight than every court in the
   * building put together, so blending them lets the gym decide the headline
   * and an owner learns nothing about either.
   */
  utilisation: {
    /**
     * The floor, measured once (B11). Each piece of floor that can be sold on
     * its own (a court's own space, or each court under a pitch) is a unit;
     * an hour of a unit is in use when any booking covers it, whether it was
     * sold as the court or as the pitch over it. A pitch and its courts are
     * therefore not counted as separate sellable hours, and a hall sold as one
     * pitch every evening reads as full.
     */
    courts: { soldHours: number; sellableHours: number; percent: number };
    /** Places sold against places offered, on facilities that take several bookings at once. */
    shared: { soldHours: number; sellableHours: number; percent: number };
    /** Takings expected from the courts above, per hour of floor that could have been sold. */
    revenuePerHour: number;
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

/** Minutes covered by any of these spans, overlaps counted once. */
function unionMinutes(spans: { start: number; end: number }[]): number {
  let minutes = 0;
  let reach = -Infinity;
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    if (s.end <= reach) continue;
    minutes += s.end - Math.max(s.start, reach);
    reach = s.end;
  }
  return minutes;
}

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
    | { id: number; name: string; open_min: number; close_min: number; week_hours: string | null }
    | undefined;
  if (!venue) return null;

  const courts = await db
    .prepare("SELECT id, name, sport, capacity FROM courts WHERE venue_id = ? ORDER BY id")
    .all(venueId) as { id: number; name: string; sport: Sport; capacity: number }[];

  const days = Math.max(
    1,
    Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1
  );

  const closures = new Set(
    ((await db
      .prepare("SELECT date FROM venue_closures WHERE venue_id = ? AND date >= ? AND date <= ?")
      .all(venueId, from, to)) as { date: string }[]).map((r) => r.date)
  );
  // Each day by its own hours: a weekday the venue never opens is a closed day too.
  const usual = { openMin: venue.open_min, closeMin: venue.close_min, weekHours: parseWeekHours(venue.week_hours) };
  let closedDays = 0;
  let openHoursInPeriod = 0;
  let firstMin = venue.open_min;
  let lastMin = venue.close_min;
  const openOn = new Map<string, { start: number; end: number }>();
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const on = hoursOn(usual, d);
    if (closures.has(d) || on.closed) {
      closedDays++;
      continue;
    }
    openOn.set(d, { start: on.openMin, end: on.closeMin });
    openHoursInPeriod += (on.closeMin - on.openMin) / 60;
    firstMin = Math.min(firstMin, on.openMin);
    lastMin = Math.max(lastMin, on.closeMin);
  }
  const firstHour = Math.floor(firstMin / 60);
  const lastHour = Math.ceil(lastMin / 60);

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
        SUM(CASE WHEN b.status = 'confirmed' AND b.payment_status = 'paid' THEN b.total_price ELSE 0 END) AS collected,
        SUM(CASE WHEN b.status = 'confirmed' AND b.payment_status = 'paid' AND b.tax_rate IS NOT NULL
                      AND COALESCE(b.paid_via, '') <> 'pass'
                 THEN ROUND((b.total_price - b.shares_paid) * b.tax_rate / (100 + b.tax_rate), 2) END) AS "taxCollected"
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
    taxCollected: number | string | null;
  };

  const expected = counts.expected ?? 0;
  const collected = counts.collected ?? 0;

  // The tax on everything else sold, receipted as it was sold (passes,
  // memberships, fees, shares), less what credit notes took back of it.
  // A booking's own credit note is not counted: a cancelled booking is
  // already out of the sum above.
  const documents = (await db
    .prepare(`
      SELECT COUNT(*) AS n,
             COALESCE(SUM(CASE WHEN kind = 'receipt' THEN tax_amount
                               WHEN credits_id IS NOT NULL THEN -tax_amount ELSE 0 END), 0) AS tax
        FROM receipts
       WHERE venue_id = ? AND tax_rate IS NOT NULL
         -- Stamped in UTC; counted on the venue's own date.
         AND to_char((issued_at::timestamp AT TIME ZONE 'UTC') AT TIME ZONE ?, 'YYYY-MM-DD') BETWEEN ? AND ?
    `)
    .get(venueId, (await venueHours(venueId)).zone, from, to)) as { n: number | string; tax: number | string };
  const taxCollected =
    counts.taxCollected === null && Number(documents.n) === 0
      ? null
      : Math.round((Number(counts.taxCollected ?? 0) + Number(documents.tax)) * 100) / 100;

  const saleZone = (await venueHours(venueId)).zone;
  const counter = (await db
    .prepare(`
      SELECT COUNT(*) FILTER (WHERE rung) - COUNT(*) FILTER (WHERE voided) AS n,
             COALESCE(SUM(total) FILTER (WHERE rung), 0) - COALESCE(SUM(total) FILTER (WHERE voided), 0) AS total
        FROM (
          SELECT total,
                 to_char((created_at::timestamp AT TIME ZONE 'UTC') AT TIME ZONE ?, 'YYYY-MM-DD') BETWEEN ? AND ? AS rung,
                 voided_at IS NOT NULL
                   AND to_char((voided_at::timestamp AT TIME ZONE 'UTC') AT TIME ZONE ?, 'YYYY-MM-DD') BETWEEN ? AND ? AS voided
            FROM counter_sales WHERE venue_id = ?
        ) s
    `)
    // A sale counts on the day it was rung up, and a void comes off on the day it was made, so a
    // day's takings already counted do not change after the till has been cashed up.
    .get(saleZone, from, to, saleZone, from, to, venueId)) as {
    n: number | string;
    total: number | string;
  };

  const collectedBy = (
    (await db
      .prepare(`
        SELECT COALESCE(b.paid_via, 'unrecorded') AS via, SUM(b.total_price) AS amount, COUNT(*) AS bookings
        FROM bookings b
        WHERE b.court_id IN (SELECT id FROM courts WHERE venue_id = ?) AND b.date >= ? AND b.date <= ?
          AND b.status = 'confirmed' AND b.payment_status = 'paid'
        GROUP BY COALESCE(b.paid_via, 'unrecorded')
      `)
      .all(venueId, from, to)) as { via: string; amount: number | string; bookings: number | string }[]
  )
    .map((r) => ({ via: r.via, amount: Number(r.amount), bookings: Number(r.bookings) }))
    .sort((a, b) => b.amount - a.amount);

  // --- place-hours sold ----------------------------------------------------
  // Each confirmed booking is a place for its minutes; a class enrolment is one place in its class.
  const sold = (await db
    .prepare(`
      SELECT b.court_id, b.date, b.start_min, b.end_min FROM bookings b
      WHERE b.court_id IN (SELECT id FROM courts WHERE venue_id = ?) AND b.date >= ? AND b.date <= ? AND b.status = 'confirmed'
    `)
    .all(venueId, from, to)) as { court_id: number; date: string; start_min: number; end_min: number }[];
  const soldHours = sold.reduce((sum, b) => sum + (b.end_min - b.start_min), 0) / 60;

  // --- what could have been sold ------------------------------------------
  // The trading day, times capacity, times the days the venue was open, less
  // whatever staff took out of service: blocks on a court's own space or on
  // a court sharing its floor, and outages, within the hours it was open.
  const tradingHours = Math.max(0, lastHour - firstHour);
  const blockedByCourt = new Map<number, number>();
  const capacityOf = new Map(courts.map((c) => [c.id, c.capacity]));
  const blockRows = (await db
    .prepare(`
      SELECT DISTINCT COALESCE(cs.court_id, c.court_id) AS court_id, k.id, k.date, k.start_min, k.end_min, k.places
        FROM blocks k JOIN claims c ON c.block_id = k.id
        LEFT JOIN court_spaces cs ON cs.space_id = c.space_id
       WHERE k.venue_id = ? AND k.date >= ? AND k.date <= ?
    `)
    .all(venueId, from, to)) as { court_id: number; id: number; date: string; start_min: number; end_min: number; places: number | null }[];
  for (const b of blockRows) {
    const open = openOn.get(b.date);
    if (!open || !capacityOf.has(b.court_id)) continue;
    const minutes = Math.max(0, Math.min(b.end_min, open.end) - Math.max(b.start_min, open.start));
    const places = b.places ?? capacityOf.get(b.court_id)!;
    blockedByCourt.set(b.court_id, (blockedByCourt.get(b.court_id) ?? 0) + (places * minutes) / 60);
  }
  const outages = (await db
    .prepare(`
      SELECT DISTINCT COALESCE(cs.court_id, c.court_id) AS court_id, o.id, o.starts_on, o.ends_on
        FROM court_outages o JOIN claims c ON c.outage_id = o.id
        LEFT JOIN court_spaces cs ON cs.space_id = c.space_id
       WHERE c.venue_id = ? AND o.starts_on <= ? AND (o.ends_on IS NULL OR o.ends_on >= ?)
    `)
    .all(venueId, to, from)) as { court_id: number; id: number; starts_on: string; ends_on: string | null }[];
  for (const o of outages) {
    if (!capacityOf.has(o.court_id)) continue;
    for (const [d, open] of openOn) {
      if (d < o.starts_on || (o.ends_on !== null && d > o.ends_on)) continue;
      blockedByCourt.set(o.court_id, (blockedByCourt.get(o.court_id) ?? 0) + (capacityOf.get(o.court_id)! * (open.end - open.start)) / 60);
    }
  }

  const sellableFor = (court: { id: number; capacity: number }) =>
    Math.max(0, openHoursInPeriod * court.capacity - (blockedByCourt.get(court.id) ?? 0));

  // --- the floor, measured once (B11) ----------------------------------------
  // Which spaces each court covers; a unit is a space whose own court covers
  // nothing else, so a pitch's own space (only ever taken with its courts')
  // is not counted as more floor.
  const coverRows = (await db
    .prepare(`
      SELECT cs.court_id, cs.space_id, s.court_id AS owner
        FROM court_spaces cs JOIN spaces s ON s.id = cs.space_id
       WHERE s.venue_id = ?
    `)
    .all(venueId)) as { court_id: number; space_id: number; owner: number }[];
  const spacesOf = new Map<number, number[]>();
  for (const r of coverRows) spacesOf.set(r.court_id, [...(spacesOf.get(r.court_id) ?? []), r.space_id]);
  const units = new Set(
    coverRows.filter((r) => r.court_id === r.owner && (spacesOf.get(r.owner)?.length ?? 0) === 1).map((r) => r.space_id)
  );
  const unitMinutesOut = new Map<number, number>();
  for (const b of (await db
    .prepare(`
      SELECT DISTINCT c.space_id, k.id, k.date, k.start_min, k.end_min
        FROM blocks k JOIN claims c ON c.block_id = k.id
       WHERE k.venue_id = ? AND k.date >= ? AND k.date <= ? AND c.space_id IS NOT NULL
    `)
    .all(venueId, from, to)) as { space_id: number; date: string; start_min: number; end_min: number }[]) {
    const open = openOn.get(b.date);
    if (!open || !units.has(b.space_id)) continue;
    const minutes = Math.max(0, Math.min(b.end_min, open.end) - Math.max(b.start_min, open.start));
    unitMinutesOut.set(b.space_id, (unitMinutesOut.get(b.space_id) ?? 0) + minutes);
  }
  for (const o of (await db
    .prepare(`
      SELECT DISTINCT c.space_id, o.id, o.starts_on, o.ends_on
        FROM court_outages o JOIN claims c ON c.outage_id = o.id
       WHERE c.venue_id = ? AND c.space_id IS NOT NULL AND o.starts_on <= ? AND (o.ends_on IS NULL OR o.ends_on >= ?)
    `)
    .all(venueId, to, from)) as { space_id: number; starts_on: string; ends_on: string | null }[]) {
    if (!units.has(o.space_id)) continue;
    for (const [d, open] of openOn) {
      if (d < o.starts_on || (o.ends_on !== null && d > o.ends_on)) continue;
      unitMinutesOut.set(o.space_id, (unitMinutesOut.get(o.space_id) ?? 0) + (open.end - open.start));
    }
  }

  // --- per court -----------------------------------------------------------
  const soldByCourt = new Map<number, { hours: number; expected: number }>();
  for (const b of sold) {
    const entry = soldByCourt.get(b.court_id) ?? { hours: 0, expected: 0 };
    entry.hours += (b.end_min - b.start_min) / 60;
    soldByCourt.set(b.court_id, entry);
  }

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

  // A court is in use whenever a booking covers any of its spaces: the union
  // of those bookings' times, day by day, so two courts under a pitch booked
  // at once count the pitch's hour once.
  const soldOn = new Map<string, { start: number; end: number }[]>();
  for (const b of sold) {
    for (const space of spacesOf.get(b.court_id) ?? []) {
      const key = `${space}:${b.date}`;
      soldOn.set(key, [...(soldOn.get(key) ?? []), { start: b.start_min, end: b.end_min }]);
    }
  }
  const inUseFor = (courtId: number): number => {
    const spaces = spacesOf.get(courtId);
    if (!spaces) return soldByCourt.get(courtId)?.hours ?? 0;
    let minutes = 0;
    for (const d of new Set(sold.map((b) => b.date)))
      minutes += unionMinutes(spaces.flatMap((space) => soldOn.get(`${space}:${d}`) ?? []));
    return minutes / 60;
  };

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
      inUseHours: inUseFor(court.id),
      expected: sold.expected,
    };
  });

  let floorSold = 0;
  let floorSellable = 0;
  for (const unit of units) {
    floorSellable += openHoursInPeriod * 60 - (unitMinutesOut.get(unit) ?? 0);
    for (const [key, spans] of soldOn) if (key.startsWith(`${unit}:`)) floorSold += unionMinutes(spans);
  }
  floorSold /= 60;
  floorSellable = Math.max(0, floorSellable / 60);

  // --- per sport -----------------------------------------------------------
  const bySport: SportLine[] = (
    await db
      .prepare(`
        SELECT b.sport AS sport, COUNT(*) AS bookings,
               SUM(b.end_min - b.start_min) / 60.0 AS booked_hours,
               SUM(b.total_price) AS expected,
               SUM(CASE WHEN b.payment_status = 'paid' THEN b.total_price ELSE 0 END) AS collected
        FROM bookings b
        JOIN courts c ON c.id = b.court_id
        WHERE b.court_id IN (SELECT id FROM courts WHERE venue_id = ?) AND b.date >= ? AND b.date <= ? AND b.status = 'confirmed'
        GROUP BY b.sport
        ORDER BY expected DESC
      `)
      .all(venueId, from, to) as {
      sport: Sport;
      bookings: number;
      booked_hours: number | string;
      expected: number;
      collected: number;
    }[]
  ).map(({ booked_hours, ...row }) => ({
    ...row,
    // What was booked for it, whichever court it was played on.
    hours: Math.round(Number(booked_hours) * 100) / 100,
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
  const monthHours: { month: string; hours: number }[] = [];
  for (const b of sold) {
    const month = b.date.slice(0, 7);
    const line = monthHours.find((m) => m.month === month);
    if (line) line.hours += (b.end_min - b.start_min) / 60;
    else monthHours.push({ month, hours: (b.end_min - b.start_min) / 60 });
  }

  const byMonth: MonthLine[] = monthsIn(from, to).map((month) => ({
    month,
    expected: monthRows.find((r) => r.month === month)?.expected ?? 0,
    collected: monthRows.find((r) => r.month === month)?.collected ?? 0,
    hours: monthHours.find((r) => r.month === month)?.hours ?? 0,
  }));

  // --- when the place is actually busy ------------------------------------
  // Each booking's minutes, into the hours of the day they fall in.
  const minutesByHour = new Map<number, number>();
  for (const b of sold)
    for (let h = Math.floor(b.start_min / 60); h * 60 < b.end_min; h++) {
      const minutes = Math.min(b.end_min, (h + 1) * 60) - Math.max(b.start_min, h * 60);
      minutesByHour.set(h, (minutesByHour.get(h) ?? 0) + minutes);
    }
  const byHour: HourLine[] = Array.from({ length: tradingHours }, (_, i) => {
    const hour = firstHour + i;
    return { hour, hours: (minutesByHour.get(hour) ?? 0) / 60 };
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
  const floorTakings = byCourt.filter((c) => exclusive.includes(c.courtId)).reduce((n, c) => n + Number(c.expected), 0);

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
    revenue: {
      expected,
      collected,
      outstanding: expected - collected,
      tax: taxCollected === null ? null : { name: (await venueTax(venueId)).name, amount: taxCollected },
    },
    collectedBy,
    counterSales: { sales: Number(counter.n), total: Math.round(Number(counter.total) * 100) / 100 },
    utilisation: {
      courts: { soldHours: floorSold, sellableHours: floorSellable, percent: floorSellable === 0 ? 0 : floorSold / floorSellable },
      shared: split(byCourt.filter((c) => !exclusive.includes(c.courtId))),
      revenuePerHour: floorSellable === 0 ? 0 : Math.round((floorTakings / floorSellable) * 100) / 100,
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
export async function walletLiability(): Promise<CreditPosition> {
  const perVenue = creditScope() === "venue";
  return creditPosition(perVenue ? "WHERE venue_id IS NULL" : "", []);
}

/**
 * Where stored credit stands, customer by customer, never netted across
 * customers (M14): what customers hold and may spend (`balance`, owed to
 * them), and apart from it what customers whose credit was taken back after
 * they spent it owe (`overdrawn.owing`, after a chargeback). The second is
 * not revenue and may never be paid: it is shown so it is not lost, not
 * counted as money coming.
 */
export interface CreditPosition {
  customers: number;
  balance: number;
  overdrawn: { customers: number; owing: number };
}

async function creditPosition(where: string, params: unknown[]): Promise<CreditPosition> {
  const row = (await getDb()
    .prepare(`
      SELECT COUNT(*) FILTER (WHERE balance > 0) AS customers, COALESCE(SUM(balance) FILTER (WHERE balance > 0), 0) AS balance,
             COUNT(*) FILTER (WHERE balance < 0) AS overdrawn, COALESCE(-SUM(balance) FILTER (WHERE balance < 0), 0) AS owing
        FROM (SELECT user_id, SUM(amount) AS balance FROM wallet_entries ${where} GROUP BY user_id) AS each_customer
    `)
    .get(...params)) as { customers: number; balance: number; overdrawn: number; owing: number };
  return { customers: row.customers, balance: row.balance, overdrawn: { customers: row.overdrawn, owing: row.owing } };
}

/**
 * Credit sold by this venue and not yet spent: what it owes, where credit is
 * per venue. For a branch, that is its whole business's: credit bought at one
 * branch is spent at any of them, so it is owed by the business, not by
 * whichever branch happened to sell it.
 */
export async function venueCreditLiability(venueId: number): Promise<CreditPosition> {
  return creditPosition(`WHERE ${SAME_CREDIT}`, [venueId]);
}
