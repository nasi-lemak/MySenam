import fs from "fs";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";

/**
 * Marketplace-scale benchmark (docs/development/testing.md#marketplace-benchmark).
 *
 * Not part of `npm test`: `BENCH_DATABASE_URL=postgresql://… npm run bench`
 * fills that database once with a realistic multi-tenant marketplace — 400
 * venues in 25 areas (100 of them branches of 20 businesses), about 3,200
 * resources across the catalogue's activities, and six weeks of bookings
 * (two past, four ahead) at evening-heavy occupancy, every one holding its
 * claim — then times what customers, staff and the scheduler do against it,
 * through the same functions the routes call. The database is kept between
 * runs; drop it to start again.
 */

const url = process.env.BENCH_DATABASE_URL;
const VENUES = Number(process.env.BENCH_VENUES ?? 400);
const RUNS = Number(process.env.BENCH_RUNS ?? 20);
/** The mixed-traffic phase: so many customers at once, for so long. */
const WORKERS = Number(process.env.BENCH_WORKERS ?? 16);
const SECONDS = Number(process.env.BENCH_SECONDS ?? 20);

/** Venue types: what their resources are, and how many of each. */
const TYPES: { weight: number; courts: [string, number, number][] }[] = [
  // [activity, how many, capacity]
  { weight: 30, courts: [["badminton", 8, 1]] },
  { weight: 10, courts: [["badminton", 6, 1], ["pickleball", 2, 1]] },
  { weight: 12, courts: [["futsal", 4, 1], ["football", 1, 1]] },
  { weight: 8, courts: [["padel", 4, 1], ["tennis", 2, 1]] },
  { weight: 8, courts: [["pickleball", 6, 1]] },
  { weight: 6, courts: [["basketball", 2, 1], ["volleyball", 2, 1], ["netball", 1, 1], ["futsal", 2, 1]] },
  { weight: 5, courts: [["squash", 4, 1], ["table_tennis", 6, 1]] },
  { weight: 4, courts: [["swimming", 6, 4], ["gym", 1, 30]] },
  { weight: 4, courts: [["climbing", 1, 30], ["bouldering", 1, 40]] },
  { weight: 4, courts: [["golf_simulator", 4, 1], ["bowling", 8, 1]] },
  { weight: 3, courts: [["kayak", 1, 10], ["paddleboard", 1, 10]] },
  { weight: 3, courts: [["archery", 6, 1], ["fencing", 2, 1], ["cricket", 3, 1]] },
  { weight: 3, courts: [["sepak_takraw", 3, 1], ["floorball", 1, 1], ["water_polo", 1, 1]] },
];
const AREAS = Array.from({ length: 25 }, (_, i) => `Area ${String(i + 1).padStart(2, "0")}`);

/** A seeded generator, so every fill is the same marketplace. */
function rng(seed: number) {
  return () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
}

const round1 = (n: number) => Math.round(n * 10) / 10;

function stats(ms: number[]) {
  const s = [...ms].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
  return { n: s.length, p50: round1(at(50)), p95: round1(at(95)), p99: round1(at(99)), max: round1(s[s.length - 1]) };
}

/** Statements sent so far (lib/db.ts), to count what each operation costs. */
let queries: () => number = () => 0;

async function time<T>(label: string, runs: number, fn: (i: number) => Promise<T>, out: Record<string, unknown>) {
  await fn(-1); // warm
  const ms: number[] = [];
  const q0 = queries();
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await fn(i);
    ms.push(performance.now() - t0);
  }
  out[label] = { ...stats(ms), queries: round1((queries() - q0) / runs) };
  console.log(`BENCH ${label}: ${JSON.stringify(out[label])}`);
}

describe.skipIf(!url)("a marketplace at scale", () => {
  it("is filled, then timed", async () => {
    process.env.DATABASE_URL = url;
    process.env.MYSENAM_GEOCODER = "off";
    const { getDb, transactionStats, resetTransactionStats } = await import("../../src/lib/db");
    queries = () => transactionStats().queries;
    const store = await import("../../src/lib/store");
    const { createResources } = await import("../../src/lib/resources");
    const { checkIntegrity } = await import("../../src/lib/integrity");
    const { addDays, todayISO } = await import("../../src/lib/time");
    const db = getDb();
    const today = todayISO("Asia/Kuala_Lumpur");
    const out: Record<string, unknown> = {};

    // ------------------------------------------------------------ fill once
    const have = ((await db.prepare("SELECT COUNT(*)::int AS n FROM venues WHERE name LIKE 'Bench %'").get()) as { n: number }).n;
    if (have < VENUES) {
      const t0 = performance.now();
      const r = rng(42);
      const businesses: number[] = [];
      for (let b = 0; b < 20; b++)
        businesses.push(((await db.prepare("INSERT INTO businesses (name) VALUES (?) RETURNING id").get(`Bench Group ${b + 1}`)) as { id: number }).id);
      const total = TYPES.reduce((s, t) => s + t.weight, 0);
      for (let v = have; v < VENUES; v++) {
        const area = AREAS[v % AREAS.length];
        // Spread over the Klang Valley, each area its own patch.
        const lat = 2.9 + (v % 25) * 0.02 + r() * 0.02;
        const lng = 101.5 + Math.floor((v % 25) / 5) * 0.05 + r() * 0.04;
        const made = await store.createVenue({
          name: `Bench ${String(v + 1).padStart(4, "0")}`,
          area,
          address: `${v + 1} Jalan Bench`,
          phone: `03${String(70000000 + v)}`,
          openMin: 7 * 60,
          closeMin: 23 * 60,
        });
        if (!made.ok) throw new Error(made.error);
        const id = made.venue.id;
        await db
          .prepare("UPDATE venues SET lat = ?, lng = ?, published_at = datetime('now'), business_id = ? WHERE id = ?")
          .run(lat, lng, v < 100 ? businesses[v % 20] : null, id);
        let pick = r() * total;
        const type = TYPES.find((t) => (pick -= t.weight) < 0) ?? TYPES[0];
        for (const [sport, count, capacity] of type.courts) {
          const res = await createResources({ venueId: id, sport, count, offPeakRate: 15 + Math.round(r() * 30), peakRate: 25 + Math.round(r() * 40), capacity });
          if (!res.ok) throw new Error(`${sport}: ${res.error}`);
        }
      }
      // Six weeks of bookings, an hour each from 08:00 to 22:00: busier in the evening and at weekends.
      await db.prepare("SELECT setseed(0.42)").get();
      const from = addDays(today, -14);
      await db
        .prepare(
          `INSERT INTO bookings (code, court_id, date, start_min, end_min, starts_at, ends_at, name, phone, total_price, status, payment_status, players)
           SELECT 'BN-' || c.id || '-' || to_char(d, 'YYYYMMDD') || '-' || h || '-' || p,
                  c.id, to_char(d, 'YYYY-MM-DD'), h * 60, h * 60 + 60,
                  (d + make_interval(hours => h)) AT TIME ZONE 'Asia/Kuala_Lumpur',
                  (d + make_interval(hours => h + 1)) AT TIME ZONE 'Asia/Kuala_Lumpur',
                  'Bench Player', '01' || lpad((floor(random() * 90000000) + 10000000)::text, 8, '0'),
                  c.off_peak_rate, 'confirmed', CASE WHEN d < CURRENT_DATE THEN 'paid' ELSE 'unpaid' END, 1
             FROM courts c
             JOIN venues v ON v.id = c.venue_id AND v.name LIKE 'Bench %'
             CROSS JOIN generate_series(?::date, ?::date, interval '1 day') d
             CROSS JOIN generate_series(8, 21) h
             CROSS JOIN generate_series(1, LEAST(c.capacity, 3)) p
            WHERE random() < (CASE WHEN h >= 17 THEN 0.75 ELSE 0.30 END) * (CASE WHEN extract(isodow FROM d) >= 6 THEN 1.15 ELSE 1 END)`
        )
        .run(from, addDays(today, 28));
      // Each holds its court: a booking of a whole court its spaces, of a shared one a place.
      await db
        .prepare(
          `INSERT INTO claims (venue_id, court_id, space_id, places, kind, booking_id, during, occupied)
           SELECT c.venue_id, b.court_id, cs.space_id, NULL, 'booking', b.id, tstzrange(b.starts_at, b.ends_at), tstzrange(b.starts_at, b.ends_at)
             FROM bookings b JOIN courts c ON c.id = b.court_id JOIN court_spaces cs ON cs.court_id = c.id
            WHERE b.code LIKE 'BN-%' AND c.capacity = 1`
        )
        .run();
      console.log(`BENCH fill, whole courts held: ${Math.round((performance.now() - t0) / 1000)} s`);
      // Places on shared floors. The capacity trigger checks each row as it goes in, at about
      // ten rows a second here (docs/development/testing.md#marketplace-benchmark), so the fill
      // turns it off for this one insert: at most three places an hour, on floors of four or more,
      // cannot go over. What a live booking pays for the check is timed below.
      await db.prepare("ALTER TABLE claims DISABLE TRIGGER claims_capacity").run();
      try {
        await db
          .prepare(
            `INSERT INTO claims (venue_id, court_id, space_id, places, kind, booking_id, during, occupied)
             SELECT c.venue_id, b.court_id, NULL, 1, 'booking', b.id, tstzrange(b.starts_at, b.ends_at), tstzrange(b.starts_at, b.ends_at)
               FROM bookings b JOIN courts c ON c.id = b.court_id
              WHERE b.code LIKE 'BN-%' AND c.capacity > 1`
          )
          .run();
      } finally {
        await db.prepare("ALTER TABLE claims ENABLE TRIGGER claims_capacity").run();
      }
      await db.prepare("ANALYZE").run();
      out.fill = { seconds: Math.round((performance.now() - t0) / 1000) };
      console.log(`BENCH fill: ${JSON.stringify(out.fill)}`);
    }
    const size = (await db
      .prepare(
        `SELECT (SELECT COUNT(*)::int FROM venues) AS venues, (SELECT COUNT(*)::int FROM courts) AS courts,
                (SELECT COUNT(*)::int FROM bookings) AS bookings, (SELECT COUNT(*)::int FROM claims WHERE active) AS claims,
                pg_size_pretty(pg_database_size(current_database())) AS size`
      )
      .get()) as Record<string, unknown>;
    out.dataset = size;
    console.log(`BENCH dataset: ${JSON.stringify(size)}`);

    // ------------------------------------------------------------ timings
    const venues = ((await db.prepare("SELECT id, area, lat, lng FROM venues WHERE name LIKE 'Bench %' ORDER BY id").all()) as {
      id: number;
      area: string;
      lat: number;
      lng: number;
    }[]);
    const pick = (i: number) => venues[(Math.abs(i) * 37) % venues.length];
    const date = (i: number) => addDays(today, 1 + (Math.abs(i) % 7));

    await time("venue grid, every resource (GET /api/availability)", RUNS, (i) => store.getAvailability(pick(i).id, date(i)), out);
    await time("venue grid, one activity", RUNS, (i) => store.getAvailability(pick(i).id, date(i), "badminton"), out);
    await time("search: badminton in an area, evening, soonest", RUNS, (i) =>
      store.searchAvailability({ sport: "badminton", date: date(i), fromMin: 18 * 60, toMin: 21 * 60, minutes: 60, area: pick(i).area }), out);
    await time("search: badminton in an area, cheapest", RUNS, (i) =>
      store.searchAvailability({ sport: "badminton", date: date(i), fromMin: 18 * 60, toMin: 21 * 60, minutes: 60, area: pick(i).area, sort: "cheapest", limit: 200 }), out);
    await time("search: near a point, 5 km", RUNS, (i) =>
      store.searchAvailability({ sport: "badminton", date: date(i), fromMin: 17 * 60, toMin: 22 * 60, minutes: 60, near: { lat: pick(i).lat, lng: pick(i).lng, km: 5 }, sort: "nearest", limit: 200 }), out);
    await time("search: a rarer activity nationwide (archery)", RUNS, (i) =>
      store.searchAvailability({ sport: "archery", date: date(i), fromMin: 9 * 60, toMin: 21 * 60, minutes: 60 }), out);
    // The same, for a signed-in account and two children it manages (lib/eligibility.ts): archery asks for a
    // sign-off, so each result says each one's status, from one more query, among 6,000 other people's sign-offs.
    {
      const { registerUser } = await import("../../src/lib/auth");
      const { addManaged } = await import("../../src/lib/managed-people");
      const email = "bench-taking@bench.test";
      let user = (await db.prepare("SELECT id FROM users WHERE email = ?").get(email)) as { id: number } | undefined;
      if (!user) {
        const made = await registerUser({ name: "Bench Parent", email, phone: "0179990001", password: "a long enough password" });
        if (!made.ok) throw new Error(made.error);
        user = { id: made.user.id };
        await db.prepare("UPDATE users SET phone_verified_at = datetime('now') WHERE id = ?").run(user.id);
        for (const name of ["Bench Child A", "Bench Child B"]) await addManaged(user.id, { displayName: name, relationship: "parent", authority: true });
        await db
          .prepare(
            `INSERT INTO sign_offs (venue_id, sport, phone, name, kind)
             SELECT v.id, 'archery', '0178' || lpad(g::text, 6, '0'), 'Bench Archer', 'operational'
               FROM (SELECT id, row_number() OVER (ORDER BY id) AS k FROM venues WHERE name LIKE 'Bench %') v
               JOIN generate_series(1, 6000) g ON g % 400 = v.k % 400`
          )
          .run();
        await db.prepare("ANALYZE sign_offs").run();
      }
      const kids = ((await db.prepare("SELECT participant_id AS id FROM participant_guardians WHERE user_id = ? ORDER BY id").all(user.id)) as { id: number }[]).map((k) => k.id);
      await time("search: archery nationwide, for who is taking part (account and two children)", RUNS, (i) =>
        store.searchAvailability({ sport: "archery", date: date(i), fromMin: 9 * 60, toMin: 21 * 60, minutes: 60, taking: { userId: user.id, self: true, participants: kids } }), out);
    }
    await time("search: courts counted nationwide (needs-area check)", RUNS, () => store.countSearchCourts({ sport: "badminton" }), out);
    await time("home: activities by popularity, nationwide", RUNS, () => store.activitiesByPopularity({}), out);
    await time("home: venue list, first page", RUNS, (i) => store.listVenuePage({ area: i % 2 ? pick(i).area : undefined, page: 1 }), out);
    await time("search page: activities offered", RUNS, () => store.sportsOfferedAt(undefined, { courtsOnly: true }), out);

    // A free hour on a court, to book and to move.
    const free = async (i: number) => {
      const grid = await store.getAvailability(pick(i).id, date(i + 3));
      for (const g of grid) {
        if (g.court.capacity !== 1) continue;
        const start = g.starts?.find((s) => s.minute >= 9 * 60);
        if (start) return { courtId: g.court.id, date: date(i + 3), start: start.minute };
      }
      return null;
    };
    // Free times found first, so the booking alone is timed.
    const frees = await Promise.all(Array.from({ length: RUNS + 1 }, (_, i) => free(i + 1000)));
    await time("book a court (customer)", RUNS, async (i) => {
      const f = frees[i + 1];
      if (f) await store.createBooking({ ...f, end: f.start + 60, name: "Bench Live", phone: `017${String(1000000 + i + 1000)}` });
    }, out);
    // A place on a shared floor: the capacity trigger sums what else is held then.
    const floors = (await db
      .prepare("SELECT c.id FROM courts c JOIN venues v ON v.id = c.venue_id AND v.name LIKE 'Bench %' WHERE c.capacity > 1 ORDER BY c.id")
      .all()) as { id: number }[];
    if (floors.length > 0)
      await time("book a place on a shared floor (customer)", RUNS, async (i) => {
        await store.createBooking({
          courtId: floors[Math.abs(i) % floors.length].id,
          date: date(i + 3),
          start: 7 * 60,
          end: 8 * 60,
          name: "Bench Place",
          phone: `019${String(1000001 + i)}`,
        });
      }, out);
    const one = (await db.prepare("SELECT code FROM bookings WHERE name = 'Bench Live' ORDER BY id DESC LIMIT 1").get()) as { code: string } | undefined;
    if (one) await time("reschedule: free times on a day", RUNS, (i) => store.rescheduleOptions(one.code, date(i + 2)), out);

    // Fifty customers at once, each at a different venue.
    const t0 = performance.now();
    const burst = await Promise.all(
      Array.from({ length: 50 }, async (_, i) => {
        const f = await free(i + 2000);
        // An error, not a refusal, is what a customer would see as a failed page: counted, not thrown.
        return f
          ? store.createBooking({ ...f, end: f.start + 60, name: "Bench Burst", phone: `018${String(1000000 + i)}` }).catch((e: Error) => e)
          : null;
      })
    );
    out["50 bookings at once"] = {
      seconds: Math.round(performance.now() - t0) / 1000,
      made: burst.filter((b) => b && !(b instanceof Error) && b.ok).length,
      refused: burst.filter((b) => b && !(b instanceof Error) && !b.ok).length,
      errors: burst.filter((b) => b instanceof Error).map((e) => (e as Error).message.slice(0, 80)),
    };
    console.log(`BENCH 50 bookings at once: ${JSON.stringify(out["50 bookings at once"])}`);

    // Mixed traffic: customers searching, opening venue grids and booking, all at once.
    const pgStats = async () =>
      (await db
        .prepare(
          `SELECT xact_commit::int AS commits, xact_rollback::int AS rollbacks, blks_read::int AS read, blks_hit::int AS hit, deadlocks::int AS deadlocks
             FROM pg_stat_database WHERE datname = current_database()`
        )
        .get()) as Record<string, number>;
    const before = await pgStats();
    resetTransactionStats();
    const cpu0 = process.cpuUsage();
    const lat: Record<string, number[]> = { search: [], grid: [], book: [] };
    const outcome = { booked: 0, refused: 0, busy: 0, errors: [] as string[] };
    const stopAt = performance.now() + SECONDS * 1000;
    let rss = 0;
    let k = 5000;
    await Promise.all(
      Array.from({ length: WORKERS }, async () => {
        while (performance.now() < stopAt) {
          const i = k++;
          const roll = i % 10;
          const t0 = performance.now();
          try {
            if (roll < 6) {
              await store.searchAvailability({ sport: "badminton", date: date(i), fromMin: 17 * 60, toMin: 22 * 60, minutes: 60, area: pick(i).area });
              lat.search.push(performance.now() - t0);
            } else if (roll < 8) {
              await store.getAvailability(pick(i).id, date(i));
              lat.grid.push(performance.now() - t0);
            } else {
              const f = await free(i);
              const t1 = performance.now();
              if (!f) continue;
              const r = await store.createBooking({ ...f, end: f.start + 60, name: "Bench Mixed", phone: `016${String(1000000 + i)}` });
              lat.book.push(performance.now() - t1);
              if (r.ok) outcome.booked++;
              else if (r.code === "BUSY") outcome.busy++;
              else outcome.refused++;
            }
          } catch (e) {
            outcome.errors.push((e as Error).message.slice(0, 80));
          }
          rss = Math.max(rss, process.memoryUsage().rss);
        }
      })
    );
    const cpu = process.cpuUsage(cpu0);
    const after = await pgStats();
    const tx = transactionStats();
    const ops = lat.search.length + lat.grid.length + lat.book.length;
    out["mixed traffic"] = {
      workers: WORKERS,
      seconds: SECONDS,
      pool: Number(process.env.DATABASE_POOL_SIZE ?? 10),
      opsPerSecond: round1(ops / SECONDS),
      search: stats(lat.search),
      grid: stats(lat.grid),
      book: stats(lat.book),
      ...outcome,
      retries: tx.retries,
      exhausted: tx.exhausted,
      queriesPerOp: round1(tx.queries / Math.max(ops, 1)),
      appCpuSeconds: round1((cpu.user + cpu.system) / 1e6),
      appPeakRssMb: Math.round(rss / 1e6),
      db: Object.fromEntries(Object.keys(after).map((key) => [key, after[key] - before[key]])),
    };
    console.log(`BENCH mixed traffic: ${JSON.stringify(out["mixed traffic"])}`);

    await time("daily integrity check", Math.min(RUNS, 3), () => checkIntegrity(), out);
    console.log(`BENCH RESULT ${JSON.stringify(out)}`);
    // Vitest shows a passing test's output only sometimes; the file is always there.
    fs.writeFileSync(path.join(os.tmpdir(), "mysenam-bench.json"), JSON.stringify(out, null, 2));
    expect(outcome.booked).toBeGreaterThan(0);
  });
});
