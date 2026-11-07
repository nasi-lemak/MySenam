import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { registerUser, type User } from "../src/lib/auth";
import { setCancelPolicy, strikesFor, struckOut } from "../src/lib/cancel-policy";
import { getDb } from "../src/lib/db";
import { saveProfile } from "../src/lib/player-profiles";
import { expiringSoon, EXPIRY_DAYS, lowPasses, strikeLines, tellExpiring, tellStrike } from "../src/lib/standing-notices";
import { createBooking, listVenues, setNoShow } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * D11 and G16 (hardening, ADR 0072) and D13: passes, memberships and vouchers about to end, passes nearly used, strikes and numbers at the
 * limit are on staff's list; account holders are written to once, by email, about a pass or membership ending and about a strike; and strikes
 * still follow the phone number (D13: the current behaviour, stated and tested; the owner's decision DEC-39 is open).
 */

let venueId: number;
let otherVenueId: number;
let courtId: number;
let n = 0;
let slot = 0;
const today = todayISO();

async function user(name = "Holder", over: { adult?: boolean } = {}): Promise<User> {
  n++;
  const made = await registerUser({ name: `${name} Lee ${n}`, email: `sn${n}@notice.my`, phone: `01250${String(n).padStart(5, "0")}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  if (over.adult !== undefined) await saveProfile(made.user.id, { adult: over.adult });
  return made.user;
}

async function pass(over: { venue?: number; userId?: number | null; entries?: number; used?: number; expiresInDays: number; ageDays?: number; name?: string }): Promise<number> {
  n++;
  const venue = over.venue ?? venueId;
  const id = ((await getDb()
    .prepare(
      `INSERT INTO passes (code, venue_id, name, entries, price, holder_name, holder_phone, user_id, expires_on, status, created_at)
       VALUES (?, ?, ?, ?, 50, 'Holder Lee', '0125000000', ?, ?, 'active', datetime('now', ?)) RETURNING id`
    )
    .get(`PS${n}X`, venue, over.name ?? "10 sessions", over.entries ?? 10, over.userId ?? null, addDays(today, over.expiresInDays), `-${over.ageDays ?? 30} days`)) as { id: number }).id;
  if (over.used) await getDb().prepare("INSERT INTO pass_entries (pass_id, delta, reason) VALUES (?, ?, 'used')").run(id, -over.used);
  return id;
}

async function membership(over: { userId?: number | null; expiresInDays: number; ageDays?: number; phone?: string }): Promise<number> {
  n++;
  return ((await getDb()
    .prepare(
      `INSERT INTO memberships (code, venue_id, holder_name, holder_phone, user_id, starts_on, expires_on, price, status, created_at)
       VALUES (?, ?, 'Member Lee', ?, ?, ?, ?, 100, 'active', datetime('now', ?)) RETURNING id`
    )
    .get(`MB${n}X`, venueId, over.phone ?? `0125${String(n).padStart(6, "0")}`, over.userId ?? null, addDays(today, -300), addDays(today, over.expiresInDays), `-${over.ageDays ?? 300} days`)) as { id: number }).id;
}

const mails = async (email: string, like = "expiring:%") =>
  (await getDb().prepare("SELECT kind, subject, body, locale, dedupe_key FROM messages WHERE recipient = ? AND dedupe_key LIKE ? ORDER BY id").all(email, like)) as {
    kind: string; subject: string; body: string; locale: string; dedupe_key: string;
  }[];

beforeAll(async () => {
  const venues = await listVenues();
  venueId = venues[0].id;
  otherVenueId = venues[1].id;
  courtId = venues[0].courts[0].id;
});

describe("what ends soon, for staff", () => {
  it("lists passes with entries left, memberships that will not renew and vouchers that end within two weeks, soonest first, by venue", async () => {
    const soon = await pass({ expiresInDays: 5, used: 4, name: "Soon pass" });
    const later = await pass({ expiresInDays: EXPIRY_DAYS, name: "Later pass" });
    await pass({ expiresInDays: EXPIRY_DAYS + 1, name: "Not yet" });
    await pass({ expiresInDays: -1, name: "Already over" });
    await pass({ expiresInDays: 4, entries: 3, used: 3, name: "Used up" });
    await pass({ expiresInDays: 3, venue: otherVenueId, name: "Elsewhere" });
    const ending = await membership({ expiresInDays: 6 });
    const renewed = await membership({ expiresInDays: 6, phone: "0125999999" });
    await membership({ expiresInDays: 60, phone: "0125999999" });
    const selfRenewing = await membership({ expiresInDays: 2 });
    await getDb().prepare("INSERT INTO membership_subscriptions (venue_id, provider, subscription_id, membership_id, status) VALUES (?, 'stripe', ?, ?, 'active')").run(venueId, `sub_${selfRenewing}`, selfRenewing);
    await getDb().prepare("INSERT INTO gift_vouchers (code, venue_id, amount, buyer_name, status, expires_on) VALUES ('GV-SOON', ?, 60, 'Buyer', 'active', ?)").run(venueId, addDays(today, 9));
    await getDb().prepare("INSERT INTO gift_vouchers (code, venue_id, amount, buyer_name, status, expires_on) VALUES ('GV-SPENT', ?, 60, 'Buyer', 'redeemed', ?)").run(venueId, addDays(today, 9));

    const here = await expiringSoon([venueId]);
    const names = here.map((x) => `${x.kind}:${x.what}`);
    expect(names).toContain("pass:Soon pass");
    expect(names).toContain("pass:Later pass");
    for (const gone of ["Not yet", "Already over", "Used up", "Elsewhere"]) expect(names.some((x) => x.endsWith(gone))).toBe(false);
    expect(here.find((x) => x.id === soon && x.kind === "pass")).toMatchObject({ left: 6, daysLeft: 5, told: false });
    expect(here.some((x) => x.kind === "membership" && x.id === ending)).toBe(true);
    expect(here.some((x) => x.kind === "membership" && x.id === renewed)).toBe(false);
    expect(here.some((x) => x.kind === "membership" && x.id === selfRenewing)).toBe(false);
    expect(here.filter((x) => x.kind === "voucher").map((x) => x.what)).toEqual(["GV-SOON"]);
    // Soonest first.
    expect(here.map((x) => x.daysLeft)).toEqual([...here.map((x) => x.daysLeft)].sort((a, b) => a - b));
    expect(here.findIndex((x) => x.id === soon && x.kind === "pass")).toBeLessThan(here.findIndex((x) => x.id === later && x.kind === "pass"));
    // Another venue's staff see theirs only; nobody sees nothing; the owner sees all.
    expect((await expiringSoon([otherVenueId])).map((x) => x.what)).toEqual(["Elsewhere"]);
    expect(await expiringSoon([])).toEqual([]);
    expect((await expiringSoon(null)).length).toBeGreaterThanOrEqual(here.length + 1);
  });

  it("lists passes down to their last entries", async () => {
    const one = await pass({ expiresInDays: 90, entries: 5, used: 4, name: "Last one" });
    const two = await pass({ expiresInDays: 90, entries: 5, used: 3, name: "Last two" });
    await pass({ expiresInDays: 90, entries: 5, used: 2, name: "Three left" });
    await pass({ expiresInDays: 90, entries: 5, used: 5, name: "None left" });
    await pass({ expiresInDays: -2, entries: 5, used: 4, name: "Ended" });
    const low = await lowPasses([venueId]);
    expect(low.filter((p) => [one, two].includes(p.id)).map((p) => p.left)).toEqual([1, 2]);
    expect(low.some((p) => ["Three left", "None left", "Ended"].includes(p.what))).toBe(false);
    expect(await lowPasses([otherVenueId])).toEqual([]);
  });
});

describe("telling a customer a pass or membership is ending", () => {
  it("writes once, to an account holder, in their language; not to guests, minors, young items, or what renews or is used up", async () => {
    await getDb().prepare("UPDATE passes SET status = 'void' WHERE status = 'active'").run();
    await getDb().prepare("UPDATE memberships SET status = 'void' WHERE status = 'active'").run();
    const holder = await user("Holder");
    await getDb().prepare("UPDATE users SET locale = 'zh' WHERE id = ?").run(holder.id);
    const teen = await user("Teen", { adult: false });
    const p1 = await pass({ userId: holder.id, expiresInDays: 6, entries: 8, used: 3, name: "Gold pass" });
    await pass({ userId: null, expiresInDays: 6, name: "Counter pass" });
    await pass({ userId: teen.id, expiresInDays: 6, name: "Teen pass" });
    await pass({ userId: holder.id, expiresInDays: 6, ageDays: 2, name: "Young pass" });
    await pass({ userId: holder.id, expiresInDays: 6, entries: 2, used: 2, name: "Used pass" });
    await pass({ userId: holder.id, expiresInDays: 40, name: "Far pass" });
    const m1 = await membership({ userId: holder.id, expiresInDays: 4 });

    expect(await tellExpiring(new Date(), true)).toBe(2);
    const sent = await mails(holder.email);
    expect(sent.map((m) => m.dedupe_key).sort()).toEqual([`expiring:membership:${m1}:${addDays(today, 4)}`, `expiring:pass:${p1}:${addDays(today, 6)}`].sort());
    expect(sent.every((m) => m.kind === "customer_notice" && m.locale === "zh")).toBe(true);
    const passMail = sent.find((m) => m.dedupe_key.startsWith("expiring:pass"))!;
    expect(passMail.body).toContain("Gold pass");
    expect(passMail.body).toContain("5");
    expect(passMail.body).toMatch(/[一-鿿]/);
    expect(passMail.body).not.toMatch(/ppl\./);
    expect(await mails(teen.email)).toHaveLength(0);
    // A second run, and a run on another server, write nothing more.
    expect(await tellExpiring(new Date(), true)).toBe(2);
    expect(await mails(holder.email)).toHaveLength(2);
    // The same run called again at once is held off by its own look-back too.
    expect(await tellExpiring(new Date())).toBe(0);

    // An extension is a new end date, so a new notice.
    await getDb().prepare("UPDATE passes SET expires_on = ? WHERE id = ?").run(addDays(today, 3), p1);
    await tellExpiring(new Date(), true);
    expect(await mails(holder.email)).toHaveLength(3);
  });
});

describe("strikes", () => {
  beforeAll(async () => {
    expect((await setCancelPolicy(venueId, { strikeLimit: 3, strikeDays: 90 })).ok).toBe(true);
  });

  async function missed(who: { name: string; phone: string; email?: string; userId?: number }, daysAgo = 1) {
    slot++;
    const made = await createBooking({
      courtId,
      date: addDays(today, 1 + (slot % 10)),
      hours: [8 + Math.floor(slot / 10)],
      name: who.name,
      phone: who.phone,
      email: who.email,
      userId: who.userId,
    });
    if (!made.ok) throw new Error(made.error);
    await getDb().prepare("UPDATE bookings SET date = ? WHERE id = ?").run(addDays(today, -daysAgo), made.booking.id);
    const done = await setNoShow(made.booking.code, true);
    if (!done.ok) throw new Error(done.error);
    return made.booking.code;
  }

  it("writes to the customer once with which strike it is, and when the limit is reached what happens; not where the venue counts none", async () => {
    const guest = { name: "Gina Lau", phone: "0125551001", email: "gina@guest.my" };
    const c1 = await missed(guest);
    expect(await tellStrike(c1)).toBe(true);
    expect(await tellStrike(c1)).toBe(true);
    let sent = await mails(guest.email, "strike:%");
    expect(sent).toHaveLength(1);
    expect(sent[0].kind).toBe("customer_notice");
    expect(sent[0].subject).toMatch(/missed booking/i);
    expect(sent[0].body).toMatch(/1 of the 3/);
    const c2 = await missed(guest);
    await tellStrike(c2);
    const c3 = await missed(guest);
    await tellStrike(c3);
    sent = await mails(guest.email, "strike:%");
    expect(sent).toHaveLength(3);
    expect(sent[2].subject).toMatch(/limit/i);
    expect(sent[2].body).toMatch(/pay online/i);
    expect((await struckOut(venueId, guest.phone)).out).toBe(true);

    // No address, a test booking, or a venue that counts none: nothing is written.
    const quiet = await missed({ name: "No Email", phone: "0125551002" });
    expect(await tellStrike(quiet)).toBe(false);
    await setCancelPolicy(venueId, { strikeLimit: null, strikeDays: 90 });
    const loud = await missed({ name: "Loud", phone: "0125551003", email: "loud@guest.my" });
    expect(await tellStrike(loud)).toBe(false);
    expect(await mails("loud@guest.my", "strike:%")).toHaveLength(0);
    await setCancelPolicy(venueId, { strikeLimit: 3, strikeDays: 90 });
  });

  it("writes to an account's own address in its language, and not to an account that said it is under 18", async () => {
    const adult = await user("Adult");
    await getDb().prepare("UPDATE users SET locale = 'ms' WHERE id = ?").run(adult.id);
    const teen = await user("Teen", { adult: false });
    const a = await missed({ name: adult.name, phone: adult.phone, email: "booking-address@guest.my", userId: adult.id });
    const t = await missed({ name: teen.name, phone: teen.phone, email: "teen-booking@guest.my", userId: teen.id });
    expect(await tellStrike(a)).toBe(true);
    expect(await tellStrike(t)).toBe(false);
    const sent = await mails(adult.email, "strike:%");
    expect(sent).toHaveLength(1);
    expect(sent[0].locale).toBe("ms");
    expect(sent[0].body).not.toMatch(/ppl\./);
    expect(await mails("booking-address@guest.my", "strike:%")).toHaveLength(0);
    expect(await mails(teen.email, "strike:%")).toHaveLength(0);
    expect(await mails("teen-booking@guest.my", "strike:%")).toHaveLength(0);
  });

  it("shows staff numbers with a strike lately and every number at the limit, by venue", async () => {
    const lines = await strikeLines([venueId]);
    const gina = lines.find((l) => l.phone === "0125551001")!;
    expect(gina).toMatchObject({ strikes: 3, limit: 3, out: true, name: "Gina", venueId });
    // A strike made lately but under the limit is shown; one made long ago and under the limit is not.
    const lately = await missed({ name: "Lately Tan", phone: "0125551004" }, 1);
    expect(lately).toBeTruthy();
    const long = await missed({ name: "Longago Tan", phone: "0125551005" }, 30);
    expect(long).toBeTruthy();
    const after = await strikeLines([venueId]);
    expect(after.find((l) => l.phone === "0125551004")).toMatchObject({ strikes: 1, out: false });
    expect(after.some((l) => l.phone === "0125551005")).toBe(false);
    expect(await strikeLines([otherVenueId])).toEqual([]);
    expect(await strikeLines([])).toEqual([]);
    // Forgiven strikes stop counting and stop being listed.
    const { forgiveStrikes } = await import("../src/lib/cancel-policy");
    await forgiveStrikes(venueId, "0125551001", null);
    expect((await strikeLines([venueId])).some((l) => l.phone === "0125551001")).toBe(false);
  });
});

describe("D13: standing is the phone number (DEC-39 is open: this is the behaviour as it is, not a decision)", () => {
  it("strikes follow the number, whoever booked: a new person on a recycled number starts with its strikes", async () => {
    const phone = "0125552001";
    for (let i = 0; i < 3; i++) {
      slot++;
      const made = await createBooking({ courtId, date: addDays(today, 1 + (slot % 10)), hours: [14 + Math.floor(slot / 10)], name: "Earlier Owner", phone });
      if (!made.ok) throw new Error(made.error);
      await getDb().prepare("UPDATE bookings SET date = ? WHERE id = ?").run(addDays(today, -1), made.booking.id);
      expect((await setNoShow(made.booking.code, true)).ok).toBe(true);
    }
    // A different person with an account, who has just taken the number, is struck out by what the earlier owner did.
    const newOwner = await user("New Owner");
    await getDb().prepare("UPDATE users SET phone = ? WHERE id = ?").run(phone, newOwner.id);
    expect(await strikesFor(venueId, phone)).toBe(3);
    expect(await strikesFor(venueId, "+60 12-555 2001")).toBe(3);
    expect(await strikesFor(venueId, "0125552002")).toBe(0);
    expect((await struckOut(venueId, phone)).out).toBe(true);
    // Strikes are venue-by-venue: the same number is not struck out at another venue.
    expect((await struckOut(otherVenueId, phone)).out).toBe(false);
  });
});
