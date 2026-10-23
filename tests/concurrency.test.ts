import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { registerUser } from "../src/lib/auth";
import { saveCoach } from "../src/lib/coaching";
import { getDb } from "../src/lib/db";
import { checkIntegrity } from "../src/lib/integrity";
import { POST as bookRoute } from "../src/app/api/bookings/route";
import { ensureBootstrapAdmin, listAdmins } from "../src/lib/admin-auth";
import {
  createBooking,
  createClassSessions,
  createCourt,
  enrolInClass,
  getWalletBalance,
  issuePass,
  listVenues,
  getPassById,
  payBookingFromWallet,
  payBookingWithPass,
  refundBookingToPass,
  rescheduleBooking,
  topUpWallet,
} from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * Two people pressing the button at the same moment.
 *
 * Each of these is a check and then a write: is the court free, is there
 * credit, is there a place left in the class. On a server, two requests can
 * both pass the check before either writes, so these fire the same request
 * many times at once and count what got through. Against PGlite they still
 * interleave at every query; against a real Postgres server (TEST_DATABASE_URL)
 * they run on separate connections, which is where it would go wrong.
 */

const AT_ONCE = 8;

let adminId: number;
let venueId: number;
let n = 0;

async function gym(capacity: number) {
  const made = await createCourt({
    venueId,
    name: `Race Room ${++n}`,
    sport: "gym",
    offPeakRate: 15,
    peakRate: 15,
    capacity,
  });
  if (!made.ok) throw new Error(made.error);
  return made.court;
}

async function badmintonCourt() {
  const made = await createCourt({ venueId, name: `Race Court ${++n}`, sport: "badminton", offPeakRate: 15, peakRate: 15 });
  if (!made.ok) throw new Error(made.error);
  return made.court;
}

const together = <T>(fn: (i: number) => Promise<T>) => Promise.all(Array.from({ length: AT_ONCE }, (_, i) => fn(i)));

beforeAll(async () => {
  await ensureBootstrapAdmin();
  adminId = (await listAdmins())[0].id;
  venueId = (await listVenues())[0].id;
});

describe("at the same moment", () => {
  it("sells the last court to one person", async () => {
    const court = await badmintonCourt();
    const date = addDays(todayISO(), 4);
    const results = await together((i) =>
      createBooking({ courtId: court.id, date, hours: [10], name: `Racer ${i}`, phone: `01700000${i}` })
    );
    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it("sells a shared floor's places once each", async () => {
    const floor = await gym(3);
    const date = addDays(todayISO(), 4);
    const results = await together((i) =>
      createBooking({ courtId: floor.id, date, hours: [11], name: `Racer ${i}`, phone: `01710000${i}` })
    );
    expect(results.filter((r) => r.ok)).toHaveLength(3);
  });

  it("fills a class to its capacity and no further", async () => {
    const room = await gym(20);
    const made = await createClassSessions({
      courtId: room.id,
      name: "Race Spin",
      instructor: "Mei Ling",
      date: addDays(todayISO(), 5),
      startHour: 18,
      endHour: 19,
      capacity: 2,
      price: 20,
    });
    if (!made.ok) throw new Error(made.error);
    const results = await together((i) =>
      enrolInClass({ classId: made.classes[0].id, name: `Racer ${i}`, phone: `01720000${i}` })
    );
    expect(results.filter((r) => r.ok)).toHaveLength(2);
  });

  it("spends credit once", async () => {
    const reg = await registerUser({
      name: "Racer",
      email: "racer@example.com",
      phone: "0173000000",
      password: "correct horse battery",
    });
    if (!reg.ok) throw new Error(reg.error);
    await topUpWallet({ userId: reg.user.id, amount: 20, adminId });

    // Each booking costs 15, so the 20 covers one of them, not two.
    const bookings: { id: number }[] = [];
    for (let i = 0; i < AT_ONCE; i++) {
      const court = await badmintonCourt();
      const made = await createBooking({
        courtId: court.id,
        date: addDays(todayISO(), 6),
        hours: [10],
        name: "Racer",
        phone: reg.user.phone,
        userId: reg.user.id,
      });
      if (!made.ok) throw new Error(made.error);
      expect(made.booking.totalPrice).toBe(15);
      bookings.push(made.booking);
    }
    const results = await together((i) => payBookingFromWallet(bookings[i].id));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(await getWalletBalance(reg.user.id)).toBe(5);
  });

  it("refunds a pass entry once", async () => {
    const sold = await issuePass({
      venueId,
      sport: "badminton",
      name: "Race pass",
      entries: 5,
      price: 60,
      holderName: "Racer",
      holderPhone: "0174000000",
      expiresOn: addDays(todayISO(), 60),
      adminId,
    });
    if (!sold.ok) throw new Error(sold.error);
    const court = await badmintonCourt();
    const made = await createBooking({
      courtId: court.id,
      date: addDays(todayISO(), 7),
      hours: [9],
      name: "Racer",
      phone: "0174000000",
    });
    if (!made.ok) throw new Error(made.error);
    expect((await payBookingWithPass(made.booking.id, sold.pass.code)).ok).toBe(true);

    const results = await together(() => refundBookingToPass(made.booking.id));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect((await getPassById(sold.pass.id))!.remaining).toBe(5);
  });

  it("puts a coach in one lesson at a time, and lets the other courts go", async () => {
    for (let i = 0; i < AT_ONCE; i++) await badmintonCourt();
    const hours = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, from: 7 * 60, until: 22 * 60 }));
    const saved = await saveCoach(venueId, { name: "Race Coach", sports: ["badminton"], rate: 50, hours });
    if (!saved.ok) throw new Error(saved.error);
    const date = addDays(todayISO(), 8);
    const before = ((await getDb().prepare("SELECT COUNT(*)::int AS n FROM bookings WHERE date = ?").get(date)) as { n: number }).n;
    const results = await together((i) =>
      bookRoute(
        new NextRequest("http://localhost/api/bookings", {
          method: "POST",
          headers: { "content-type": "application/json", "x-forwarded-for": `203.0.113.${i + 1}` },
          body: JSON.stringify({ venueId, sport: "badminton", date, hours: [15], coachId: saved.coach.id, name: `Pupil ${i}`, phone: `01750000${i}` }),
        })
      )
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    // The courts the others had for a moment are free again: one booking that day, not eight.
    const after = ((await getDb().prepare("SELECT COUNT(*)::int AS n FROM bookings WHERE date = ? AND status = 'confirmed'").get(date)) as { n: number }).n;
    expect(after - before).toBe(1);
    expect(await checkIntegrity()).toEqual([]);
  });

  it("gives a freed hour to one of a move and a new booking, never both", async () => {
    const date = addDays(todayISO(), 9);
    // On each court, a booking at 9 moving to 11 while somebody else books 11.
    const pairs = [];
    for (let i = 0; i < AT_ONCE; i++) {
      const court = await badmintonCourt();
      const made = await createBooking({ courtId: court.id, date, hours: [9], name: `Mover ${i}`, phone: `01760000${i}` });
      if (!made.ok) throw new Error(made.error);
      pairs.push({ court, code: made.booking.code });
    }
    const raced = await Promise.all(
      pairs.map(async ({ court, code }, i) => {
        const [moved, booked] = await Promise.all([
          rescheduleBooking(code, { date, startHour: 11, courtId: court.id }, "staff"),
          createBooking({ courtId: court.id, date, hours: [11], name: `Newcomer ${i}`, phone: `01770000${i}` }),
        ]);
        return Number(moved.ok) + Number(booked.ok);
      })
    );
    expect(raced).toEqual(pairs.map(() => 1));
    expect(await checkIntegrity()).toEqual([]);
  });
});
