import fs from "fs";
import path from "path";
import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { getDb } from "../src/lib/db";
import { grantLoyalty, grantLoyaltyIfDue, setLoyalty } from "../src/lib/loyalty";
import { createBooking, createCourt, createVenue, setPaymentStatus } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { moveBookingToDate } from "./helpers/bookings";

/**
 * Hardening round G19 (ADR 0066, migration 0320): a free hour for regulars is given once however the grant is run: twice in a
 * row, twice at once (two instances, a lease lost mid-run), with several hours due, or stopped part way. The guard is the
 * database's unique (venue, number, place), not a marker or a lock in memory.
 */
let venueId: number;
let courtId: number;
let slot = 0;

/** `hours` paid, played hours for this number, each a distinct court slot, moved into the past. */
async function playedHours(phone: string, hours: number, name = "Regular") {
  for (let i = 0; i < hours; i++) {
    const n = slot++;
    const b = await createBooking({
      courtId,
      date: addDays(todayISO(), 2 + Math.floor(n / 14)),
      hours: [8 + (n % 14)],
      name,
      phone,
      email: "regular@example.my",
    });
    if (!b.ok) throw new Error(JSON.stringify(b));
    expect((await setPaymentStatus(b.booking.code, true, "cash")).ok).toBe(true);
    await moveBookingToDate(b.booking.id, addDays(todayISO(), -3 - Math.floor(n / 14)));
  }
}

const count = async (sql: string, ...p: unknown[]) => Number(((await getDb().prepare(sql).get(...p)) as { n: number | string }).n);
const rewards = () => count("SELECT COUNT(*) AS n FROM loyalty_rewards WHERE venue_id = ?", venueId);
const freePasses = (phone?: string) =>
  phone
    ? count("SELECT COUNT(*) AS n FROM passes WHERE venue_id = ? AND name = 'Loyalty: one free hour' AND holder_phone = ?", venueId, phone)
    : count("SELECT COUNT(*) AS n FROM passes WHERE venue_id = ? AND name = 'Loyalty: one free hour'", venueId);
const mails = () => count("SELECT COUNT(*) AS n FROM messages WHERE kind = 'loyalty_reward' AND venue_id = ?", venueId);
const phoneKeyOf = async (phone: string) =>
  ((await getDb().prepare("SELECT phone_key FROM bookings WHERE phone = ? LIMIT 1").get(phone)) as { phone_key: string }).phone_key;

beforeAll(async () => {
  const v = await createVenue({ name: "Loyal Hall", area: "PJ", address: "1", phone: "0312345600", openHour: 7, closeHour: 23 });
  if (!v.ok) throw new Error("venue");
  venueId = v.venue.id;
  const c = await createCourt({ venueId, name: "C1", sport: "badminton", offPeakRate: 30, peakRate: 30 });
  if (!c.ok) throw new Error("court");
  courtId = c.court.id;
  expect((await setLoyalty(venueId, 5)).ok).toBe(true);
});

describe("the free hour is given once", () => {
  it("run twice in a row gives one pass for five hours played", async () => {
    await playedHours("0191230001", 5);
    expect(await grantLoyalty()).toBe(1);
    expect(await grantLoyalty()).toBe(0);
    expect(await freePasses("0191230001")).toBe(1);
    expect(await rewards()).toBe(1);
    expect(await mails()).toBe(1);
    // The reward is tied to its pass and carries its place.
    const row = (await getDb().prepare("SELECT n, pass_id FROM loyalty_rewards WHERE venue_id = ?").get(venueId)) as { n: number; pass_id: number | null };
    expect(row.n).toBe(1);
    expect(row.pass_id).not.toBeNull();
  });

  it("run twice at once (two instances, or a lease lost mid-run) gives one pass, one reward and one email", async () => {
    await playedHours("0191230002", 5);
    const before = { passes: await freePasses(), rewards: await rewards(), mail: await mails() };
    const ran = await Promise.all([grantLoyaltyIfDue(), grantLoyaltyIfDue(), grantLoyalty(), grantLoyalty()]);
    expect(ran.reduce((a, b) => a + b, 0)).toBe(1);
    expect(await freePasses()).toBe(before.passes + 1);
    expect(await rewards()).toBe(before.rewards + 1);
    expect(await mails()).toBe(before.mail + 1);
    expect(await freePasses("0191230002")).toBe(1);
  });

  it("with two hours due, racing runs give exactly two, in places 1 and 2", async () => {
    await playedHours("0191230003", 10);
    await Promise.all([grantLoyalty(), grantLoyalty(), grantLoyalty()]);
    expect(await freePasses("0191230003")).toBe(2);
    const places = (await getDb().prepare("SELECT n FROM loyalty_rewards WHERE venue_id = ? AND phone_key = ? ORDER BY n").all(venueId, await phoneKeyOf("0191230003"))) as { n: number }[];
    expect(places.map((r) => r.n)).toEqual([1, 2]);
    expect(await grantLoyalty()).toBe(0);
  });

  it("an hour earned later is still given: the next place, not a refusal", async () => {
    await playedHours("0191230003", 5);
    expect(await grantLoyalty()).toBe(1);
    expect(await freePasses("0191230003")).toBe(3);
  });

  it("the database itself refuses a second reward for the same place", async () => {
    const key = await phoneKeyOf("0191230001");
    await expect(getDb().prepare("INSERT INTO loyalty_rewards (venue_id, phone_key, n) VALUES (?, ?, 1)").run(venueId, key)).rejects.toMatchObject({ code: "23505" });
    // Insert-or-ignore says so without an error.
    const ignored = await getDb()
      .prepare("INSERT INTO loyalty_rewards (venue_id, phone_key, n) VALUES (?, ?, 1) ON CONFLICT (venue_id, phone_key, n) DO NOTHING")
      .run(venueId, key);
    expect(ignored.changes).toBe(0);
  });

  it("a pass that cannot be issued leaves no reward, and the next run gives it (a stop in between loses nothing)", async () => {
    await playedHours("0191230004", 5, "R");
    const before = { passes: await freePasses(), rewards: await rewards() };
    expect(await grantLoyalty()).toBe(0);
    expect(await freePasses()).toBe(before.passes);
    expect(await rewards()).toBe(before.rewards);
    await getDb().prepare("UPDATE bookings SET name = 'Regular Two' WHERE phone = ?").run("0191230004");
    expect(await grantLoyalty()).toBe(1);
    expect(await freePasses("0191230004")).toBe(1);
    expect(await rewards()).toBe(before.rewards + 1);
  });
});

describe("the reconciliation script (scripts/reconcile-loyalty.sql)", () => {
  const statements = fs
    .readFileSync(path.join(__dirname, "..", "scripts", "reconcile-loyalty.sql"), "utf8")
    .split("\n")
    .filter((l) => !l.trim().startsWith("--"))
    .join("\n")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

  it("is read only, lists a number given more than it earned and a free-hour pass nothing records, and not an honest one", async () => {
    expect(statements).toHaveLength(2);
    for (const s of statements) expect(s).toMatch(/^(WITH|SELECT)\b/);
    const db = getDb();
    const honest = await phoneKeyOf("0191230001");
    // A legacy duplicate: a second reward row for hours that earned one.
    const dup = await phoneKeyOf("0191230002");
    await db.prepare("INSERT INTO loyalty_rewards (venue_id, phone_key, n) VALUES (?, ?, 99)").run(venueId, dup);
    const before = { rewards: await rewards(), passes: await freePasses(), entries: await count("SELECT COUNT(*) AS n FROM pass_entries") };
    const listed = (await db.prepare(statements[0]).all()) as { phone_key: string; rewards_given: number | string; earned_now: number | string }[];
    expect(listed.map((r) => r.phone_key)).toContain(dup);
    expect(listed.map((r) => r.phone_key)).not.toContain(honest);
    const row = listed.find((r) => r.phone_key === dup)!;
    expect(Number(row.rewards_given)).toBe(2);
    expect(Number(row.earned_now)).toBe(1);

    await db
      .prepare("INSERT INTO passes (code, venue_id, name, entries, price, holder_name, holder_phone, expires_on) VALUES ('PS-ORPHAN1', ?, 'Loyalty: one free hour', 1, 0, 'Orphan', '0191230099', ?)")
      .run(venueId, addDays(todayISO(), 30));
    const orphans = (await db.prepare(statements[1]).all()) as { code: string }[];
    expect(orphans.map((o) => o.code)).toEqual(["PS-ORPHAN1"]);
    // Running the two statements changed nothing (the one pass added above is all there is to add).
    expect(await rewards()).toBe(before.rewards);
    expect(await freePasses()).toBe(before.passes + 1);
    expect(await count("SELECT COUNT(*) AS n FROM pass_entries")).toBe(before.entries);
  });
});
