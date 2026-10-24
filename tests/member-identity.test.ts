import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { eligible, setAccessSettings } from "../src/lib/access";
import { authenticateAdmin, ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { registerUser } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { houseRuleRefusal } from "../src/lib/house-rules";
import { createBooking, createCourt, createVenue, joinSlotWaitlist, listWaitlistForAccount, quoteFor, sellMembership } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * A phone number is not identity. Online, a membership found by a number
 * gives its rate, its longer window and entry to a members-only venue only to
 * the account it is linked to, or to the account whose own number it is,
 * proved with a code. Staff at the counter take the number on their word, as
 * they see the person.
 */

const MEMBER = "0197001000";
let venueId: number;
let courtId: number;
let adminId: number;
let hour = 8;
let n = 0;
const date = addDays(todayISO(), 3);

async function account(phone: string, proved = false): Promise<number> {
  const made = await registerUser({ name: "Player", email: `p${++n}@identity.my`, phone, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  if (proved) await getDb().prepare("UPDATE users SET verified_phone = ?, phone_verified_at = datetime('now') WHERE id = ?").run(phone, made.user.id);
  return made.user.id;
}

const price = async (input: { userId?: number; by?: "customer" | "staff" }) => {
  const made = await createBooking({ courtId, date, hours: [hour++], name: "Mei", phone: MEMBER, ...input });
  if (!made.ok) throw new Error(made.error);
  return made.booking.totalPrice;
};

beforeAll(async () => {
  await ensureBootstrapAdmin();
  adminId = (await authenticateAdmin("admin@mysenam.my", "mysenam-admin"))!.id;
  const made = await createVenue({ name: "Members Club", area: "Seremban", address: "x", phone: "0366660000", openHour: 7, closeHour: 23 });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  const court = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 20, peakRate: 20, capacity: 1 });
  if (!court.ok) throw new Error(court.error);
  courtId = court.court.id;
  await getDb().prepare("UPDATE courts SET member_off_peak_rate = 8, member_peak_rate = 8 WHERE id = ?").run(courtId);
  // Sold at the counter, to a number, linked to no account.
  const sold = await sellMembership({ venueId, holderName: "Mei", holderPhone: MEMBER, startsOn: todayISO(), expiresOn: addDays(todayISO(), 90), price: 100, adminId });
  if (!sold.ok) throw new Error(sold.error);
});

describe("a member's number, online", () => {
  it("gives a guest who types it the public rate; the counter, the member's", async () => {
    expect(await price({ by: "customer" })).toBe(20);
    expect(await price({ by: "staff" })).toBe(8);
  });

  it("gives an account whose number it is only once the account has proved it", async () => {
    const unproved = await account(MEMBER);
    expect(await price({ by: "customer", userId: unproved })).toBe(20);
    const proved = await account(MEMBER, true);
    expect(await price({ by: "customer", userId: proved })).toBe(8);
    // The quote says the same as the booking would.
    const quoted = await quoteFor({ courtId, date, start: 20 * 60, end: 21 * 60, phone: MEMBER, userId: unproved, by: "customer" });
    expect(quoted.ok && quoted.quote.total).toBe(20);
  });

  it("gives the account a membership is linked to, proved or not", async () => {
    const linked = await account("0197001999");
    const sold = await sellMembership({ venueId, holderName: "Lin", holderPhone: "0197001999", startsOn: todayISO(), expiresOn: addDays(todayISO(), 90), price: 100, adminId, userId: linked });
    if (!sold.ok) throw new Error(sold.error);
    const made = await createBooking({ courtId, date, hours: [hour++], name: "Lin", phone: "0197001999", by: "customer", userId: linked });
    expect(made.ok && made.booking.totalPrice).toBe(8);
  });

  it("lets only a proved or linked account into a members-only venue", async () => {
    await setAccessSettings(venueId, { access: "members" });
    expect(await eligible(venueId, await account(MEMBER))).toBe(false);
    expect(await eligible(venueId, await account(MEMBER, true))).toBe(true);
    await setAccessSettings(venueId, { access: "public" });
  });

  it("gives the member's longer window online only to a proved or linked number", async () => {
    await getDb().prepare("UPDATE venues SET book_ahead_days = 7, member_ahead_days = 14 WHERE id = ?").run(venueId);
    const far = [addDays(todayISO(), 10)];
    expect(await houseRuleRefusal({ venueId, phone: MEMBER, dates: far, online: true })).toMatchObject({ code: "LIMIT_AHEAD_MEMBERS" });
    expect(await houseRuleRefusal({ venueId, phone: MEMBER, userId: await account(MEMBER, true), dates: far, online: true })).toBeNull();
    // At the counter, the number on staff's word.
    expect(await houseRuleRefusal({ venueId, phone: MEMBER, dates: far })).toBeNull();
  });
});

describe("a number on an account's own lists", () => {
  it("shows an account the waiting-list places it joined, or that are on its proved number, not every place on a number it typed", async () => {
    const taken = await createBooking({ courtId, date, hours: [22], name: "Holder", phone: "0197002000" });
    if (!taken.ok) throw new Error(taken.error);
    // Somebody queues as a guest with this number.
    expect((await joinSlotWaitlist({ courtId, date, startHour: 22, endHour: 23, name: "Real owner", phone: "0197003000" })).ok).toBe(true);
    const typedIt = await account("0197003000");
    expect(await listWaitlistForAccount(typedIt)).toEqual([]);
    const provedIt = await account("0197003000", true);
    expect(await listWaitlistForAccount(provedIt)).toHaveLength(1);
    // What an account joined itself is its own, whatever its number.
    const own = await account("0197004000");
    expect((await joinSlotWaitlist({ courtId, date, startHour: 22, endHour: 23, name: "Own", phone: "0197004000", userId: own })).ok).toBe(true);
    expect(await listWaitlistForAccount(own)).toHaveLength(1);
  });
});
