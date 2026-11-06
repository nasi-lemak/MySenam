import { getDb } from "./db";
import { SAME_CREDIT } from "./branches";
import { creditScope } from "./mode";
import { Sport } from "./types";
import { addDays, todayISO } from "./time";
import { venueTax } from "./tax";
import { hoursOn, storedHours } from "./week-hours";
import { venueZoneOf } from "./zones";
import { bookingCredited, bookingGross, bookingSideNet } from "./accounting";

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
 * Test bookings, made before the venue went live (lib/test-bookings.ts), are
 * none of its trade and are left out of every figure.
 */

export interface RevenueLine {
  /** What confirmed bookings in the period came to, at the price booked. */
  expected: number;
  /**
   * The money the venue holds for bookings played in the period, as the sales journal has it
   * (`bookingMoney`, docs/features/reporting.md): each booking's receipt, the deposit and the friends' shares paid
   * on it, less the credit notes taken off them (a goodwill adjustment, a place taken off, a cheaper coach), and
   * with what the venue kept of bookings cancelled late (`lateKept`). A booking paid with a pass is not here: the
   * pass sale was the money.
   */
  collected: number;
  /** What confirmed bookings not paid in full still owe: their price less the deposit and shares already paid on them. */
  outstanding: number;
  /**
   * Given back after payment on confirmed bookings in the period (price adjustments, places taken off, a cheaper
   * coach): the credit notes the journal holds against their receipts. With the figures beside it,
   * `expected` = (`collected` less `lateKept`) + `outstanding` + `adjusted` + `passPaid.value`.
   */
  adjusted: number;
  /** Confirmed bookings in the period paid with a pass, and what they came to at their price: used up, not takings. */
  passPaid: { bookings: number; value: number };
  /**
   * Kept from paid bookings in the period cancelled late: each one's receipt
   * less the credit notes that gave the rest back, as the sales journal has
   * them (lib/accounting.ts `bookingGross`, `bookingCredited`). Inside
   * `collected`, `collectedBy`, `bySport` and `byMonth`, and its tax inside `tax`.
   */
  lateKept: number;
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
   * Test bookings from before the venue went live (lib/test-bookings.ts) that are still standing and were paid: left
   * out of every figure here, and shown on their own so money taken on one is never out of sight.
   */
  testTakings: { bookings: number; collected: number };
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
    courts: UseSplit;
    /** Places sold against places offered, on facilities that take several bookings at once. */
    shared: UseSplit;
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
    /**
     * What the venue holds for customers, in ringgit, as of today (not of the period). Every figure is provisional:
     * how each is treated in the venue's books is for its adviser (docs/features/reporting.md#what-the-venue-owes).
     */
    owed: VenueOwes;
  };
}

/** What a venue holds for customers, in ringgit. */
export interface VenueOwes {
  /**
   * Stored credit customers hold that this venue owes, where credit is per venue; null where it is the platform's
   * (bought at one counter, spendable at any: see `walletLiability`, shown to the platform owner).
   */
  storedCredit: number | null;
  /** Gift vouchers sold and not yet redeemed or expired. */
  giftVouchers: number;
  /** Vouchers past their date and neither redeemed nor cancelled: not in the figure above or the total, until the venue's adviser says how they are treated. */
  giftVouchersLapsed: number;
  /** Deposits and friends' shares paid on confirmed bookings not paid in full, still to be played. */
  bookingDeposits: number;
  /** Deposits held on kit hired out and not yet returned. */
  hireDeposits: number;
  /** Money owed back to customers: online refunds not yet made, and counter payments owed back and not yet handed back. */
  refunds: number;
  /**
   * Unspent entries of live passes at the price each was sold at (the price times the share left, as voiding a pass
   * with a refund works it out): an estimate of what the venue would give back, not an amount it owes. Not in the
   * total: passes are takings when sold (the sales journal).
   */
  passValue: number;
  /** The sum of stored credit (where the venue's), vouchers, booking and hire deposits and refunds. */
  total: number;
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

/** Hours (or place-hours) sold against those that could have been sold. */
export interface UseSplit {
  soldHours: number;
  sellableHours: number;
  percent: number;
}

/**
 * What utilisation is measured from, read once for a period (`readUse`) and
 * measured by `measureUse` for any of its days: the report measures its whole
 * period with it, the occupancy grid each day, so the two agree.
 */
export interface UseRecords {
  courts: { id: number; capacity: number }[];
  /** Each day the venue was open, by its own hours; a closed day is not here. */
  openOn: Map<string, { start: number; end: number }>;
  /** Which spaces each court covers, and whose own space each is. */
  cover: { court_id: number; space_id: number; owner: number }[];
  /** Confirmed bookings; on a shared facility each takes its players' places. */
  sold: { court_id: number; date: string; start_min: number; end_min: number; places: number }[];
  /** Blocks, once for each court covering the floor they take. */
  blocks: { court_id: number; date: string; start_min: number; end_min: number; places: number | null }[];
  /** Outages, once for each court covering the floor they take. */
  outages: { court_id: number; starts_on: string; ends_on: string | null }[];
}

export interface UseMeasure {
  /** Each court's place-hours sold, in use and sellable. */
  perCourt: Map<number, { soldHours: number; inUseHours: number; sellableHours: number }>;
  /** The courts' floor, measured once (B11). */
  courts: UseSplit;
  /** Places on shared facilities, apart. */
  shared: UseSplit;
  /** How many courts are a piece of floor of their own, and how many facilities are shared. */
  floorCourts: number;
  sharedCourts: number;
}

const splitOf = (sold: number, sellable: number): UseSplit => ({
  soldHours: sold,
  sellableHours: sellable,
  percent: sellable === 0 ? 0 : sold / sellable,
});

/**
 * Utilisation on the given days, as reporting.md defines it: pure, so the
 * report and the occupancy grid measure the same way.
 *
 * What could be sold is each open day's hours times capacity, less whatever
 * staff took out of service: blocks on a court's own space or on a court
 * sharing its floor, and outages, within the hours it was open.
 *
 * The floor is measured once (B11). A court whose own space is all it covers
 * is a piece of floor; a pitch's own space, only ever taken with its courts',
 * is not more floor. An hour of a piece of floor is in use when any booking
 * covers it, sold as the court or as the pitch over it. Shared facilities are
 * measured apart, in places, never blended with the floor.
 */
export function measureUse(records: UseRecords, dates: Iterable<string>): UseMeasure {
  const on = new Set(dates);
  const open = [...records.openOn].filter(([d]) => on.has(d));
  const openHours = open.reduce((n, [, w]) => n + (w.end - w.start) / 60, 0);
  const capacityOf = new Map(records.courts.map((c) => [c.id, c.capacity]));

  // --- what could have been sold ------------------------------------------
  const outOf = new Map<number, number>();
  for (const b of records.blocks) {
    const w = on.has(b.date) ? records.openOn.get(b.date) : undefined;
    const capacity = capacityOf.get(b.court_id);
    if (!w || capacity === undefined) continue;
    const minutes = Math.max(0, Math.min(b.end_min, w.end) - Math.max(b.start_min, w.start));
    outOf.set(b.court_id, (outOf.get(b.court_id) ?? 0) + (Math.min(b.places ?? capacity, capacity) * minutes) / 60);
  }
  for (const o of records.outages) {
    const capacity = capacityOf.get(o.court_id);
    if (capacity === undefined) continue;
    for (const [d, w] of open) {
      if (d < o.starts_on || (o.ends_on !== null && d > o.ends_on)) continue;
      outOf.set(o.court_id, (outOf.get(o.court_id) ?? 0) + (capacity * (w.end - w.start)) / 60);
    }
  }

  // --- the floor, measured once (B11) ----------------------------------------
  const spacesOf = new Map<number, number[]>();
  for (const r of records.cover) spacesOf.set(r.court_id, [...(spacesOf.get(r.court_id) ?? []), r.space_id]);
  const floor = new Set(
    records.cover.filter((r) => r.court_id === r.owner && spacesOf.get(r.owner)!.length === 1).map((r) => r.court_id)
  );
  // A court is in use whenever a booking covers any of its spaces: the union
  // of those bookings' times, day by day, so two courts under a pitch booked
  // at once count the pitch's hour once.
  const soldOn = new Map<string, { start: number; end: number }[]>();
  const soldBy = new Map<number, number>();
  const days = new Set<string>();
  for (const b of records.sold) {
    if (!on.has(b.date)) continue;
    days.add(b.date);
    soldBy.set(b.court_id, (soldBy.get(b.court_id) ?? 0) + (b.places * (b.end_min - b.start_min)) / 60);
    for (const space of spacesOf.get(b.court_id) ?? []) {
      const key = `${space}:${b.date}`;
      soldOn.set(key, [...(soldOn.get(key) ?? []), { start: b.start_min, end: b.end_min }]);
    }
  }

  const perCourt: UseMeasure["perCourt"] = new Map();
  for (const court of records.courts) {
    const spaces = spacesOf.get(court.id);
    let inUse = soldBy.get(court.id) ?? 0;
    if (spaces) {
      let minutes = 0;
      for (const d of days) minutes += unionMinutes(spaces.flatMap((space) => soldOn.get(`${space}:${d}`) ?? []));
      inUse = minutes / 60;
    }
    perCourt.set(court.id, {
      soldHours: soldBy.get(court.id) ?? 0,
      inUseHours: inUse,
      sellableHours: Math.max(0, openHours * court.capacity - (outOf.get(court.id) ?? 0)),
    });
  }

  const shared = records.courts.filter((c) => c.capacity > 1).map((c) => perCourt.get(c.id)!);
  const pieces = records.courts.filter((c) => floor.has(c.id)).map((c) => perCourt.get(c.id)!);
  return {
    perCourt,
    courts: splitOf(pieces.reduce((n, c) => n + c.inUseHours, 0), pieces.reduce((n, c) => n + c.sellableHours, 0)),
    shared: splitOf(shared.reduce((n, c) => n + c.soldHours, 0), shared.reduce((n, c) => n + c.sellableHours, 0)),
    floorCourts: pieces.length,
    sharedCourts: shared.length,
  };
}

type ReportVenueRow = {
  id: number;
  name: string;
  open_min: number;
  close_min: number;
  week_hours: string | null;
  hours_changes?: string | null;
  time_zone: string | null;
  lat: number | null;
  lng: number | null;
};

/** A venue, its courts and what its utilisation from `from` to `to` is measured from. */
async function readUse(
  venueId: number,
  from: string,
  to: string
): Promise<{
  venue: ReportVenueRow;
  courts: { id: number; name: string; sport: Sport; capacity: number }[];
  records: UseRecords;
  closedDays: number;
} | null> {
  const db = getDb();
  const venue = (await db.prepare("SELECT * FROM venues WHERE id = ?").get(venueId)) as ReportVenueRow | undefined;
  if (!venue) return null;

  const courts = await db
    .prepare("SELECT id, name, sport, capacity FROM courts WHERE venue_id = ? ORDER BY id")
    .all(venueId) as { id: number; name: string; sport: Sport; capacity: number }[];
  const capacityOf = new Map(courts.map((c) => [c.id, c.capacity]));

  const closures = new Set(
    ((await db
      .prepare("SELECT date FROM venue_closures WHERE venue_id = ? AND date >= ? AND date <= ?")
      .all(venueId, from, to)) as { date: string }[]).map((r) => r.date)
  );
  // Each day by its own hours: a weekday the venue never opens is a closed day too.
  // As set for each date, where hours change from one (ADR 0027).
  const usual = storedHours(venue, todayISO(venueZoneOf(venue)));
  let closedDays = 0;
  const openOn = new Map<string, { start: number; end: number }>();
  for (const d of daysOf(from, to)) {
    const on = hoursOn(usual, d);
    if (closures.has(d) || on.closed) {
      closedDays++;
      continue;
    }
    openOn.set(d, { start: on.openMin, end: on.closeMin });
  }

  // Every query here picks the venue's rows by their own court_id, as the
  // report's do (see venueReport).

  // Each confirmed booking is its places for its minutes: one on a court, its
  // players' on a shared facility; a class enrolment is one place in its class.
  const sold = ((await db
    .prepare(`
      SELECT b.court_id, b.date, b.start_min, b.end_min, b.players FROM bookings b
      WHERE b.court_id IN (SELECT id FROM courts WHERE venue_id = ?) AND NOT b.test AND b.date >= ? AND b.date <= ? AND b.status = 'confirmed'
    `)
    .all(venueId, from, to)) as { court_id: number; date: string; start_min: number; end_min: number; players: number | null }[]).map(
    ({ players, ...b }) => ({ ...b, places: (capacityOf.get(b.court_id) ?? 1) > 1 ? Math.max(1, Number(players ?? 1)) : 1 })
  );

  // Over a past period these may have been archived (lib/claims-archive.ts): read live and archived together.
  const blocks = (await db
    .prepare(`
      SELECT DISTINCT COALESCE(cs.court_id, c.court_id) AS court_id, k.id, k.date, k.start_min, k.end_min, k.places
        FROM blocks k JOIN claims_all c ON c.block_id = k.id
        LEFT JOIN court_spaces cs ON cs.space_id = c.space_id
       WHERE k.venue_id = ? AND k.date >= ? AND k.date <= ?
    `)
    .all(venueId, from, to)) as UseRecords["blocks"];
  const outages = (await db
    .prepare(`
      SELECT DISTINCT COALESCE(cs.court_id, c.court_id) AS court_id, o.id, o.starts_on, o.ends_on
        FROM court_outages o JOIN claims_all c ON c.outage_id = o.id
        LEFT JOIN court_spaces cs ON cs.space_id = c.space_id
       WHERE c.venue_id = ? AND o.starts_on <= ? AND (o.ends_on IS NULL OR o.ends_on >= ?)
    `)
    .all(venueId, to, from)) as UseRecords["outages"];
  const cover = (await db
    .prepare(`
      SELECT cs.court_id, cs.space_id, s.court_id AS owner
        FROM court_spaces cs JOIN spaces s ON s.id = cs.space_id
       WHERE s.venue_id = ?
    `)
    .all(venueId)) as UseRecords["cover"];

  return { venue, courts, records: { courts, openOn, cover, sold, blocks, outages }, closedDays };
}

/** Each date from `from` to `to`. */
function daysOf(from: string, to: string): string[] {
  const days: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) days.push(d);
  return days;
}

/**
 * Each day's utilisation, measured as `venueReport` measures a period (the
 * occupancy grid's venue totals): the courts' floor once, and shared
 * facilities' places apart; null where the venue has none of that kind.
 */
export async function utilisationByDay(
  venueId: number,
  from: string,
  to: string
): Promise<Map<string, { courts: UseSplit | null; shared: UseSplit | null }>> {
  const days = new Map<string, { courts: UseSplit | null; shared: UseSplit | null }>();
  const read = await readUse(venueId, from, to);
  if (!read) return days;
  for (const d of daysOf(from, to)) {
    const use = measureUse(read.records, [d]);
    days.set(d, { courts: use.floorCourts > 0 ? use.courts : null, shared: use.sharedCourts > 0 ? use.shared : null });
  }
  return days;
}

/**
 * The money in the period report's booking figures, defined once (ADR 0055; docs/features/reporting.md).
 *
 * For every booking played in the period that is not a test, confirmed or cancelled late, the money the sales
 * journal holds for it, read from the same receipts and credit notes (lib/accounting.ts):
 *
 * - its own receipt, `bookingGross` (the price less what friends paid on their own receipts), when it is paid and
 *   not paid with a pass;
 * - plus, on the receipts of their own, the deposit paid online and the friends' shares (a confirmed booking's
 *   `shares_paid`; a cancelled one's, `bookingSideNet`);
 * - less the credit notes taken off its own receipt, `bookingCredited`: a late cancellation's refund, a manager's
 *   goodwill adjustment, a place taken off, a cheaper coach.
 *
 * A booking paid with a pass is not here at all, as in the journal: the pass sale was the money. What is not yet
 * paid is `outstanding`: the price less the deposit and shares already paid, for confirmed bookings not paid in full.
 * The report counts a booking on the date it was played and the journal on the date it was paid, so over a period
 * holding both dates of every booking the two agree (tests/report-reconciliation.test.ts).
 */
export async function bookingMoney(venueId: number, from: string, to: string) {
  const rows = (await getDb()
    .prepare(`
      SELECT b.status, (b.payment_status = 'paid') AS paid, COALESCE(b.paid_via, 'unrecorded') AS via,
             (COALESCE(b.paid_via, '') = 'pass') AS pass, substr(b.date, 1, 7) AS month, b.sport,
             b.total_price::float AS total, GREATEST(0, b.total_price - b.shares_paid)::float AS owing,
             (CASE WHEN b.payment_status = 'paid' AND COALESCE(b.paid_via, '') <> 'pass' THEN GREATEST(0, ${bookingGross("b")}) ELSE 0 END)::float AS own,
             (CASE WHEN COALESCE(b.paid_via, '') = 'pass' THEN 0 ELSE ${bookingCredited("b", "total")} END)::float AS credited,
             (CASE WHEN COALESCE(b.paid_via, '') = 'pass' THEN 0
                   WHEN b.status = 'confirmed' THEN b.shares_paid
                   ELSE ${bookingSideNet("b")} END)::float AS side,
             (b.tax_rate IS NOT NULL) AS taxed,
             (CASE WHEN b.tax_rate IS NULL THEN 0
                   ELSE ROUND(GREATEST(0, ${bookingGross("b")}) * b.tax_rate / (100 + b.tax_rate), 2) END)::float AS own_tax,
             (CASE WHEN b.tax_rate IS NULL OR COALESCE(b.paid_via, '') = 'pass' THEN 0 ELSE ${bookingCredited("b", "tax_amount")} END)::float AS credited_tax
        FROM bookings b
       WHERE b.court_id IN (SELECT id FROM courts WHERE venue_id = ?) AND NOT b.test AND b.date >= ? AND b.date <= ?
         AND (b.status = 'confirmed' OR (b.status = 'cancelled' AND b.late_cancelled = 1))
    `)
    .all(venueId, from, to)) as {
    status: string;
    paid: boolean;
    via: string;
    pass: boolean;
    month: string;
    sport: Sport;
    total: number;
    owing: number;
    own: number;
    credited: number;
    side: number;
    taxed: boolean;
    own_tax: number;
    credited_tax: number;
  }[];

  const round = (n: number) => Math.round(n * 100) / 100;
  const lines = new Map<string, { amount: number; bookings: number }>();
  const bySport = new Map<Sport, number>();
  const byMonth = new Map<string, number>();
  let seen = new Set<string>();
  const line = (via: string, amount: number) => {
    const l = lines.get(via) ?? { amount: 0, bookings: 0 };
    l.amount += amount;
    // A booking is counted once under each way it was paid, however many receipts that came on.
    if (!seen.has(via)) l.bookings += 1;
    seen.add(via);
    lines.set(via, l);
  };
  let confirmedCollected = 0;
  let lateKept = 0;
  let outstanding = 0;
  let adjusted = 0;
  let tax = 0;
  let taxRows = 0;
  const passPaid = { bookings: 0, value: 0 };
  for (const r of rows) {
    seen = new Set();
    const confirmed = r.status === "confirmed";
    if (r.pass) {
      if (confirmed) {
        passPaid.bookings += 1;
        passPaid.value += r.total;
      }
      continue;
    }
    const ownNet = r.own - r.credited;
    let taken = 0;
    if (confirmed) {
      if (r.paid) {
        line(r.via, ownNet);
        taken += ownNet;
        adjusted += r.credited;
      } else outstanding += r.owing;
      if (r.side > 0.004) {
        line("online", r.side);
        taken += r.side;
      }
      confirmedCollected += taken;
      if (r.taxed && r.paid) {
        tax += r.own_tax - r.credited_tax;
        taxRows += 1;
      }
    } else {
      // Kept of a booking cancelled late: the receipt less the credit notes that gave the rest back.
      if (ownNet > 0.004) {
        line(r.via, ownNet);
        taken += ownNet;
        if (r.taxed) {
          tax += r.own_tax - r.credited_tax;
          taxRows += 1;
        }
      }
      if (r.side > 0.004) {
        line("online", r.side);
        taken += r.side;
      }
      lateKept += taken;
    }
    if (taken !== 0) {
      bySport.set(r.sport, (bySport.get(r.sport) ?? 0) + taken);
      byMonth.set(r.month, (byMonth.get(r.month) ?? 0) + taken);
    }
  }
  return {
    collected: round(confirmedCollected + lateKept),
    lateKept: round(lateKept),
    outstanding: round(outstanding),
    adjusted: round(adjusted),
    passPaid: { bookings: passPaid.bookings, value: round(passPaid.value) },
    tax,
    taxRows,
    collectedBy: [...lines.entries()]
      .map(([via, l]) => ({ via, amount: round(l.amount), bookings: l.bookings }))
      .sort((a, b) => b.amount - a.amount),
    bySport,
    byMonth,
  };
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
  const read = await readUse(venueId, from, to);
  if (!read) return null;
  const { venue, courts, records, closedDays } = read;
  const zone = venueZoneOf(venue);

  const days = Math.max(
    1,
    Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1
  );
  let firstMin = venue.open_min;
  let lastMin = venue.close_min;
  for (const open of records.openOn.values()) {
    firstMin = Math.min(firstMin, open.start);
    lastMin = Math.max(lastMin, open.end);
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
        SUM(CASE WHEN b.status = 'confirmed' THEN b.total_price ELSE 0 END) AS expected
      FROM bookings b
      JOIN courts c ON c.id = b.court_id
      WHERE b.court_id IN (SELECT id FROM courts WHERE venue_id = ?) AND NOT b.test AND b.date >= ? AND b.date <= ?
    `)
    .get(venueId, from, to) as {
    confirmed: number | null;
    cancelled: number | null;
    noShows: number | null;
    expected: number | null;
  };

  const expected = counts.expected ?? 0;

  // The money in the booking figures, defined once (docs/features/reporting.md, ADR 0055): what the sales journal holds
  // for each booking played in the period, from the same receipts and credit notes. See `bookingMoney`.
  const money = await bookingMoney(venueId, from, to);
  const { lateKept, collected, outstanding, collectedBy } = money;

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
    .get(venueId, zone, from, to)) as { n: number | string; tax: number | string };
  const taxCollected =
    money.taxRows === 0 && Number(documents.n) === 0
      ? null
      : Math.round((money.tax + Number(documents.tax)) * 100) / 100;

  const saleZone = zone;
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

  // Left out of everything above (a try-out is not the venue's trade), but what was paid on one is still said.
  const testPaid = (await db
    .prepare(`
      SELECT COUNT(*)::int AS n, COALESCE(SUM(b.total_price), 0)::float AS total
        FROM bookings b
       WHERE b.court_id IN (SELECT id FROM courts WHERE venue_id = ?) AND b.test AND b.date >= ? AND b.date <= ?
         AND b.status = 'confirmed' AND b.payment_status = 'paid'
    `)
    .get(venueId, from, to)) as { n: number; total: number };

  // --- place-hours sold ----------------------------------------------------
  const sold = records.sold;
  const soldHours = sold.reduce((sum, b) => sum + (b.end_min - b.start_min) * b.places, 0) / 60;

  const tradingHours = Math.max(0, lastHour - firstHour);

  // --- per court -----------------------------------------------------------
  // Place-hours sold, in use and sellable (measureUse); takings by the query below.
  const use = measureUse(records, daysOf(from, to));
  const expectedOf = new Map<number, number>();
  for (const row of await db
    .prepare(`
      SELECT b.court_id AS "courtId", SUM(b.total_price) AS expected
      FROM bookings b
      JOIN courts c ON c.id = b.court_id
      WHERE b.court_id IN (SELECT id FROM courts WHERE venue_id = ?) AND NOT b.test AND b.date >= ? AND b.date <= ? AND b.status = 'confirmed'
      GROUP BY b.court_id
    `)
    .all(venueId, from, to) as { courtId: number; expected: number }[])
    expectedOf.set(row.courtId, row.expected);

  const byCourt: CourtLine[] = courts.map((court) => {
    const line = use.perCourt.get(court.id)!;
    return {
      courtId: court.id,
      courtName: court.name,
      sport: court.sport,
      hours: line.soldHours,
      sellableHours: line.sellableHours,
      utilisation: line.sellableHours === 0 ? 0 : line.soldHours / line.sellableHours,
      inUseHours: line.inUseHours,
      expected: expectedOf.get(court.id) ?? 0,
    };
  });

  // --- per sport -----------------------------------------------------------
  const bySport: SportLine[] = (
    await db
      .prepare(`
        SELECT b.sport AS sport, COUNT(*) AS bookings,
               SUM((b.end_min - b.start_min) * CASE WHEN c.capacity > 1 THEN GREATEST(1, COALESCE(b.players, 1)) ELSE 1 END) / 60.0 AS booked_hours,
               SUM(b.total_price) AS expected
        FROM bookings b
        JOIN courts c ON c.id = b.court_id
        WHERE b.court_id IN (SELECT id FROM courts WHERE venue_id = ?) AND NOT b.test AND b.date >= ? AND b.date <= ? AND b.status = 'confirmed'
        GROUP BY b.sport
        ORDER BY expected DESC
      `)
      .all(venueId, from, to) as {
      sport: Sport;
      bookings: number;
      booked_hours: number | string;
      expected: number;
    }[]
  ).map(({ booked_hours, ...row }) => ({
    ...row,
    // What the journal holds of its bookings (`bookingMoney`), with what was kept of those cancelled late.
    collected: Math.round((money.bySport.get(row.sport) ?? 0) * 100) / 100,
    // What was booked for it, whichever court it was played on.
    hours: Math.round(Number(booked_hours) * 100) / 100,
  }));

  // --- per month, for the trend -------------------------------------------
  const monthRows = await db
    .prepare(`
      SELECT substr(b.date, 1, 7) AS month,
             SUM(b.total_price) AS expected
      FROM bookings b
      JOIN courts c ON c.id = b.court_id
      WHERE b.court_id IN (SELECT id FROM courts WHERE venue_id = ?) AND NOT b.test AND b.date >= ? AND b.date <= ? AND b.status = 'confirmed'
      GROUP BY month
    `)
    .all(venueId, from, to) as { month: string; expected: number }[];
  const monthHours: { month: string; hours: number }[] = [];
  for (const b of sold) {
    const month = b.date.slice(0, 7);
    const line = monthHours.find((m) => m.month === month);
    if (line) line.hours += ((b.end_min - b.start_min) * b.places) / 60;
    else monthHours.push({ month, hours: ((b.end_min - b.start_min) * b.places) / 60 });
  }

  const byMonth: MonthLine[] = monthsIn(from, to).map((month) => ({
    month,
    expected: monthRows.find((r) => r.month === month)?.expected ?? 0,
    collected: Math.round((money.byMonth.get(month) ?? 0) * 100) / 100,
    hours: monthHours.find((r) => r.month === month)?.hours ?? 0,
  }));

  // --- when the place is actually busy ------------------------------------
  // Each booking's place-minutes, into the hours of the day they fall in.
  const minutesByHour = new Map<number, number>();
  for (const b of sold)
    for (let h = Math.floor(b.start_min / 60); h * 60 < b.end_min; h++) {
      const minutes = Math.min(b.end_min, (h + 1) * 60) - Math.max(b.start_min, h * 60);
      minutesByHour.set(h, (minutesByHour.get(h) ?? 0) + minutes * b.places);
    }
  const byHour: HourLine[] = Array.from({ length: tradingHours }, (_, i) => {
    const hour = firstHour + i;
    return { hour, hours: (minutesByHour.get(hour) ?? 0) / 60 };
  });

  // --- what the venue still owes people -----------------------------------
  const today = todayISO();
  const { passEntriesUnspent, passesLive, passesValue } = await db
    .prepare(`
      SELECT
        COALESCE(SUM(p.entries + COALESCE((SELECT SUM(e.delta) FROM pass_entries e WHERE e.pass_id = p.id), 0)), 0) AS "passEntriesUnspent",
        COUNT(*) AS "passesLive",
        COALESCE(SUM(CASE WHEN p.entries > 0
                          THEN p.price * GREATEST(0, LEAST(p.entries, p.entries + COALESCE((SELECT SUM(e.delta) FROM pass_entries e WHERE e.pass_id = p.id), 0))) / p.entries
                          ELSE 0 END), 0)::float AS "passesValue"
      FROM passes p
      WHERE p.venue_id = ? AND p.status = 'active' AND p.expires_on >= ?
    `)
    .get(venueId, today) as { passEntriesUnspent: number; passesLive: number; passesValue: number };

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

  const owed = await venueOwes(venueId, today, passesValue);

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
      outstanding,
      adjusted: money.adjusted,
      passPaid: money.passPaid,
      lateKept,
      tax: taxCollected === null ? null : { name: (await venueTax(venueId)).name, amount: taxCollected },
    },
    collectedBy,
    counterSales: { sales: Number(counter.n), total: Math.round(Number(counter.total) * 100) / 100 },
    testTakings: { bookings: Number(testPaid.n), collected: Math.round(Number(testPaid.total) * 100) / 100 },
    utilisation: {
      courts: use.courts,
      shared: use.shared,
      revenuePerHour: use.courts.sellableHours === 0 ? 0 : Math.round((floorTakings / use.courts.sellableHours) * 100) / 100,
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
      owed,
    },
  };
}

/**
 * What the venue holds for customers, in ringgit (`VenueOwes`): one place for the figures, each read from where the
 * money is kept. Provisional: the venue's adviser decides how each is treated in its books.
 */
async function venueOwes(venueId: number, today: string, passValue: number): Promise<VenueOwes> {
  const db = getDb();
  const one = async (sql: string, ...params: unknown[]) => Number(((await db.prepare(sql).get(...params)) as { n: number | string | null }).n ?? 0);
  const round = (n: number) => Math.round(n * 100) / 100;
  const storedCredit = creditScope() === "venue" ? (await venueCreditLiability(venueId)).balance : null;
  const giftVouchers = await one("SELECT COALESCE(SUM(amount), 0)::float AS n FROM gift_vouchers WHERE venue_id = ? AND status = 'active' AND expires_on >= ?", venueId, today);
  const giftVouchersLapsed = await one("SELECT COALESCE(SUM(amount), 0)::float AS n FROM gift_vouchers WHERE venue_id = ? AND status = 'active' AND expires_on < ?", venueId, today);
  const bookingDeposits = await one(
    `SELECT COALESCE(SUM(b.shares_paid), 0)::float AS n FROM bookings b
      WHERE b.court_id IN (SELECT id FROM courts WHERE venue_id = ?) AND NOT b.test AND b.status = 'confirmed' AND b.payment_status = 'unpaid'
        AND b.date >= ? AND b.shares_paid > 0`,
    venueId,
    today
  );
  const hireDeposits = await one(
    `SELECT COALESCE(SUM(h.deposit), 0)::float AS n FROM hire_records h JOIN bookings b ON b.id = h.booking_id
      WHERE h.returned_at IS NULL AND b.court_id IN (SELECT id FROM courts WHERE venue_id = ?)`,
    venueId
  );
  const online = await one(
    "SELECT COALESCE(SUM(p.refund_due - p.refunded), 0)::float AS n FROM online_payments p WHERE p.venue_id = ? AND p.purpose NOT IN ('invoice', 'pack') AND p.refund_due > p.refunded",
    venueId
  );
  const counter = await one("SELECT COALESCE(SUM(amount), 0)::float AS n FROM counter_refunds_owed WHERE venue_id = ? AND settled_at IS NULL", venueId);
  const refunds = round(online + counter);
  return {
    storedCredit: storedCredit === null ? null : round(storedCredit),
    giftVouchers: round(giftVouchers),
    giftVouchersLapsed: round(giftVouchersLapsed),
    bookingDeposits: round(bookingDeposits),
    hireDeposits: round(hireDeposits),
    refunds,
    passValue: round(passValue),
    total: round((storedCredit ?? 0) + giftVouchers + bookingDeposits + hireDeposits + refunds),
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
