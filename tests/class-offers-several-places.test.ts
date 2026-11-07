import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { getDb } from "../src/lib/db";
import {
  adminCancelBooking,
  claimWaitlistOffer,
  classOfferHolds,
  createClassSessions,
  createCourt,
  enrolInClass,
  enrolPeople,
  getClass,
  joinClassWaitlist,
  listClassWaitlist,
  listWaitlistFor,
  listVenues,
  offerClassPlace,
  passOnExpiredOffers,
} from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { WAITLIST_OFFER_MINUTES } from "../src/lib/types";

/**
 * A class with several places free offers several of them (ADR 0070, which amends ADR 0060's "one at a time"): as many
 * waiting entries as there are free places, each entry holding the places it asked for for its own window, never more
 * places than are free. Run on PGlite and on Postgres (TEST_DATABASE_URL).
 */

let venueId: number;
let seq = 0;
let n = 0;
beforeAll(async () => {
  venueId = (await listVenues())[0].id;
});
afterEach(() => vi.useRealTimers());

const phone = () => `0165${String(++n).padStart(7, "0")}`;

/** A class of `capacity` places, all taken by people who can be cancelled one by one. */
async function fullClass(capacity: number) {
  const studio = await createCourt({ venueId, name: `Several Studio ${++seq}`, sport: "gym", offPeakRate: 5, peakRate: 8, capacity: 40 });
  if (!studio.ok) throw new Error("studio");
  const made = await createClassSessions({
    courtId: studio.court.id,
    name: `Several Spin ${seq}`,
    instructor: "Ravi",
    date: addDays(todayISO(), 5),
    startHour: 18,
    endHour: 19,
    capacity,
    price: 30,
  });
  if (!made.ok) throw new Error(made.error);
  const classId = made.classes[0].id;
  const holders: { phone: string; code: string }[] = [];
  for (let i = 0; i < capacity; i++) {
    const ph = phone();
    const r = await enrolInClass({ classId, name: `Holder ${i}`, phone: ph });
    if (!r.ok) throw new Error("enrol");
    holders.push({ phone: ph, code: r.booking.code });
  }
  return { classId, holders };
}

const wait = async (classId: number, name: string, places = 1) => {
  const ph = phone();
  const r = await joinClassWaitlist({ classId, name, phone: ph });
  if (!r.ok) throw new Error(`join ${name}: ${r.error}`);
  if (places > 1) await getDb().prepare("UPDATE waitlist SET places = ? WHERE id = ?").run(places, r.entry.id);
  return ph;
};
/** The offers standing for these people, with the links they claim by. */
const offersOf = async (phones: string[]) =>
  (await Promise.all(phones.map((p) => listWaitlistFor(p)))).flat().filter((e) => e.status === "offered");
const statuses = async (classId: number) => Object.fromEntries((await listClassWaitlist(classId)).map((e) => [e.name, e.status]));

describe("several places free in a class", () => {
  it("offers as many waiting entries as there are free places, one place each, in turn", async () => {
    const { classId, holders } = await fullClass(4);
    for (const name of ["A", "B", "C", "D", "E"]) await wait(classId, name);
    // Three places come free, one after the other: each is offered as it frees (the first, then the next ...).
    for (let i = 0; i < 3; i++) expect((await adminCancelBooking(holders[i].code)).ok).toBe(true);
    expect(await statuses(classId)).toEqual({ A: "offered", B: "offered", C: "offered", D: "waiting", E: "waiting" });
    // Exactly the free places are promised, no more.
    expect(await classOfferHolds(classId)).toBe(3);
    // Another place frees: the next waiting entry.
    expect((await adminCancelBooking(holders[3].code)).ok).toBe(true);
    expect(await statuses(classId)).toEqual({ A: "offered", B: "offered", C: "offered", D: "offered", E: "waiting" });
    expect(await classOfferHolds(classId)).toBe(4);
  });

  it("each offer is a place nobody else can take while it stands, and every offer can be claimed", async () => {
    const { classId, holders } = await fullClass(3);
    const phones = [await wait(classId, "A"), await wait(classId, "B"), await wait(classId, "C")];
    for (const h of holders.slice(0, 2)) await adminCancelBooking(h.code);
    expect(await statuses(classId)).toMatchObject({ A: "offered", B: "offered", C: "waiting" });
    // A stranger enrolling directly meets two places held for the list: the class is full to them.
    expect((await enrolPeople({ classId, name: "Stranger", phone: phone(), people: [null] })).ok).toBe(false);
    expect((await getClass(classId))!.enrolled).toBe(1);
    // Both claim, in either order, and both are enrolled.
    const offers = await offersOf(phones);
    expect(offers).toHaveLength(2);
    const results = await Promise.all(offers.map((o) => claimWaitlistOffer(o.offerToken!)));
    expect(results.every((r) => r.ok)).toBe(true);
    expect((await getClass(classId))!.enrolled).toBe(3);
    expect(await classOfferHolds(classId)).toBe(0);
    // The one still waiting is not offered a place that is not there.
    expect(await statuses(classId)).toMatchObject({ C: "waiting" });
  });

  it("an entry for two places is offered two, one that does not fit waits, and the places are never over-promised", async () => {
    const { classId, holders } = await fullClass(3);
    await wait(classId, "Pair", 2);
    await wait(classId, "Other pair", 2);
    await wait(classId, "Single");
    for (const h of holders) await adminCancelBooking(h.code);
    // Three free: the pair takes two, the second pair does not fit in the one left, the single does.
    expect(await statuses(classId)).toEqual({ Pair: "offered", "Other pair": "waiting", Single: "offered" });
    expect(await classOfferHolds(classId)).toBe(3);
  });

  it("two places freed at the same moment promise two places, not four", async () => {
    const { classId, holders } = await fullClass(2);
    const phones: string[] = [];
    for (const name of ["A", "B", "C", "D"]) phones.push(await wait(classId, name));
    await Promise.all(holders.map((h) => adminCancelBooking(h.code)));
    const s = await statuses(classId);
    expect(Object.values(s).filter((v) => v === "offered")).toHaveLength(2);
    expect(await classOfferHolds(classId)).toBe(2);
    // Asking for offers again, many times at once, adds none.
    await Promise.all(Array.from({ length: 5 }, () => offerClassPlace(classId)));
    expect(await classOfferHolds(classId)).toBe(2);
    expect(Object.values(await statuses(classId)).filter((v) => v === "offered")).toHaveLength(2);
    // Both offers can be claimed: the count held back for the other never makes either refuse.
    const offers = await offersOf(phones);
    expect(offers).toHaveLength(2);
    const claimed = await Promise.all(offers.map((o) => claimWaitlistOffer(o.offerToken!)));
    expect(claimed.every((r) => r.ok)).toBe(true);
    expect((await getClass(classId))!.enrolled).toBe(2);
  });

  it("offers that lapse pass to the next entries, again only as many as there are free places", async () => {
    const { classId, holders } = await fullClass(2);
    for (const name of ["A", "B", "C", "D"]) await wait(classId, name);
    for (const h of holders) await adminCancelBooking(h.code);
    expect(Object.values(await statuses(classId)).filter((v) => v === "offered")).toHaveLength(2);
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + (WAITLIST_OFFER_MINUTES + 1) * 60_000));
    await passOnExpiredOffers();
    // Back to the real clock before reading: on Postgres the offers just made are stamped by the database's own.
    vi.useRealTimers();
    const after = await statuses(classId);
    // A and B lapsed (they leave the list); C and D hold the two places now.
    expect(after).toEqual({ C: "offered", D: "offered" });
    expect(await classOfferHolds(classId)).toBe(2);
  });

  it("one place free still offers one: the single-place case is as it was", async () => {
    const { classId, holders } = await fullClass(3);
    await wait(classId, "A");
    await wait(classId, "B");
    await adminCancelBooking(holders[0].code);
    expect(await statuses(classId)).toEqual({ A: "offered", B: "waiting" });
  });
});
