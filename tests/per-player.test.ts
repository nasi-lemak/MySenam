import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { bookingSale } from "../src/lib/documents";
import { createBooking, createCourt, createVenue, rescheduleBooking, rescheduleOptions, updateCourt } from "../src/lib/store";
import { addDays, dayOfWeek, todayISO } from "../src/lib/time";

/** A court priced per player: its rates are a head an hour, and a booking says how many play. */

let pickle: number;
let plain: number;
let gym: number;
let n = 0;
const phone = () => `0144440${String(++n).padStart(3, "0")}`;
let date = addDays(todayISO(), 1);
while ([0, 6].includes(dayOfWeek(date))) date = addDays(date, 1);

beforeAll(async () => {
  const v = await createVenue({ name: "Pickle Hub", area: "PJ", address: "x", phone: "0366660000" });
  if (!v.ok) throw new Error("venue");
  const make = async (name: string, sport: string, capacity = 1) => {
    const c = await createCourt({ venueId: v.venue.id, name, sport: sport as never, offPeakRate: 8, peakRate: 10, capacity });
    if (!c.ok) throw new Error(c.error);
    return c.court.id;
  };
  pickle = await make("Pickle 1", "pickleball");
  plain = await make("Pickle 2", "pickleball");
  gym = await make("Gym", "gym", 20);
});

describe("pricing a court per player", () => {
  it("is for a court booked whole, up to a number of players", async () => {
    expect(await updateCourt(gym, { perPlayer: true })).toMatchObject({ ok: false });
    expect(await updateCourt(pickle, { perPlayer: true, maxPlayers: 1 })).toMatchObject({ ok: false });
    expect(await updateCourt(pickle, { perPlayer: true, maxPlayers: 6 })).toMatchObject({ ok: true, court: { perPlayer: true, maxPlayers: 6 } });
  });

  it("charges each player, and no more than the court takes", async () => {
    const four = await createBooking({ courtId: pickle, date, hours: [9, 10], name: "Four", phone: phone(), players: 4 });
    if (!four.ok) throw new Error(four.error);
    expect(four.booking).toMatchObject({ totalPrice: 64, players: 4 });
    expect(await createBooking({ courtId: pickle, date, hours: [11], name: "Seven", phone: phone(), players: 7 } as never)).toMatchObject({
      ok: false,
      code: "PLAYERS_RANGE",
    });
    // A court priced for the court counts one, however many come.
    const other = await createBooking({ courtId: plain, date, hours: [9], name: "Pair", phone: phone(), players: 4 });
    expect(other.ok && other.booking).toMatchObject({ totalPrice: 8, players: 1 });
    // The receipt says how many.
    expect((await bookingSale(four.booking.id))!.lines[0].description).toContain("4 players");
  });

  it("moves at the new hour's price for the same players", async () => {
    const made = await createBooking({ courtId: pickle, date, hours: [12], name: "Mover", phone: phone(), players: 3 });
    if (!made.ok) throw new Error(made.error);
    const options = await rescheduleOptions(made.booking.code, date);
    const evening = options.find((o) => o.startHour === 19 && o.courtId === pickle)!;
    expect(evening).toMatchObject({ price: 30, difference: 6 });
    const moved = await rescheduleBooking(made.booking.code, { date, startHour: 19 }, "staff");
    expect(moved.ok && moved.booking.totalPrice).toBe(30);
  });
});
