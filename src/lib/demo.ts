import { getDb } from "./db";
import {
  blockSlots,
  closeVenueDay,
  computePrice,
  createBooking,
  createClassSessions,
  createPromoCode,
  enrolInClass,
  getCourt,
  issuePass,
  listVenues,
  recordInduction,
  sellMembership,
  setPaymentStatus,
  topUpWallet,
} from "./store";
import { registerUser } from "./auth";
import { Court } from "./types";
import { addDays, todayISO } from "./time";
import { peakRules } from "./peak";
import { money, region } from "./region";

/**
 * A fortnight of plausible trading, for showing somebody what this does.
 *
 * A fresh install has venues and courts and nothing else, so every screen —
 * the day list, occupancy, the reports tab, the roster — opens empty. Anybody
 * evaluating MySenam has to spend twenty minutes inventing data before they
 * can see the thing work. This makes that one click.
 *
 * Two rules it follows:
 *
 * **It refuses to run over real trading.** The guard is "this venue has taken
 * a booking", which a live venue always fails, so fake customers cannot appear
 * in a real day list.
 *
 * **It is deterministic.** The same install always produces the same
 * fortnight, so a screenshot taken today matches the one in the guide, and a
 * bug somebody reports is a bug you can reproduce.
 */

/** Same seed, same demo, every time. */
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const NAMES = [
  "Aiman Hakim", "Nur Aisyah", "Ravi Kumaran", "Chong Wei Ming", "Siti Nurhaliza",
  "Tan Mei Ling", "Muhammad Firdaus", "Priya Devi", "Lim Jia Hui", "Arif Danial",
  "Farah Nabila", "Ganesh Rajan", "Wong Kar Wai", "Nurul Izzati", "Hafiz Rahman",
  "Yap Su Lin", "Amirul Asyraf", "Kavitha Menon", "Ong Chee Keong", "Zulaikha Aziz",
];

/**
 * A mobile number in the shape the install's country really writes one:
 * 01x-xxx xxxx in Malaysia, eight digits starting 8 or 9 in Singapore.
 */
function phoneFor(index: number): string {
  if (region().country === "SG") return `${index % 2 ? "8" : "9"}${String(3000000 + index * 137911).slice(0, 7)}`;
  const prefixes = ["012", "013", "016", "017", "019"];
  return `${prefixes[index % prefixes.length]}${String(3000000 + index * 137911).slice(0, 7)}`;
}

/**
 * How likely an hour is to sell. Evenings after work and weekend mornings are
 * what a real centre actually looks like; Tuesday at 10 AM is not.
 */
function demand(date: string, hour: number, venueFactor: number, rng: () => number): boolean {
  const weekend = [0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay());
  let chance = 0.02;
  if (hour >= 18 && hour <= 22) chance = weekend ? 0.34 : 0.26;
  else if (hour >= 9 && hour <= 12) chance = weekend ? 0.2 : 0.05;
  else if (hour >= 13 && hour <= 17) chance = weekend ? 0.12 : 0.05;
  return rng() < chance * venueFactor;
}

/**
 * Not every venue is the flagship. One busy centre and three quieter ones
 * reads like a real chain; four identically packed ones reads like a fixture.
 */
const VENUE_BUSYNESS = [1, 0.55, 0.45, 0.5];

/**
 * How far back the demo trades, and how far forward it is booked.
 *
 * A month of history rather than a week, because the reports tab defaults to
 * the last 30 days and a window that is two-thirds empty averages a good venue
 * down to nothing.
 */
const HISTORY_DAYS = 30;
const FUTURE_DAYS = 10;

/**
 * How many places of a shared resource go in one hour.
 *
 * A court is one booking; a gym floor at 8 PM is twenty people, not one.
 * Selling a single place on a forty-person floor would make the venue's
 * utilisation read as a rounding error, which is exactly what it did before
 * this existed.
 */
function placesTaken(capacity: number, hour: number, rng: () => number): number {
  if (capacity === 1) return 1;
  const fill = hour >= 18 && hour <= 21 ? 0.45 + rng() * 0.35 : 0.12 + rng() * 0.28;
  return Math.max(1, Math.round(capacity * fill));
}

export interface DemoResult {
  ok: true;
  bookings: number;
  cancelled: number;
  noShows: number;
  customers: number;
  classes: number;
  extras: string[];
}

export type SeedResult = DemoResult | { ok: false; error: string };

/** True once anything has been sold here — the signal that this is real. */
export async function hasTradingHistory(): Promise<boolean> {
  const row = await getDb().prepare("SELECT COUNT(*) AS n FROM bookings").get() as { n: number };
  return row.n > 0;
}

/** True once a booking nobody invented exists. After this the demo is over. */
export async function hasRealBookings(): Promise<boolean> {
  const row = await getDb()
    .prepare("SELECT COUNT(*) AS n FROM bookings WHERE demo = 0")
    .get() as { n: number };
  return row.n > 0;
}

export interface DemoState {
  /** Whether demo data is sitting in this install right now. */
  seeded: boolean;
  /** Whether this install has never been sold anything for real. */
  empty: boolean;
  /** The day the demo was last written, and the last day it has bookings for. */
  seededOn: string | null;
  runsTo: string | null;
  /** True once the demo's forward window has run out. */
  stale: boolean;
  /** Whether reloading it is still allowed. */
  refreshable: boolean;
}

async function setting(key: string): Promise<string | null> {
  const row = await getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

/**
 * Where the demo stands.
 *
 * The demo is written against the day it was loaded, so ten days later its
 * forward window has run out and the day list — the first screen anybody opens
 * — is empty again. That is what `stale` is for. Reloading it is offered only
 * while every booking in the install is still one the seeder invented: the
 * first real customer ends the demo permanently, because a reload clears the
 * trading tables and there would be no way to tell what was safe to drop.
 */
export async function demoState(): Promise<DemoState> {
  const seededOn = await setting("demo_seeded_on");
  const runsTo = await setting("demo_runs_to");
  const real = await hasRealBookings();
  const seeded = seededOn !== null && await hasTradingHistory();
  return {
    seeded,
    empty: !await hasTradingHistory(),
    seededOn,
    runsTo,
    stale: seeded && runsTo !== null && todayISO() > runsTo,
    refreshable: seeded && !real,
  };
}

/**
 * Move the demo onto today.
 *
 * Clears everything transactional and writes the demo again, so the day list
 * opens on a day that has something in it. Venues, courts and staff accounts
 * are what the operator set up rather than what the seeder invented, so they
 * are left exactly as they are.
 */
export async function refreshDemoData(opts: { adminId: number }): Promise<SeedResult> {
  if (await hasRealBookings())
    return {
      ok: false,
      error:
        "This install has taken a real booking, so the demo can no longer be reloaded — clearing it would take that booking with it.",
    };
  if (!await hasTradingHistory())
    return { ok: false, error: "There is no demo here to reload." };

  const db = getDb();
  await db.transaction(async () => {
    // Children before parents: foreign keys are on, and not every one of these
    // cascades. Venues, courts, admins and settings are deliberately absent.
    for (const table of [
      "access_reveals",
      "hire_records",
      "check_ins",
      "booking_slots",
      "waitlist",
      "promo_uses",
      "pass_entries",
      "receipts",
      "wallet_entries",
      "sessions",
      "bookings",
      "classes",
      "slot_blocks",
      "inductions",
      "memberships",
      "passes",
      "promo_codes",
      "venue_closures",
      "venue_holidays",
      "users",
    ])
      await db.prepare(`DELETE FROM ${table}`).run();
  })();

  return await seedDemoData({ force: true, adminId: opts.adminId });
}

/**
 * Write a demo fortnight: ten days behind, ten ahead.
 *
 * History has to be inserted directly, because the booking path quite rightly
 * refuses to sell an hour that has already passed. Everything from today
 * onwards goes through `createBooking`, so the demo exercises the real pricing
 * and seat allocation rather than inventing rows that could not exist.
 */
export async function seedDemoData(opts: { force?: boolean; adminId: number }): Promise<SeedResult> {
  if (!opts.force && await hasTradingHistory())
    return {
      ok: false,
      error:
        "This install has already taken bookings. Demo data is only for an empty one — it would put invented customers in a real day list.",
    };

  const db = getDb();
  const rng = mulberry32(20260101);
  const today = todayISO();
  const venues = await listVenues();
  if (venues.length === 0) return { ok: false, error: "There are no venues to fill." };

  let bookings = 0;
  let cancelled = 0;
  let noShows = 0;
  const extras: string[] = [];

  /** Each venue's peak hours, looked up once rather than for every booking invented. */
  const rulesOf = new Map<number, Awaited<ReturnType<typeof peakRules>>>();

  /** Insert a booking that has already happened, slots and all. */
  const insertPast = async (
    court: Court,
    date: string,
    hour: number,
    who: number,
    opts2: { paid: boolean; cancelled: boolean; noShow: boolean; checkedIn: boolean }
  ) => {
    if (!rulesOf.has(court.venueId)) rulesOf.set(court.venueId, await peakRules(court.venueId));
    const price = computePrice(court, date, [hour], false, rulesOf.get(court.venueId));
    const code = `MS-${Math.floor(rng() * 1e9).toString(36).toUpperCase().padStart(6, "0").slice(0, 6)}`;
    const status = opts2.cancelled ? "cancelled" : "confirmed";
    const info = await db
      .prepare(
        `INSERT INTO bookings (code, court_id, date, start_hour, end_hour, name, phone, total_price,
                               status, payment_status, paid_at, no_show, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        code,
        court.id,
        date,
        hour,
        hour + 1,
        NAMES[who % NAMES.length],
        phoneFor(who),
        price,
        status,
        opts2.paid ? "paid" : "unpaid",
        opts2.paid ? `${date} ${String(hour).padStart(2, "0")}:05:00` : null,
        opts2.noShow ? 1 : 0,
        `${addDays(date, -3)} 09:00:00`
      );
    const bookingId = info.lastInsertRowid as number;

    if (!opts2.cancelled) {
      // The UNIQUE constraint still decides: if this hour is taken, so be it.
      // The lowest free place, in one statement rather than one try per place.
      const slot = await db.prepare(
        `INSERT INTO booking_slots (booking_id, court_id, date, hour, seat)
         SELECT ?, ?, ?, ?, seat FROM generate_series(0, ? - 1) AS seat
          WHERE NOT EXISTS (
            SELECT 1 FROM booking_slots t WHERE t.court_id = ? AND t.date = ? AND t.hour = ? AND t.seat = seat.seat
          )
          ORDER BY seat LIMIT 1
         ON CONFLICT DO NOTHING`
      ).run(bookingId, court.id, date, hour, court.capacity, court.id, date, hour);
      if (slot.changes !== 1) {
        await db.prepare("DELETE FROM bookings WHERE id = ?").run(bookingId);
        return null;
      }
      if (opts2.checkedIn && !opts2.noShow)
        await db.prepare("INSERT INTO check_ins (booking_id, checked_in_at, checked_out_at) VALUES (?, ?, ?)").run(
          bookingId,
          `${date} ${String(hour).padStart(2, "0")}:02:00`,
          `${date} ${String(hour + 1).padStart(2, "0")}:05:00`
        );
    }
    return bookingId;
  };

  let who = 0;
  const arena = venues[0];
  const shared = arena.courts.find((c) => c.capacity > 1) ?? arena.courts[0];
  const racquet = arena.courts.find((c) => c.sport === "badminton") ?? arena.courts[0];

  // A coached term, with a few people on it.
  const term = await createClassSessions({
    courtId: shared.id,
    name: "Beginner badminton drills",
    instructor: "Coach Rahim",
    date: addDays(today, 2),
    startHour: 20,
    endHour: 21,
    capacity: Math.min(8, shared.capacity),
    price: 25,
    weeks: 4,
  });
  let classes = 0;
  if (term.ok) {
    classes = term.classes.length;
    for (let i = 0; i < 4; i++) {
      const person = who++;
      await enrolInClass({
        classId: term.classes[0].id,
        name: NAMES[person % NAMES.length],
        phone: phoneFor(person),
      });
    }
    extras.push(`${classes} class sessions with a roster`);
  }

  await db.transaction(async () => {
    for (const [index, venue] of venues.entries()) {
      const factor = VENUE_BUSYNESS[index % VENUE_BUSYNESS.length];
      for (const court of venue.courts) {
        // A kayak fleet is hired now and then, not block-booked all week.
        const busy = court.sport === "kayak" ? 0.3 : 1;
        for (let offset = -HISTORY_DAYS; offset <= -1; offset++) {
          const date = addDays(today, offset);
          for (let hour = venue.openHour; hour < venue.closeHour; hour++) {
            if (!demand(date, hour, factor, rng) || rng() > busy) continue;
            for (let place = 0; place < placesTaken(court.capacity, hour, rng); place++) {
              const roll = rng();
              const made = await insertPast(court, date, hour, who++, {
                paid: roll > 0.22,
                cancelled: roll < 0.08,
                noShow: roll > 0.965,
                checkedIn: roll > 0.3,
              });
              if (made === null) continue;
              bookings++;
              if (roll < 0.08) cancelled++;
              if (roll > 0.965) noShows++;
            }
          }
        }
      }
    }
  })();

  // From today on, through the front door, so the demo's future is data the
  // application itself agreed to sell.
  for (const [index, venue] of venues.entries()) {
    const factor = VENUE_BUSYNESS[index % VENUE_BUSYNESS.length];
    for (const court of venue.courts) {
      const busy = court.sport === "kayak" ? 0.3 : 1;
      for (let offset = 0; offset <= FUTURE_DAYS; offset++) {
        const date = addDays(today, offset);
        for (let hour = venue.openHour; hour < venue.closeHour; hour++) {
          if (!demand(date, hour, factor, rng) || rng() > busy) continue;
          for (let place = 0; place < placesTaken(court.capacity, hour, rng); place++) {
            const person = who++;
            const made = await createBooking({
              courtId: court.id,
              date,
              hours: [hour],
              name: NAMES[person % NAMES.length],
              phone: phoneFor(person),
            });
            if (!made.ok) break;
            bookings++;
            // Most people pay at the counter when they arrive, so tomorrow's
            // list is mostly unpaid and today's mostly is not.
            if (rng() < (offset === 0 ? 0.6 : 0.25)) await setPaymentStatus(made.booking.code, true);
          }
        }
      }
    }
  }
  // Two people with accounts, one holding credit.
  let customers = 0;
  const account = await registerUser({
    name: "Aiman Hakim",
    email: "aiman@example.com",
    phone: phoneFor(0),
    password: "demo-password",
  });
  if (account.ok) {
    customers++;
    await topUpWallet({ userId: account.user.id, amount: 80, adminId: opts.adminId, reason: "Counter top-up" });
    extras.push(`a customer holding ${money(80)} of credit`);
  }

  const pass = await issuePass({
    venueId: arena.id,
    name: "10 hours badminton",
    sport: "badminton",
    entries: 10,
    price: 150,
    holderName: NAMES[3],
    holderPhone: phoneFor(3),
    expiresOn: addDays(today, 120),
    adminId: opts.adminId,
  });
  if (pass.ok) extras.push("a 10-hour pass, part used");

  const membership = await sellMembership({
    venueId: arena.id,
    holderName: NAMES[5],
    holderPhone: phoneFor(5),
    startsOn: addDays(today, -40),
    expiresOn: addDays(today, 20),
    price: 240,
    adminId: opts.adminId,
  });
  if (membership.ok) extras.push("a membership lapsing within the month");

  const promo = await createPromoCode({
    venueId: arena.id,
    code: "RAYA20",
    description: "20% off, weekdays before 6",
    kind: "percent",
    value: 20,
    validFrom: addDays(today, -14),
    validTo: addDays(today, 30),
    maxUses: 50,
    adminId: opts.adminId,
  });
  if (promo.ok) extras.push("a live promo code (RAYA20)");

  // A court out for repair, and a public holiday coming up.
  await blockSlots(racquet.id, addDays(today, 3), [14, 15, 16], "Net replacement");
  await closeVenueDay(arena.id, addDays(today, 8), "Public holiday");
  extras.push("an afternoon blocked for maintenance and a closed public holiday");

  // Somebody cleared for unstaffed hours.
  const inducted = await recordInduction({
    venueId: arena.id,
    phone: phoneFor(1),
    name: NAMES[1],
    adminId: opts.adminId,
    note: "IC checked, shown the alarm and the AED",
  });
  if (inducted.ok) extras.push("one customer inducted for unstaffed hours");

  // Everything here was invented by this function — the guard above means no
  // real booking can have existed when it started — so marking the lot is
  // both correct and the only thing that makes a reload safe later.
  await db.prepare("UPDATE bookings SET demo = 1").run();
  const record = db.prepare(
    "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
  );
  await record.run("demo_seeded_on", today);
  await record.run("demo_runs_to", addDays(today, FUTURE_DAYS));

  return { ok: true, bookings, cancelled, noShows, customers, classes, extras };
}
