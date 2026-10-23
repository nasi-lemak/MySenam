import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { moveBookingToDate } from "./helpers/bookings";
import { customerReport } from "../src/lib/customer-report";
import { getDb } from "../src/lib/db";
import { createBooking, createCourt, createVenue } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/** Who the customers were: new and returning, the best, the lapsed, the no-shows. */

let venueId: number;
let courtId: number;
const today = todayISO();
let hour = 8;

/** A booking for this number, moved to `daysAgo` days ago. */
async function played(name: string, phone: string, daysAgo: number, extra: Record<string, unknown> = {}) {
  const made = await createBooking({ courtId, date: addDays(today, 3), hours: [hour++], name, phone });
  if (!made.ok) throw new Error(made.error);
  if (hour > 21) hour = 8;
  const sets = Object.keys(extra).map((k) => `, ${k} = ?`).join("");
  await moveBookingToDate(made.booking.id, addDays(today, -daysAgo));
  if (sets) await getDb().prepare(`UPDATE bookings SET ${sets.slice(2)} WHERE id = ?`).run(...Object.values(extra), made.booking.id);
}

beforeAll(async () => {
  const made = await createVenue({ name: "Laman Sukan", area: "Seremban", address: "x", phone: "0666661111" });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  const c = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 20, peakRate: 20 });
  if (!c.ok) throw new Error("court");
  courtId = c.court.id;

  // Aisyah: here since last year, back twice this month, once not turning up.
  await played("Aisyah", "0121110001", 300);
  await played("Aisyah", "0121110001", 10);
  await played("Aisyah", "0121110001", 5, { no_show: 1 });
  // Ben: new this month, the same number typed two ways.
  await played("Ben", "012-111 0002", 8);
  await played("Ben", "+60121110002", 7);
  await played("Ben", "0121110002", 6);
  // Chong: a regular who stopped three months ago.
  for (const d of [100, 107, 114, 121, 128]) await played("Chong", "0121110003", d);
  // Not counted: a demo booking, and one whose name was removed.
  await played("Demo", "0121110004", 3, { demo: 1 });
  await played("(removed)", "0121110005", 4, { phone: "" });
});

describe("the customer report", () => {
  it("counts customers by number, new and returning", async () => {
    const r = await customerReport(venueId, addDays(today, -29), today);
    expect(r).toMatchObject({ customers: 2, newCustomers: 1, returning: 1, perCustomer: 2.5 });
  });

  it("puts the best customers first, with what they spent and since when", async () => {
    const r = await customerReport(venueId, addDays(today, -29), today);
    expect(r.top.map((c) => c.name)).toEqual(["Ben", "Aisyah"]);
    expect(r.top[1]).toMatchObject({ bookings: 2, spent: 40, since: addDays(today, -300) });
  });

  it("finds regulars who have stopped coming", async () => {
    const r = await customerReport(venueId, addDays(today, -29), today);
    expect(r.lapsed).toEqual([{ name: "Chong", phone: "0121110003", bookings: 5, last: addDays(today, -100) }]);
    // A booking coming up and they are not lapsed.
    const back = await createBooking({ courtId, date: addDays(today, 4), hours: [9], name: "Chong", phone: "0121110003" });
    if (!back.ok) throw new Error(back.error);
    expect((await customerReport(venueId, addDays(today, -29), today)).lapsed).toEqual([]);
    await getDb().prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(back.booking.id);
  });

  it("gives the share of bookings played that nobody turned up for", async () => {
    const r = await customerReport(venueId, addDays(today, -29), today);
    expect(r.noShows).toBe(1);
    expect(r.noShowRate).toBe(20);
  });
});
