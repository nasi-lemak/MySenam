import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { NextRequest } from "next/server";
import { getDb } from "../src/lib/db";
import { priceBooking, readQuantityPrices } from "../src/lib/pricing";
import { createResources } from "../src/lib/resources";
import { createBooking, createVenue, getAvailability, getCourt, updateCourt } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { GET as quoteGet } from "../src/app/api/quote/route";

/**
 * How a booking of something with places is priced (lib/pricing.ts): per
 * place by default, one price for the booking where the venue says so, a
 * lower price per place for larger bookings, and kinds of kit as resources
 * of their own.
 */

const ZONE = "Asia/Kuala_Lumpur";
const day = (n: number) => addDays(todayISO(ZONE), n);
const at = (h: number) => h * 60;
let n = 0;
const phone = () => `0188${String(++n).padStart(6, "0")}`;
let venueId: number;

async function fleet(name: string, rate: number, capacity: number, sport = "kayak") {
  const made = await createResources({ venueId, sport, name, offPeakRate: rate, peakRate: rate, capacity, deposit: 0 });
  if (!made.ok) throw new Error(made.error);
  return made.courts[0];
}
const book = (courtId: number, players: number, h = 9) =>
  createBooking({ by: "staff", courtId, date: day(3), start: at(h), end: at(h + 1), name: "Hirer", phone: phone(), players });

beforeAll(async () => {
  const v = await createVenue({ name: "Lake Hire", area: "Putrajaya", address: "x", phone: "0312341111", openMin: at(7), closeMin: at(20) });
  if (!v.ok) throw new Error("venue");
  venueId = v.venue.id;
});

describe("a fleet made from its template", () => {
  it("is priced per place, never also per player, and can be edited", async () => {
    const boats = await fleet("Kayaks", 25, 10);
    expect(boats.perPlayer).toBe(false);
    // Templates once made fleets per player too, which every later edit refused.
    expect(await updateCourt(boats.id, { name: "Kayak fleet" })).toMatchObject({ ok: true, court: { name: "Kayak fleet" } });
    const four = await book(boats.id, 4);
    expect(four).toMatchObject({ ok: true, booking: { totalPrice: 100, players: 4 } });
    // The database holds the line too.
    await expect(getDb().prepare("UPDATE courts SET per_player = 1 WHERE id = ?").run(boats.id)).rejects.toMatchObject({ code: "23514" });
  });
});

describe("one price for the booking", () => {
  it("charges the rate once, however many places it takes, and still counts them", async () => {
    const room = await fleet("Party deck", 120, 30, "gym");
    expect(await updateCourt(room.id, { flatRate: true })).toMatchObject({ ok: true, court: { flatRate: true } });
    const eight = await book(room.id, 8);
    expect(eight).toMatchObject({ ok: true, booking: { totalPrice: 120, players: 8 } });
    const quote = (await (
      await quoteGet(new NextRequest(`http://localhost/api/quote?courtId=${room.id}&date=${day(4)}&start=${at(9)}&end=${at(10)}&players=5`))
    ).json()) as { court: number };
    expect(quote.court).toBe(120);
    // Its places are still held, all eight of them.
    const held = (await getDb().prepare("SELECT SUM(places)::int AS n FROM claims WHERE court_id = ? AND active").get(room.id)) as { n: number };
    expect(held.n).toBe(8);
  });

  it("is only for something with places", async () => {
    const court = await fleet("Fencing piste", 40, 1, "fencing");
    expect(await updateCourt(court.id, { flatRate: true })).toMatchObject({ ok: false });
  });
});

describe("prices by quantity", () => {
  it("lets a larger booking pay less a place, from the size the venue sets", async () => {
    const boards = await fleet("Paddleboards", 20, 12, "paddleboard");
    expect(await updateCourt(boards.id, { quantityPrices: [{ from: 4, percent: 90 }, { from: 8, percent: 80 }] })).toMatchObject({ ok: true });
    expect((await book(boards.id, 3)).ok && (await getCourt(boards.id))!.quantityPrices).toEqual([
      { from: 4, percent: 90 },
      { from: 8, percent: 80 },
    ]);
    expect(await book(boards.id, 4, 10)).toMatchObject({ ok: true, booking: { totalPrice: 72 } });
    expect(await book(boards.id, 8, 11)).toMatchObject({ ok: true, booking: { totalPrice: 128 } });
  });

  it("are refused when a larger booking would not pay less", () => {
    expect(readQuantityPrices([{ from: 4, percent: 90 }, { from: 8, percent: 95 }])).toMatchObject({ ok: false });
    expect(readQuantityPrices([{ from: 1, percent: 90 }])).toMatchObject({ ok: false });
    expect(readQuantityPrices([])).toEqual({ ok: true, value: null });
  });

  it("apply to a court priced per player, and never to one booked whole", () => {
    const base = { sport: "archery", offPeakRate: 10, peakRate: 10, memberOffPeakRate: null, memberPeakRate: null, quantityPrices: [{ from: 4, percent: 50 }] };
    const span = { start: at(9), end: at(10) };
    expect(priceBooking({ court: { ...base, perPlayer: true }, date: day(3), span, players: 4 }).court).toBe(20);
    expect(priceBooking({ court: { ...base, perPlayer: false }, date: day(3), span, players: 4 }).court).toBe(10);
  });
});

describe("kinds of kit", () => {
  it("are resources of their own under one activity, each with its price and count", async () => {
    const single = await fleet("Single kayaks", 25, 8);
    const double = await fleet("Double kayaks", 40, 4);
    const offered = (await getAvailability(venueId, day(5), "kayak")).map((a) => [a.court.name, a.court.offPeakRate, a.court.capacity]);
    expect(offered).toEqual(expect.arrayContaining([["Single kayaks", 25, 8], ["Double kayaks", 40, 4]]));
    expect(await book(double.id, 5)).toMatchObject({ ok: false });
    expect(await book(single.id, 5)).toMatchObject({ ok: true, booking: { totalPrice: 125 } });
  });
});
