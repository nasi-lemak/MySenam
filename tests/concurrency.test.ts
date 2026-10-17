import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { registerUser } from "../src/lib/auth";
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
});
