import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { getDb } from "../src/lib/db";
import { grantLoyalty, grantLoyaltyIfDue, loyaltyStanding, setLoyalty } from "../src/lib/loyalty";
import { phoneKey } from "../src/lib/phone";
import { createBooking, createCourt, createVenue, listPassesForVenue, payBookingWithPass, setPaymentStatus } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/** A free hour for regulars: every so many paid hours played at a venue, one hour on the venue. */

let venueId: number;
let courtId: number;
let n = 0;
const REGULAR = "012-777 8888";

/** A paid hour this number played, `daysAgo` days back. */
async function played(daysAgo: number, opts: { phone?: string; paid?: boolean; noShow?: boolean } = {}) {
  n++;
  const made = await createBooking({ courtId, date: addDays(todayISO(), 1 + (n % 13)), hours: [7 + (n % 15)], name: "Rina Tan", phone: opts.phone ?? REGULAR, email: "rina@example.my" });
  if (!made.ok) throw new Error(made.error);
  if (opts.paid !== false) await setPaymentStatus(made.booking.code, true, "cash");
  await getDb()
    .prepare("UPDATE bookings SET date = ?, no_show = ? WHERE id = ?")
    .run(addDays(todayISO(), -daysAgo), opts.noShow ? 1 : 0, made.booking.id);
  return made.booking;
}

beforeAll(async () => {
  const made = await createVenue({ name: "Loyal Hall", area: "PJ", address: "x", phone: "0312344444", openHour: 7, closeHour: 23 });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  const court = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 20, peakRate: 20 });
  if (!court.ok) throw new Error("court");
  courtId = court.court.id;
});

describe("a free hour for regulars", () => {
  it("is off until the venue turns it on, within sensible bounds", async () => {
    for (let i = 0; i < 5; i++) await played(i + 1);
    expect(await grantLoyalty()).toBe(0);
    expect(await setLoyalty(venueId, 2)).toMatchObject({ ok: false });
    expect(await setLoyalty(venueId, 5)).toEqual({ ok: true, every: 5 });
  });

  it("is given once for every so many paid hours played, as a one-hour pass, and told by email", async () => {
    // Not counted: unpaid, a no-show, or still to come.
    await played(2, { paid: false });
    await played(2, { noShow: true });
    expect(await grantLoyalty()).toBe(1);
    expect(await grantLoyalty()).toBe(0);
    const passes = await listPassesForVenue(venueId);
    const free = passes.find((p) => p.name === "Loyalty: one free hour")!;
    expect(free).toMatchObject({ entries: 1, price: 0 });
    const mail = (await getDb().prepare("SELECT recipient, body FROM messages WHERE kind = 'loyalty_reward'").all()) as { recipient: string; body: string }[];
    expect(mail).toHaveLength(1);
    expect(mail[0].body).toContain(free.code);
    expect(await loyaltyStanding(venueId, phoneKey(REGULAR))).toEqual({ hours: 5, rewards: 1 });
  });

  it("does not count the free hour itself towards the next", async () => {
    const b = await createBooking({ courtId, date: addDays(todayISO(), 2), hours: [20], name: "Rina Tan", phone: REGULAR });
    if (!b.ok) throw new Error(b.error);
    const free = (await listPassesForVenue(venueId)).find((p) => p.name === "Loyalty: one free hour")!;
    expect(await payBookingWithPass(b.booking.id, free.code)).toMatchObject({ ok: true });
    await getDb().prepare("UPDATE bookings SET date = ?, payment_status = 'paid', total_price = 20 WHERE id = ?").run(addDays(todayISO(), -1), b.booking.id);
    expect((await loyaltyStanding(venueId, phoneKey(REGULAR))).hours).toBe(5);
  });

  it("runs once a day from the scheduler", async () => {
    for (let i = 0; i < 5; i++) await played(i + 1);
    expect(await grantLoyaltyIfDue()).toBe(1);
    for (let i = 0; i < 5; i++) await played(i + 1);
    expect(await grantLoyaltyIfDue()).toBe(0);
  });
});
