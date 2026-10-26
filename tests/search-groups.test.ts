import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { savePolicy } from "../src/lib/booking-policy";
import { headedRows } from "../src/lib/court-activities";
import { resetTransactionStats, transactionStats } from "../src/lib/db";
import { createResources, setCourtHeading } from "../src/lib/resources";
import { createBooking, createVenue, getAvailability, searchAvailability, type SearchResult } from "../src/lib/store";
import { addDays, dayOfWeek, todayISO } from "../src/lib/time";

/**
 * Kinds of kit under one heading in public search: a result names the
 * heading and lists each kind as itself (its own price, places left and
 * rules), never added up, the same as the venue's grid shows them.
 */

const AREA = "Tasik Utara";
let venueId: number;
let singles: number;
let doubles: number;
let longOnes: number;
let boards: number;
let n = 0;
const phone = () => `0166100${String(++n).padStart(3, "0")}`;

/** A weekday ahead: 9 AM off-peak. */
let date = addDays(todayISO(), 2);
while ([0, 6].includes(dayOfWeek(date))) date = addDays(date, 1);

const at9 = async (): Promise<SearchResult> => {
  const found = await searchAvailability({ sport: "kayak", date, area: AREA, fromHour: 9, toHour: 9 });
  return found.find((r) => r.venue.id === venueId)!;
};

beforeAll(async () => {
  const v = await createVenue({ name: "Tasik Kayak", area: AREA, address: "x", phone: "0388882222" });
  if (!v.ok) throw new Error("venue");
  venueId = v.venue.id;
  const make = async (name: string, capacity: number, rate: number) => {
    const made = await createResources({ venueId, sport: "kayak", name, offPeakRate: rate, peakRate: rate, capacity, maxPlayers: capacity });
    if (!made.ok) throw new Error(made.error);
    return made.courts[0].id;
  };
  singles = await make("Single kayak", 6, 30);
  boards = await make("Paddleboards", 4, 20);
  doubles = await make("Double kayak", 3, 45);
  longOnes = await make("Touring kayak", 2, 60);
  for (const id of [singles, doubles, longOnes]) expect(await setCourtHeading(id, "Kayaks")).toMatchObject({ ok: true });
  // Doubles need a paddling check by staff first; touring kayaks go out for two hours at least.
  await savePolicy({ court: doubles }, { signOff: true });
  await savePolicy({ court: longOnes }, { minLength: 120, lengthStep: 60, defaultLength: 120 });
});

describe("a heading in search", () => {
  it("lists each kind under it as itself: its own price, places and rules", async () => {
    const r = await at9();
    // The venue's cheapest free resource is still the result, and the others still counted as before.
    expect(r.court.id).toBe(boards);
    expect(r.needs).toBeNull();
    expect(r.alsoFree).toBe(2);
    expect(r.groups).toEqual([
      {
        heading: "Kayaks",
        kinds: [
          { courtId: singles, name: "Single kayak", free: true, totalPrice: 30, perPlayer: false, capacity: 6, placesLeft: 6, needs: null },
          { courtId: doubles, name: "Double kayak", free: true, totalPrice: 45, perPlayer: false, capacity: 3, placesLeft: 3, needs: "signOff" },
        ],
      },
    ]);
    // Touring kayaks do not take an hour: not offered for this search.
  });

  it("counts each kind's places apart, never as one pool", async () => {
    expect(await createBooking({ courtId: singles, date, hours: [9], name: "Solo", phone: phone(), players: 4 })).toMatchObject({ ok: true });
    const kinds = (await at9()).groups[0].kinds;
    expect(kinds.map((k) => [k.name, k.placesLeft])).toEqual([
      ["Single kayak", 2],
      ["Double kayak", 3],
    ]);
    // Nothing anywhere sums them: no "5 kayaks free".
    expect(Object.keys((await at9()).groups[0])).toEqual(["heading", "kinds"]);
    // Two singles more, and the singles are full while the doubles are not.
    expect(await createBooking({ courtId: singles, date, hours: [9], name: "Pair", phone: phone(), players: 2 })).toMatchObject({ ok: true });
    const after = (await at9()).groups[0].kinds;
    expect(after.find((k) => k.courtId === singles)).toMatchObject({ free: false, placesLeft: 0 });
    expect(after.find((k) => k.courtId === doubles)).toMatchObject({ free: true, placesLeft: 3 });
  });

  it("is left out when no kind under it is free then", async () => {
    // The doubles taken at the counter, where staff answer for the sign-off.
    await savePolicy({ court: doubles }, {});
    expect(await createBooking({ courtId: doubles, date, hours: [9], name: "Group", phone: phone(), players: 3 })).toMatchObject({ ok: true });
    await savePolicy({ court: doubles }, { signOff: true });
    const r = await at9();
    expect(r.court.name).toBe("Paddleboards");
    expect(r.groups).toEqual([]);
  });

  it("lists a kind that takes the length asked for, at its own price for it", async () => {
    const found = await searchAvailability({ sport: "kayak", date, area: AREA, fromHour: 10, toHour: 10, minutes: 120 });
    const r = found.find((x) => x.venue.id === venueId)!;
    expect(r.groups[0].kinds.map((k) => [k.name, k.totalPrice])).toEqual([
      ["Single kayak", 60],
      ["Double kayak", 90],
      ["Touring kayak", 120],
    ]);
  });

  it("agrees with the venue's grid: the same kinds under the same heading, with the same places and rules", async () => {
    const r = await at9();
    const ten = (await searchAvailability({ sport: "kayak", date, area: AREA, fromHour: 10, toHour: 10 })).find((x) => x.venue.id === venueId)!;
    const day = await getAvailability(venueId, date, "kayak");
    const rows = headedRows(day);
    const under = rows.filter((x) => x.under).map((x) => x.court.name);
    // The grid shows every kind under it; search the ones that take an hour.
    expect(under).toEqual(["Single kayak", "Double kayak", "Touring kayak"]);
    expect(ten.groups[0].kinds.map((k) => k.name)).toEqual(under.filter((name) => name !== "Touring kayak"));
    for (const k of ten.groups[0].kinds) {
      const row = day.find((d) => d.court.id === k.courtId)!;
      const slot = row.slots.find((s) => s.minute === 10 * 60)!;
      expect(k.free).toBe(slot.available);
      expect(k.placesLeft).toBe(slot.capacity - slot.booked);
      expect(k.totalPrice).toBe(slot.rate);
      expect(k.needs).toBe(row.policy.needs);
    }
    expect(day.find((d) => d.court.id === doubles)!.policy.needs).toBe("signOff");
    expect(day.find((d) => d.court.id === singles)!.policy.needs).toBeNull();
    expect(r).toBeTruthy();
  });

  it("costs no more queries than a search without headings", async () => {
    resetTransactionStats();
    await at9();
    const headed = transactionStats().queries;
    for (const id of [singles, doubles, longOnes]) await setCourtHeading(id, null);
    try {
      resetTransactionStats();
      const plain = await at9();
      expect(plain.groups).toEqual([]);
      expect(transactionStats().queries).toBe(headed);
    } finally {
      for (const id of [singles, doubles, longOnes]) await setCourtHeading(id, "Kayaks");
    }
  });
});
