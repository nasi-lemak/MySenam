import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { saveCoach } from "../src/lib/coaching";
import { setCourtParts } from "../src/lib/court-links";
import { getDb, resetTransactionStats, transactionStats } from "../src/lib/db";
import { checkIntegrity } from "../src/lib/integrity";
import { POST as bookRoute } from "../src/app/api/bookings/route";
import { createBooking, createCourt, createVenue } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * Bookings under contention, on real Postgres when TEST_DATABASE_URL is set
 * (on PGlite they run, one connection, without racing).
 *
 * Independent bookings, at different venues, must all go through: none may
 * fail for colliding with another it has nothing to do with. Bookings that
 * want the same thing must end with exactly the right number through, the
 * rest refused cleanly, and nothing left held that should not be. Each runs
 * several rounds, since a race that is lost one time in ten is still lost.
 *
 * Those are guarantees, true on any machine. How long a round took and how
 * many transactions had to be run again depend on the machine and what else
 * it is doing, so they are recorded as each round runs and judged apart, in
 * "measured on this machine" at the end, against the same bounds as before:
 * a slow or retrying round fails there, with every figure, and never hides
 * or stands in for a correctness failure (docs/architecture/booking-concurrency.md).
 */

const ROUNDS = 4;
const MANY = 24;
const QUICK_MS = 8_000;
/** Retries allowed in a round of independent bookings (B13, B30). */
const RETRIES = 2;

/** What each round took: the environment-sensitive half, judged at the end. */
const measured: { scenario: string; round: number; ms: number; retries?: number; stats: string }[] = [];
function measure(scenario: string, round: number, ms: number, retries?: number) {
  measured.push({ scenario, round, ms: Math.round(ms), ...(retries !== undefined ? { retries } : {}), stats: JSON.stringify(transactionStats()) });
}

let n = 0;
const venues: number[] = [];
const phone = () => `0129${String(++n).padStart(6, "0")}`;

async function court(venueId: number, opts: { capacity?: number; sport?: string } = {}) {
  const made = await createCourt({
    venueId,
    name: `Contention ${++n}`,
    sport: opts.sport ?? "badminton",
    offPeakRate: 20,
    peakRate: 20,
    capacity: opts.capacity ?? 1,
  });
  if (!made.ok) throw new Error(made.error);
  return made.court;
}

/** Live claims that belong to nothing live: what a lost race must never leave behind. */
async function leakedClaims(): Promise<number> {
  const r = (await getDb()
    .prepare(
      `SELECT COUNT(*)::int AS n FROM claims c LEFT JOIN bookings b ON b.id = c.booking_id
        WHERE c.active AND c.kind = 'booking' AND (b.id IS NULL OR b.status <> 'confirmed')`
    )
    .get()) as { n: number };
  const coach = (await getDb()
    .prepare(
      `SELECT COUNT(*)::int AS n FROM coach_claims c LEFT JOIN bookings b ON b.id = c.booking_id
        WHERE c.active AND (b.id IS NULL OR b.status <> 'confirmed')`
    )
    .get()) as { n: number };
  return r.n + coach.n;
}

/** Tries run again since the last reset, whatever stopped them. */
const retried = () => Object.values(transactionStats().retries).reduce((a, b) => a + b, 0);

async function timed<T>(fn: () => Promise<T>): Promise<{ value: T; ms: number }> {
  const t0 = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - t0 };
}

beforeAll(async () => {
  for (let i = 0; i < MANY; i++) {
    const v = await createVenue({ name: `Contention Venue ${i}`, area: "Petaling Jaya", address: "x", phone: `03120${String(i).padStart(5, "0")}`, openMin: 7 * 60, closeMin: 23 * 60 });
    if (!v.ok) throw new Error(v.error);
    venues.push(v.venue.id);
  }
});

describe("independent bookings at the same moment", () => {
  it("all go through, at different venues, without colliding", async () => {
    const courts = await Promise.all(venues.map((v) => court(v)));
    for (let round = 0; round < ROUNDS; round++) {
      const date = addDays(todayISO(), 3 + round);
      resetTransactionStats();
      const { value: results, ms } = await timed(() =>
        Promise.all(courts.map((c) => createBooking({ courtId: c.id, date, start: 18 * 60, end: 19 * 60, name: "Independent", phone: phone() })))
      );
      const failed = results.filter((r) => !r.ok).map((r) => (r.ok ? "" : r.code ?? r.error));
      expect(failed, `round ${round}: ${JSON.stringify(transactionStats())}`).toEqual([]);
      expect(transactionStats().exhausted).toBe(0);
      measure("different venues", round, ms, retried());
    }
    expect(await leakedClaims()).toBe(0);
    expect(await checkIntegrity()).toEqual([]);
  });

  it("all go through on different courts of one venue", async () => {
    const venueId = venues[0];
    const courts: Awaited<ReturnType<typeof court>>[] = [];
    for (let i = 0; i < MANY; i++) courts.push(await court(venueId));
    for (let round = 0; round < ROUNDS; round++) {
      const date = addDays(todayISO(), 10 + round);
      resetTransactionStats();
      const { value: results, ms } = await timed(() =>
        Promise.all(courts.map((c) => createBooking({ courtId: c.id, date, start: 18 * 60, end: 19 * 60, name: "Neighbour", phone: phone() })))
      );
      expect(results.filter((r) => !r.ok).map((r) => (r.ok ? "" : r.code)), JSON.stringify(transactionStats())).toEqual([]);
      expect(transactionStats().exhausted).toBe(0);
      measure("different courts of one venue", round, ms, retried());
    }
    expect(await leakedClaims()).toBe(0);
  });
});

describe("bookings that want the same thing", () => {
  it("one court: one booking, the rest refused cleanly", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const c = await court(venues[1]);
      const date = addDays(todayISO(), 3 + round);
      resetTransactionStats();
      const { value: results, ms } = await timed(() =>
        Promise.all(Array.from({ length: MANY }, () => createBooking({ courtId: c.id, date, start: 18 * 60, end: 19 * 60, name: "Rival", phone: phone() })))
      );
      expect(results.filter((r) => r.ok), JSON.stringify(transactionStats())).toHaveLength(1);
      // Every loser was told it was taken: not an error, not "busy".
      for (const r of results) if (!r.ok) expect(r.code ?? r.error).not.toBe("BUSY");
      expect(transactionStats().exhausted).toBe(0);
      measure("one court", round, ms);
    }
    expect(await leakedClaims()).toBe(0);
    expect(await checkIntegrity()).toEqual([]);
  });

  it("a shared floor: exactly its places, the rest refused", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const floor = await court(venues[2], { capacity: 5, sport: "gym" });
      const date = addDays(todayISO(), 3 + round);
      resetTransactionStats();
      const { value: results, ms } = await timed(() =>
        Promise.all(Array.from({ length: MANY }, () => createBooking({ courtId: floor.id, date, start: 18 * 60, end: 19 * 60, name: "Lifter", phone: phone() })))
      );
      expect(results.filter((r) => r.ok), JSON.stringify(transactionStats())).toHaveLength(5);
      expect(transactionStats().exhausted).toBe(0);
      measure("a shared floor", round, ms);
    }
    expect(await leakedClaims()).toBe(0);
    expect(await checkIntegrity()).toEqual([]);
  });

  it("a hall and the courts under it: the pitch or its courts, never both", async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const venueId = venues[3];
      const parts = [await court(venueId), await court(venueId), await court(venueId)];
      const pitch = await court(venueId, { sport: "futsal" });
      const linked = await setCourtParts(pitch.id, parts.map((p) => p.id));
      if (!linked.ok) throw new Error(linked.error);
      const date = addDays(todayISO(), 3 + round);
      resetTransactionStats();
      const asks = [pitch, ...parts, pitch, ...parts, pitch, ...parts];
      const { value: results, ms } = await timed(() =>
        Promise.all(asks.map((c) => createBooking({ courtId: c.id, date, start: 18 * 60, end: 19 * 60, name: "Hall", phone: phone() })))
      );
      const won = asks.filter((_, i) => results[i].ok).map((c) => c.id);
      // Either the pitch once, or each court once: never a court and the pitch.
      if (won.includes(pitch.id)) expect(won).toEqual([pitch.id]);
      else expect([...won].sort()).toEqual(parts.map((p) => p.id).sort());
      expect(transactionStats().exhausted).toBe(0);
      measure("a hall and its courts", round, ms);
    }
    expect(await leakedClaims()).toBe(0);
    expect(await checkIntegrity()).toEqual([]);
  });

  it("one coach: one lesson, the courts the others tried let go", async () => {
    const venueId = venues[4];
    for (let i = 0; i < 8; i++) await court(venueId);
    const hours = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, from: 7 * 60, until: 22 * 60 }));
    const saved = await saveCoach(venueId, { name: "Contended Coach", sports: ["badminton"], rate: 50, hours });
    if (!saved.ok) throw new Error(saved.error);
    for (let round = 0; round < ROUNDS; round++) {
      const date = addDays(todayISO(), 3 + round);
      resetTransactionStats();
      const { value: results, ms } = await timed(() =>
        Promise.all(
          Array.from({ length: 8 }, (_, i) =>
            bookRoute(
              new NextRequest("http://localhost/api/bookings", {
                method: "POST",
                headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${round * 10 + i + 1}` },
                body: JSON.stringify({ venueId, sport: "badminton", date, hours: [15], coachId: saved.coach.id, name: `Pupil ${i}`, phone: phone() }),
              })
            )
          )
        )
      );
      const statuses = results.map((r) => r.status);
      expect(statuses.filter((s) => s === 201), `${statuses} ${JSON.stringify(transactionStats())}`).toHaveLength(1);
      expect(statuses.filter((s) => s >= 500)).toEqual([]);
      measure("one coach", round, ms);
    }
    expect(await leakedClaims()).toBe(0);
    expect(await checkIntegrity()).toEqual([]);
  });
});

describe("measured on this machine (depends on its load; judged apart from the guarantees above)", () => {
  // Independent bookings share no row and, since migration 0206, no page of an index they must
  // check at once (B30): next to none is run again. Measured at 0–2 a round, on a loaded machine too.
  it(`independent bookings: at most ${RETRIES} retried a round`, () => {
    const rounds = measured.filter((m) => m.retries !== undefined);
    expect(rounds.length).toBe(2 * ROUNDS);
    expect(rounds.filter((m) => (m.retries as number) > RETRIES)).toEqual([]);
  });

  it(`every round settled within ${QUICK_MS / 1000} seconds`, () => {
    expect(measured.length).toBe(6 * ROUNDS);
    expect(measured.filter((m) => m.ms >= QUICK_MS)).toEqual([]);
  });
});
