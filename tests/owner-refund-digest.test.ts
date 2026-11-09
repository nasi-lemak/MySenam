import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { createAdmin, ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { recentAlerts } from "../src/lib/alerts";
import {
  COUNTER_OWED_DIGEST_HOUR,
  OWNER_DIGEST_KEY,
  REFUND_OVERDUE_DAYS,
  ownerDigestMail,
  ownerRefundSummary,
  sendCounterOwedDigests,
  sendOwnerRefundDigest,
} from "../src/lib/counter-owed-visibility";
import { oweCounter, settleOwed } from "../src/lib/counter-refunds";
import { getDb } from "../src/lib/db";
import { emailHealth } from "../src/lib/email-health";
import { drainOutbox, setTransport } from "../src/lib/outbox";
import { money } from "../src/lib/region";
import { runScheduledWork } from "../src/lib/scheduler";
import { staffTranslator } from "../src/lib/staff-i18n";
import { createBooking, createCourt, createVenue, setPaymentStatus } from "../src/lib/store";
import { addDays, installZone, todayISO } from "../src/lib/time";

/**
 * The platform owners' daily refund summary (ADR 0079): one message per owner per platform day (the install's zone, Asia/Kuala_Lumpur here) from
 * 09:00, through the same outbox and scheduler as the venues' own daily message, with every venue's counter refunds owed back and payments to check,
 * split into what is the venue's to hand back and what needs the platform. Counts, sums, ages and venue names only.
 *
 * The outbox's transport is stood in for: this proves what is queued, its key, retries and giving up, not that a message reaches an inbox (email
 * stays unverified live).
 */

const PRICE = 20;
const CUSTOMER = { name: "Customer Secretname", email: "secret.customer@private.example" };
let venueA: number;
let venueB: number;
let venueC: number;
let courtA: number;
let courtB: number;
let courtC: number;
let owner1: string;
const owner2 = "second.owner@platform.my";
const managerA = "mgr@alpha.my";
const managerB = "mgr@bravo.my";
let n = 0;
let slot = 0;

/** A moment at a wall-clock hour (and minute) on a day in Malaysia (UTC+8, no daylight saving). */
const myt = (day: string, hour: number, minute = 0) => {
  const [y, m, d] = day.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d, hour - 8, minute));
};
const DAY1 = "2031-05-12";
const DAY2 = "2031-05-13";

const codes: string[] = [];

/** A booking paid at the counter at a venue, then cancelled by the venue (a closure): owed back. `ageDays` before `base`. Returns the owed row. */
async function owe(court: number, ageDays: number, base: number): Promise<number> {
  const i = slot++;
  const made = await createBooking({
    courtId: court,
    date: addDays(todayISO(), 2 + (i % 10)),
    hours: [6 + Math.floor(i / 10)],
    name: CUSTOMER.name,
    phone: `0175${String(++n).padStart(7, "0")}`,
    email: CUSTOMER.email,
  });
  if (!made.ok) throw new Error(made.error);
  codes.push(made.booking.code);
  const paid = await setPaymentStatus(made.booking.code, true, "cash");
  if (!paid.ok) throw new Error(paid.error);
  expect(await oweCounter(made.booking.id, "closure")).toBe(true);
  const row = (await getDb().prepare("SELECT id FROM counter_refunds_owed WHERE booking_id = ?").get(made.booking.id)) as { id: number };
  await getDb().prepare("UPDATE counter_refunds_owed SET owed_since = ? WHERE id = ?").run(new Date(base - ageDays * 86_400_000).toISOString(), row.id);
  return row.id;
}

let bill = 0;
/** An online payment on the venue's list Payments to check. */
async function toCheck(venueId: number): Promise<void> {
  await getDb()
    .prepare("INSERT INTO online_payments (provider, bill_id, url, venue_id, amount, payer_name, payer_phone, settlement_issue) VALUES ('billplz', ?, 'https://pay.example/x', ?, 20, ?, '0123456789', 'underpaid')")
    .run(`digest-bill-${++bill}`, venueId, CUSTOMER.name);
}

const ownerRows = async () =>
  (await getDb().prepare("SELECT recipient, dedupe_key, status, body, params FROM messages WHERE dedupe_key LIKE ? ORDER BY dedupe_key").all(`${OWNER_DIGEST_KEY}:%`)) as {
    recipient: string;
    dedupe_key: string;
    status: string;
    body: string;
    params: string;
  }[];
/** The text of an owner's queued summary as it will be sent. */
const textOf = (row: { params: string }) => {
  const p = JSON.parse(row.params) as { subject: string; text: string };
  return `${p.subject}\n${p.text}`;
};
const settler = { id: 1, name: "Mara", role: "manager" as const };
/** Queued under the fixed test day (the outbox stamps its times from this process's clock): due now that the clock is real again. */
const dueNow = () => getDb().prepare("UPDATE messages SET next_attempt_at = datetime('now', '-1 minute') WHERE status IN ('queued', 'failed')").run();
/** Settled by a manager as staff settle it (`settleOwed`), at a moment inside the fixed test day (the database stamps its own clock's now). */
async function settledAt(id: number, at: number): Promise<void> {
  expect((await settleOwed(id, "back", settler)).ok).toBe(true);
  await getDb().prepare("UPDATE counter_refunds_owed SET settled_at = ? WHERE id = ?").run(new Date(at).toISOString(), id);
}

beforeAll(async () => {
  await ensureBootstrapAdmin();
  owner1 = ((await getDb().prepare("SELECT email FROM admins WHERE venue_id IS NULL AND business_id IS NULL ORDER BY id LIMIT 1").get()) as { email: string }).email;
  const second = await createAdmin({ name: "Second Owner", email: owner2, password: "a-long-password-1", venueId: null });
  if (!second.ok) throw new Error(second.error);
  const made = await Promise.all([
    createVenue({ name: "Alpha Arena", area: "PJ", address: "x", phone: "0300000581", openHour: 6, closeHour: 23 }),
    createVenue({ name: "Bravo Barn", area: "Klang", address: "y", phone: "0300000582", openHour: 6, closeHour: 23 }),
    createVenue({ name: "Charlie Courts", area: "Ipoh", address: "z", phone: "0300000583", openHour: 6, closeHour: 23 }),
  ]);
  for (const v of made) if (!v.ok) throw new Error("venue");
  [venueA, venueB, venueC] = made.map((v) => (v.ok ? v.venue.id : 0));
  const courts = await Promise.all(
    [venueA, venueB, venueC].map((venueId, i) => createCourt({ venueId, name: `Court ${i}`, sport: "badminton", offPeakRate: PRICE, peakRate: PRICE }))
  );
  [courtA, courtB, courtC] = courts.map((c) => (c.ok ? c.court.id : 0));
  for (const [venueId, email] of [
    [venueA, managerA],
    [venueB, managerB],
  ] as const) {
    const m = await createAdmin({ name: `Manager ${email}`, email, password: "a-long-password-1", venueId });
    if (!m.ok) throw new Error(m.error);
  }
  // Venue C has front desk only: nobody there is written the venue's own daily message.
  const desk = await createAdmin({ name: "Desk C", email: "desk@charlie.my", password: "a-long-password-1", venueId: venueC, role: "desk" });
  if (!desk.ok) throw new Error(desk.error);
});

beforeEach(async () => {
  await getDb().prepare("DELETE FROM messages").run();
  await getDb().prepare("DELETE FROM system_alerts").run();
  await getDb().prepare("UPDATE counter_refunds_owed SET settled_at = now(), outcome = 'back', admin_name = 'cleanup' WHERE settled_at IS NULL").run();
  await getDb().prepare("UPDATE online_payments SET settlement_reviewed_at = datetime('now') WHERE settlement_issue IS NOT NULL AND settlement_reviewed_at IS NULL").run();
  // Owed and settled long ago, out of every window below.
  await getDb().prepare("UPDATE counter_refunds_owed SET owed_since = '2000-01-01T00:00:00Z', settled_at = '2000-01-02T00:00:00Z'").run();
});
afterEach(() => {
  vi.useRealTimers();
  setTransport(null);
});

describe("the platform owners' daily refund summary", () => {
  it("the platform day is Malaysia's: nothing before 09:00 MYT, once from 09:00, and the next MYT day (not the next UTC day) is a new one", async () => {
    expect(installZone()).toBe("Asia/Kuala_Lumpur");
    const base = myt(DAY1, 9).getTime();
    await owe(courtA, 1, base);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(myt(DAY1, COUNTER_OWED_DIGEST_HOUR - 1, 59));
    expect(await sendOwnerRefundDigest()).toMatchObject({ status: "before_hour", day: DAY1, queued: 0 });
    expect(await ownerRows()).toEqual([]);
    vi.setSystemTime(myt(DAY1, COUNTER_OWED_DIGEST_HOUR));
    expect(await sendOwnerRefundDigest()).toMatchObject({ status: "queued", day: DAY1, queued: 2 });
    expect((await ownerRows()).map((r) => r.dedupe_key)).toEqual([`${OWNER_DIGEST_KEY}:${DAY1}:${owner1.toLowerCase()}`, `${OWNER_DIGEST_KEY}:${DAY1}:${owner2}`].sort());
    // 23:30 MYT: the same platform day, already told.
    vi.setSystemTime(myt(DAY1, 23, 30));
    expect(await sendOwnerRefundDigest()).toMatchObject({ status: "already_queued", day: DAY1 });
    // 00:30 MYT the next day is 16:30 UTC the day before: a new platform day, before its hour (a UTC clock would call it DAY1 and past 09:00).
    vi.setSystemTime(myt(DAY2, 0, 30));
    expect(await sendOwnerRefundDigest()).toMatchObject({ status: "before_hour", day: DAY2 });
    vi.setSystemTime(myt(DAY2, 8, 59));
    expect(await sendOwnerRefundDigest()).toMatchObject({ status: "before_hour", day: DAY2 });
    vi.setSystemTime(myt(DAY2, 9, 0));
    expect(await sendOwnerRefundDigest()).toMatchObject({ status: "queued", day: DAY2, queued: 2 });
    expect(await ownerRows()).toHaveLength(4);
  });

  it("one venue, one manager: the owners get the venue's numbers, the window stated, and the venue's manager gets the venue's own message", async () => {
    const now = myt(DAY1, 10);
    await owe(courtA, 0.5, now.getTime());
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    expect(await sendCounterOwedDigests()).toEqual([venueA]);
    const result = await sendOwnerRefundDigest();
    expect(result.status).toBe("queued");
    expect(result.digest!.venues).toEqual([
      expect.objectContaining({ venueName: "Alpha Arena", open: 1, openAmount: PRICE, oldestDays: 0, overdue: 0, newlyOwed: 1, newlyOwedAmount: PRICE, settled: 0, paymentsToCheck: 0, managers: 1 }),
    ]);
    expect(result.digest!.from).toBe(new Date(now.getTime() - 24 * 3_600_000).toISOString());
    expect(result.digest!.to).toBe(now.toISOString());
    const text = textOf((await ownerRows())[0]);
    expect(text).toContain(`Daily refund summary ${DAY1}: 1 counter refunds waiting at the venues, 0 payments to check`);
    expect(text).toContain("Asia/Kuala_Lumpur");
    // The window, in Malaysian time: from 10:00 the day before to 10:00 today.
    expect(text).toMatch(new RegExp(`from 2031-05-11 10:00\\s?(am|AM)? to ${DAY1} 10:00\\s?(am|AM)?;`));
    expect(text).toContain("For the venue to hand back");
    expect(text).toContain(`Alpha Arena: 1 waiting (${money(PRICE)} in all), the oldest 0 days, 0 waiting ${REFUND_OVERDUE_DAYS} days or more.`);
    expect(text).toContain("Nothing needs the platform today.");
    // The venue's manager is written its own message, under its own key; the owners are not on it.
    const venueRows = (await getDb().prepare("SELECT recipient FROM messages WHERE dedupe_key LIKE 'counter-owed:%'").all()) as { recipient: string }[];
    expect(venueRows.map((r) => r.recipient)).toEqual([managerA]);
  });

  it("several venues: each venue's own line, the overdue, the payments to check and a venue nobody was told about need the platform; no customer detail", async () => {
    const now = myt(DAY1, 10);
    await owe(courtA, 0, now.getTime());
    await owe(courtA, REFUND_OVERDUE_DAYS + 1, now.getTime());
    await owe(courtC, 0.2, now.getTime());
    await toCheck(venueB);
    await toCheck(venueB);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    // The venues' own message: C has no manager, so it is not counted as told.
    expect((await sendCounterOwedDigests()).sort()).toEqual([venueA]);
    const result = await sendOwnerRefundDigest();
    expect(result.digest!.venues.map((v) => [v.venueName, v.open, v.overdue, v.paymentsToCheck, v.managers])).toEqual([
      ["Alpha Arena", 2, 1, 0, 1],
      ["Bravo Barn", 0, 0, 2, 1],
      ["Charlie Courts", 1, 0, 0, 0],
    ]);
    const rows = await ownerRows();
    expect(rows.map((r) => r.recipient).sort()).toEqual([owner1, owner2].sort());
    const text = textOf(rows[0]);
    const [, venuePart, platformPart] = text.split(/For the venue to hand back|For the platform to follow up/);
    expect(venuePart).toContain(`Alpha Arena: 2 waiting (${money(2 * PRICE)} in all), the oldest ${REFUND_OVERDUE_DAYS + 1} days, 1 waiting ${REFUND_OVERDUE_DAYS} days or more.`);
    expect(venuePart).toContain(`Charlie Courts: 1 waiting (${money(PRICE)} in all)`);
    expect(venuePart).not.toContain("Bravo Barn");
    expect(platformPart).toContain(`Alpha Arena: 1 waiting ${REFUND_OVERDUE_DAYS} days or more; ask the venue's managers to hand them back.`);
    expect(platformPart).toContain("Bravo Barn: 2 online payments to check");
    expect(platformPart).toContain("Charlie Courts: nobody at the venue was told");
    expect(platformPart).toContain("the money is still the venue's to hand back");
    // Never says the platform owes it; never a customer, a phone, an email or a booking code.
    expect(text).not.toMatch(/platform (owes|will pay|pays)/i);
    // A summary, not a change to undo: no "nothing needs doing if that is right" line.
    expect(text).not.toContain("Nothing needs doing if that is right");
    expect(text).toContain("This message settles nothing");
    for (const secret of [CUSTOMER.name, "Secretname", CUSTOMER.email, "0175", "0123456789", ...codes]) expect(text).not.toContain(secret);
  });

  it("several platform owners each get one, in their own language; nothing is sent to a front desk or another venue's staff", async () => {
    await getDb().prepare("UPDATE admins SET locale = 'ms' WHERE email = ?").run(owner2);
    const now = myt(DAY1, 11);
    await owe(courtB, 0, now.getTime());
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    await sendOwnerRefundDigest();
    const rows = await ownerRows();
    expect(rows.map((r) => r.recipient).sort()).toEqual([owner1, owner2].sort());
    expect(textOf(rows.find((r) => r.recipient === owner2)!)).toContain("Untuk dipulangkan oleh pusat");
    expect(textOf(rows.find((r) => r.recipient === owner1)!)).toContain("For the venue to hand back");
    const all = (await getDb().prepare("SELECT recipient FROM messages").all()) as { recipient: string }[];
    expect(all.map((r) => r.recipient)).not.toContain("desk@charlie.my");
    await getDb().prepare("UPDATE admins SET locale = NULL WHERE email = ?").run(owner2);
  });

  it("a platform owner is never also a venue's manager: one address, one account, so one message, the owners' (it holds every venue)", async () => {
    const clash = await createAdmin({ name: "Owner as manager", email: owner1.toUpperCase(), password: "a-long-password-1", venueId: venueA });
    expect(clash.ok).toBe(false);
    const now = myt(DAY1, 10);
    await owe(courtA, 0, now.getTime());
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    await sendCounterOwedDigests();
    await sendOwnerRefundDigest();
    const toOwner = (await getDb().prepare("SELECT dedupe_key FROM messages WHERE lower(recipient) = lower(?)").all(owner1)) as { dedupe_key: string }[];
    expect(toOwner.map((r) => r.dedupe_key)).toEqual([`${OWNER_DIGEST_KEY}:${DAY1}:${owner1.toLowerCase()}`]);
  });

  it("nothing outstanding anywhere and no payment to check: nothing is sent, even when refunds were settled in the window", async () => {
    const now = myt(DAY1, 10);
    const id = await owe(courtA, 0.5, now.getTime());
    await settledAt(id, now.getTime() - 3_600_000);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const result = await sendOwnerRefundDigest();
    expect(result.status).toBe("nothing_to_tell");
    expect(result.digest!.venues).toEqual([expect.objectContaining({ venueName: "Alpha Arena", open: 0, settled: 1, newlyOwed: 1 })]);
    expect(await ownerRows()).toEqual([]);
  });

  it("a refund settled before the summary is counted as settled in the window, not as waiting", async () => {
    const now = myt(DAY1, 10);
    // Owed a day and a half ago (before the window) and settled an hour ago (in it); another owed in the window and still waiting.
    const id = await owe(courtA, 1.5, now.getTime());
    await owe(courtA, 0.1, now.getTime());
    await settledAt(id, now.getTime() - 3_600_000);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const result = await sendOwnerRefundDigest();
    expect(result.digest!.venues[0]).toMatchObject({ open: 1, openAmount: PRICE, settled: 1, settledAmount: PRICE, newlyOwed: 1 });
    expect(textOf((await ownerRows())[0])).toContain(`1 newly owed (${money(PRICE)}), 1 settled (${money(PRICE)})`);
  });

  it("settled while it is being prepared: the numbers are one read, so the summary says it was waiting when read, and the next day's does not", async () => {
    const now = myt(DAY1, 10);
    const id = await owe(courtA, 0, now.getTime());
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const digest = await ownerRefundSummary();
    expect((await settleOwed(id, "back", settler)).ok).toBe(true);
    // What was read stays one consistent picture: the count, the sum and the age are of the same moment.
    const mail = ownerDigestMail(staffTranslator("en"), digest);
    expect(mail.body).toContain(`Alpha Arena: 1 waiting (${money(PRICE)} in all)`);
    vi.setSystemTime(myt(DAY2, 10));
    const next = await sendOwnerRefundDigest();
    expect(next.status).toBe("nothing_to_tell");
    expect(next.digest!.venues.find((v) => v.venueId === venueA)).toBeUndefined();
  });

  it("repeated and concurrent invocations queue one message per owner per day", async () => {
    const now = myt(DAY1, 10);
    await owe(courtA, 0, now.getTime());
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    const results = await Promise.all([sendOwnerRefundDigest(), sendOwnerRefundDigest(), sendOwnerRefundDigest()]);
    expect(results.every((r) => r.status === "queued" || r.status === "already_queued")).toBe(true);
    await sendOwnerRefundDigest();
    await runScheduledWork(new Date(), "short");
    expect((await ownerRows()).map((r) => r.recipient).sort()).toEqual([owner1, owner2].sort());
  });

  it("the scheduler's short unit runs it after the venues' own", async () => {
    const now = myt(DAY1, 10);
    await owe(courtB, 0, now.getTime());
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    await runScheduledWork(new Date(), "short");
    expect(await ownerRows()).toHaveLength(2);
    expect((await getDb().prepare("SELECT recipient FROM messages WHERE dedupe_key LIKE 'counter-owed:%'").all()).map((r) => (r as { recipient: string }).recipient)).toEqual([managerB]);
  });

  it("is queued, not sent: the outbox tries it, keeps it after a failure, sends it on the retry, and email health shows the failure without the address", async () => {
    const now = myt(DAY1, 10);
    await owe(courtA, 0, now.getTime());
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    expect((await sendOwnerRefundDigest()).status).toBe("queued");
    vi.useRealTimers();
    await dueNow();
    expect((await ownerRows()).map((r) => r.status)).toEqual(["queued", "queued"]);
    setTransport({
      name: "fake-down",
      send: async (m) => {
        throw new Error(`Throttling: rate exceeded sending to ${m.recipient}`);
      },
    });
    await drainOutbox();
    expect((await ownerRows()).map((r) => r.status)).toEqual(["failed", "failed"]);
    const health = await emailHealth({});
    expect(health.lastHour.failed).toBeGreaterThanOrEqual(2);
    const reasons = JSON.stringify(health.recentFailures);
    expect(reasons).toContain("staff_alert");
    expect(reasons).toContain("Throttling: rate exceeded sending to [address]");
    expect(reasons).not.toContain(owner2);
    // The provider is back: the retry sends it, once.
    const sent: string[] = [];
    setTransport({ name: "fake-up", send: async (m) => void sent.push(m.recipient) });
    await getDb().prepare("UPDATE messages SET next_attempt_at = datetime('now', '-1 minute') WHERE dedupe_key LIKE ?").run(`${OWNER_DIGEST_KEY}:%`);
    await drainOutbox();
    await drainOutbox();
    expect((await ownerRows()).map((r) => r.status)).toEqual(["sent", "sent"]);
    expect(sent.sort()).toEqual([owner1, owner2].sort());
  });

  it("a refusal that cannot be helped by retrying is abandoned, and counted as such", async () => {
    const now = myt(DAY1, 10);
    await owe(courtA, 0, now.getTime());
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    await sendOwnerRefundDigest();
    vi.useRealTimers();
    await dueNow();
    setTransport({
      name: "fake-refuses",
      send: async () => {
        throw Object.assign(new Error("MessageRejected: Email address is not verified."), { permanent: true });
      },
    });
    await drainOutbox();
    expect((await ownerRows()).map((r) => r.status)).toEqual(["abandoned", "abandoned"]);
    const health = await emailHealth({});
    expect(health.givenUp24h.total).toBe(2);
    expect(health.recentFailures[0]).toMatchObject({ kind: "staff_alert", status: "abandoned", count: 2 });
  });

  it("an owner with no address is skipped and counted; with no owner to tell, an alert shows it on System health", async () => {
    const now = myt(DAY1, 10);
    await owe(courtA, 0, now.getTime());
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    await getDb().prepare("UPDATE admins SET email = '' WHERE email = ?").run(owner2);
    try {
      const one = await sendOwnerRefundDigest();
      expect(one).toMatchObject({ status: "queued", queued: 1, noAddress: 1 });
      expect((await ownerRows()).map((r) => r.recipient)).toEqual([owner1]);
      expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM messages WHERE recipient = ''").get()) as { n: number }).n).toBe(0);
      await getDb().prepare("DELETE FROM messages").run();
      await getDb().prepare("UPDATE admins SET email = ' ' WHERE email = ?").run(owner1);
      const none = await sendOwnerRefundDigest();
      expect(none).toMatchObject({ status: "no_recipient", queued: 0, noAddress: 2 });
      expect(await ownerRows()).toEqual([]);
      expect((await recentAlerts()).map((a) => a.key)).toContain("owner-refunds:no-recipient");
    } finally {
      await getDb().prepare("UPDATE admins SET email = ? WHERE email = ''").run(owner2);
      await getDb().prepare("UPDATE admins SET email = ? WHERE email = ' '").run(owner1);
    }
  });

  it("cross-tenant: a venue's own message names only that venue; only the owners' summary names several", async () => {
    const now = myt(DAY1, 10);
    await owe(courtA, 0, now.getTime());
    await owe(courtB, 3, now.getTime());
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    await sendCounterOwedDigests();
    await sendOwnerRefundDigest();
    const venueMail = (await getDb().prepare("SELECT recipient, params FROM messages WHERE dedupe_key LIKE 'counter-owed:%'").all()) as { recipient: string; params: string }[];
    const forA = textOf(venueMail.find((m) => m.recipient === managerA)!);
    const forB = textOf(venueMail.find((m) => m.recipient === managerB)!);
    expect(forA).toContain("Alpha Arena");
    expect(forA).not.toMatch(/Bravo|Charlie/);
    expect(forB).toContain("Bravo Barn");
    expect(forB).not.toMatch(/Alpha|Charlie/);
    const ownerText = textOf((await ownerRows())[0]);
    expect(ownerText).toContain("Alpha Arena");
    expect(ownerText).toContain("Bravo Barn");
  });
});
