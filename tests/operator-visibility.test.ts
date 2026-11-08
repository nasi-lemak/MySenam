import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

// Every email queued by an alert or a venue message is also noted here, to read what it says and to whom.
const sent: { to: string; subject: string; text: string; dedupeKey?: string }[] = [];
vi.mock("../src/lib/outbox", async (original) => {
  const real = await original<typeof import("../src/lib/outbox")>();
  return {
    ...real,
    emailPlain: async (input: Parameters<typeof real.emailPlain>[0]) => {
      const queued = await real.emailPlain(input);
      sent.push({ to: input.to, subject: input.subject, text: input.text, dedupeKey: input.dedupeKey });
      return queued;
    },
  };
});

import { NextRequest } from "next/server";
import { xSignature } from "../src/lib/billplz";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { HEARTBEAT_STALE_MINUTES, heartbeat, raiseAlert, recentAlerts, schedulerHeartbeat } from "../src/lib/alerts";
import { COUNTER_OWED_DIGEST_HOUR, REFUND_OVERDUE_DAYS, counterOwedSummary, sendCounterOwedDigests } from "../src/lib/counter-owed-visibility";
import { counterOwed, oweCounter, oweCounterToCustomer, settleOwed } from "../src/lib/counter-refunds";
import { getDb } from "../src/lib/db";
import { holdNewBookings, releaseExpiredHolds } from "../src/lib/holds";
import { PAYMENT_ALERT_EACH_MAX, reviewPayment } from "../src/lib/payment-settlement";
import { savePaymentSettings, startBookingPayment } from "../src/lib/payments";
import { runScheduledWork } from "../src/lib/scheduler";
import { createBooking, createCourt, createVenue, setPaymentStatus } from "../src/lib/store";
import { money } from "../src/lib/region";
import { addDays, todayISO } from "../src/lib/time";
import { GET as attentionGet } from "../src/app/api/admin/attention/route";
import { GET as healthGet } from "../src/app/api/health/route";
import { GET as systemGet } from "../src/app/api/admin/system/route";
import { POST as callbackRoute } from "../src/app/api/payments/[provider]/callback/route";

/**
 * The three operator-visibility gaps of the pilot (ADR 0076): the scheduler's heartbeat as a screen reading, a payment mismatch as an owner
 * alert, and counter payments owed back as a line in Needs attention and a daily message to managers.
 *
 * Billplz is never called: fetch is stood in for and callbacks are signed with the test key as Billplz signs them. That proves MySenam's
 * rules, not that Billplz sends these fields or that an alert email reaches an inbox (email and the gateway stay unverified live).
 */

const KEY = "S-vis-key";
const OTHER_KEY = "S-vis-other";
const COLLECTION = "colVis";
const PRICE = 20;
let venueA: number;
let venueB: number;
let courtA: number;
let courtB: number;
let ownerCookie: string;
let managerA: { cookie: string; email: string };
let managerB: { cookie: string; email: string };
let deskA: { cookie: string; email: string };
let deskB: { cookie: string };
let ownerEmail: string;
let n = 0;
let slot = 0;
let billNumber = 0;

const nextSlot = () => {
  const i = slot++;
  return { date: addDays(todayISO(), 2 + (i % 10)), hour: 6 + Math.floor(i / 10) };
};

function fakeBillplz() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      const id = `visbill${++billNumber}`;
      return Response.json({ id, url: `https://www.billplz-sandbox.com/bills/${id}` });
    })
  );
}

interface Made {
  bookingId: number;
  code: string;
  phone: string;
  billId: string;
  paymentId: number;
}

/** A held booking at a venue, and the payment page opened for it. */
async function pending(court: number, key: "A" | "B" = "A"): Promise<Made> {
  const phone = `0149${String(++n).padStart(7, "0")}`;
  const { date, hour } = nextSlot();
  const made = await createBooking({ courtId: court, date, hours: [hour], name: "Nadia Secret", phone, email: `nadia${n}@private.example` });
  if (!made.ok) throw new Error(made.error);
  await holdNewBookings([made.booking.id], 15);
  fakeBillplz();
  const started = await startBookingPayment({ codes: [made.booking.code], phone });
  if (!started.ok) throw new Error(started.error);
  vi.unstubAllGlobals();
  const row = (await getDb().prepare("SELECT id, bill_id FROM online_payments ORDER BY id DESC LIMIT 1").get()) as { id: number; bill_id: string };
  void key;
  return { bookingId: made.booking.id, code: made.booking.code, phone, billId: row.bill_id, paymentId: row.id };
}

const billplzTime = (d: Date) => `${d.toISOString().slice(0, 19).replace("T", " ")} +0000`;

function callbackBody(billId: string, o: { paidSen?: number; collection?: string; key?: string } = {}): string {
  const billed = PRICE * 100;
  const fields: Record<string, string> = {
    id: billId,
    collection_id: o.collection ?? COLLECTION,
    paid: "true",
    state: "paid",
    amount: String(billed),
    paid_amount: String(o.paidSen ?? billed),
    due_at: "2026-12-31",
    email: "",
    mobile: "60123456789",
    name: "NADIA SECRET",
    url: `https://www.billplz-sandbox.com/bills/${billId}`,
    paid_at: billplzTime(new Date()),
  };
  fields.x_signature = xSignature(fields, o.key ?? KEY);
  return new URLSearchParams(fields).toString();
}

const callback = (billId: string, o: { paidSen?: number; collection?: string; key?: string } = {}) =>
  callbackRoute(
    new NextRequest("http://localhost/api/payments/billplz/callback", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: callbackBody(billId, o),
    }),
    { params: Promise.resolve({ provider: "billplz" }) }
  );

const checkAlerts = async () => (await recentAlerts()).filter((a) => a.key.startsWith("payment:check:"));
const alertFor = async (paymentId: number) => (await recentAlerts()).find((a) => a.key === `payment:check:${paymentId}`);
/** Emails queued to the platform owner about it (one per alert told). */
const ownerMailsAbout = (word: string) => sent.filter((m) => m.to === ownerEmail && (m.subject.includes(word) || m.text.includes(word)));

async function manager(venueId: number, email: string, role?: "desk") {
  const made = await createAdmin({ name: `${role ?? "manager"} ${email}`, email, password: "a-long-password-1", venueId, ...(role ? { role } : {}) });
  if (!made.ok) throw new Error("admin");
  return { cookie: `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(made.admin.id)).token}`, email, id: made.admin.id };
}

beforeAll(async () => {
  await ensureBootstrapAdmin();
  const owner = (await getDb().prepare("SELECT id, email FROM admins WHERE venue_id IS NULL AND business_id IS NULL ORDER BY id LIMIT 1").get()) as { id: number; email: string };
  ownerEmail = owner.email;
  ownerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(owner.id)).token}`;
  const a = await createVenue({ name: "Alpha Arena", area: "PJ", address: "x", phone: "0300000481", openHour: 6, closeHour: 23 });
  const b = await createVenue({ name: "Bravo Barn", area: "Klang", address: "y", phone: "0300000482", openHour: 6, closeHour: 23 });
  if (!a.ok || !b.ok) throw new Error("venue");
  venueA = a.venue.id;
  venueB = b.venue.id;
  const ca = await createCourt({ venueId: venueA, name: "Court A", sport: "badminton", offPeakRate: PRICE, peakRate: PRICE });
  const cb = await createCourt({ venueId: venueB, name: "Court B", sport: "badminton", offPeakRate: PRICE, peakRate: PRICE });
  if (!ca.ok || !cb.ok) throw new Error("court");
  courtA = ca.court.id;
  courtB = cb.court.id;
  const savedA = await savePaymentSettings(venueA, { apiKey: "api-key-1234", collectionId: COLLECTION, xSignatureKey: KEY, sandbox: true, enabled: true });
  const savedB = await savePaymentSettings(venueB, { apiKey: "api-key-5678", collectionId: "colVisB", xSignatureKey: OTHER_KEY, sandbox: true, enabled: true });
  if (!savedA.ok || !savedB.ok) throw new Error("payment settings");
  managerA = await manager(venueA, "mara@alpha.my");
  managerB = await manager(venueB, "bram@bravo.my");
  deskA = await manager(venueA, "dara@alpha.my", "desk");
  deskB = await manager(venueB, "dev@bravo.my", "desk");
});

beforeEach(() => {
  sent.length = 0;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  delete process.env.MYSENAM_SCHEDULER;
});

/* ------------------------------------------------------------------------------------------ 1: the scheduler */

describe("1. the scheduler heartbeat is a reading on the owner's dashboard, and a missing one is never healthy", () => {
  const clearStamp = () => getDb().prepare("DELETE FROM settings WHERE key = 'scheduler_heartbeat'").run();
  const stampAgo = (minutes: number) =>
    getDb()
      .prepare("INSERT INTO settings (key, value) VALUES ('scheduler_heartbeat', datetime('now', ?)) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
      .run(`-${minutes} minutes`);
  /** A moment past this process's start-up grace, so only the stamp decides. */
  const later = () => Date.now() + 10 * 60_000;

  it("never stamped is its own state, not healthy; right after a start it is labelled 'starting', never healthy", async () => {
    await clearStamp();
    expect((await schedulerHeartbeat(true, later())).state).toBe("never");
    const now = await schedulerHeartbeat(true);
    expect(now.state).toBe("starting");
    expect(now).toMatchObject({ lastAt: null, ageSeconds: null });
  });

  it("is healthy when stamped within the limit, with the time since, and stale beyond it", async () => {
    await heartbeat();
    const fresh = await schedulerHeartbeat(true);
    expect(fresh.state).toBe("healthy");
    expect(fresh.ageSeconds).toBeLessThan(60);
    expect(new Date(fresh.lastAt!).getTime()).toBeGreaterThan(Date.now() - 60_000);

    await stampAgo(HEARTBEAT_STALE_MINUTES + 20);
    const stale = await schedulerHeartbeat(true, later());
    expect(stale.state).toBe("stale");
    expect(stale.ageSeconds).toBeGreaterThan(HEARTBEAT_STALE_MINUTES * 60);
    // A stale stamp in a process that has only just started is 'starting' (labelled), never healthy.
    expect((await schedulerHeartbeat(true)).state).toBe("starting");
  });

  it("is off when the scheduler is switched off, whatever the stamp says", async () => {
    await heartbeat();
    expect((await schedulerHeartbeat(false)).state).toBe("off");
  });

  it("names the newest outstanding scheduler failure, and nothing else's", async () => {
    await getDb().prepare("DELETE FROM system_alerts").run();
    expect((await schedulerHeartbeat(true)).lastFailure).toBeNull();
    await raiseAlert("disk:warn", "Disk filling", "x");
    expect((await schedulerHeartbeat(true)).lastFailure).toBeNull();
    await raiseAlert("scheduler:ratings-failed", "Scheduled work failed: ratings", "boom");
    const hb = await schedulerHeartbeat(true);
    expect(hb.lastFailure).toMatchObject({ key: "scheduler:ratings-failed", subject: "Scheduled work failed: ratings", count: 1 });
    await getDb().prepare("DELETE FROM system_alerts").run();
  });

  it("is in the owner's system answer beside the old fields, and /api/health keeps its contract", async () => {
    await clearStamp();
    process.env.MYSENAM_SCHEDULER = "on";
    const res = await systemGet(new NextRequest("http://localhost/api/admin/system", { headers: { cookie: ownerCookie } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scheduler: { enabled: boolean; alive: boolean; heartbeat: { state: string; lastAt: string | null } } };
    expect(body.scheduler).toMatchObject({ enabled: true, alive: true });
    // The old reading says alive (young process); the stricter reading says it has not heard from the scheduler.
    expect(body.scheduler.heartbeat).toMatchObject({ state: "starting", lastAt: null });
    const health = await healthGet();
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true });
    // Not for a venue's manager or the front desk: platform health is the owner's.
    expect((await systemGet(new NextRequest("http://localhost/api/admin/system", { headers: { cookie: managerA.cookie } }))).status).toBe(403);
    expect((await systemGet(new NextRequest("http://localhost/api/admin/system", { headers: { cookie: deskA.cookie } }))).status).toBe(403);
  });
});

/* ------------------------------------------------------------------------------------ 2: payment mismatches */

describe("2. a newly detected payment mismatch is one owner alert, keyed by payment", () => {
  beforeEach(async () => {
    await getDb().prepare("DELETE FROM system_alerts").run();
    // Every payment waiting on the list from an earlier test is checked, so each test counts its own.
    await getDb().prepare("UPDATE online_payments SET settlement_reviewed_at = datetime('now') WHERE settlement_issue IS NOT NULL AND settlement_reviewed_at IS NULL").run();
  });

  it("is the control: a payment that matches raises nothing", async () => {
    const m = await pending(courtA);
    expect((await callback(m.billId)).status).toBe(200);
    expect(await checkAlerts()).toEqual([]);
    expect(ownerMailsAbout("Payment")).toHaveLength(0);
  });

  it("a short payment alerts the owners once: venue and reference named, no customer detail, pointing at the list", async () => {
    const m = await pending(courtA);
    await callback(m.billId, { paidSen: 1200 });
    const alert = await alertFor(m.paymentId);
    expect(alert).toBeDefined();
    expect(alert!.count).toBe(1);
    expect(alert!.subject).toContain("Alpha Arena");
    const text = alert!.lastDetail!;
    expect(text).toContain(m.billId);
    expect(text).toContain("Alpha Arena");
    expect(text).toContain("Payments to check");
    expect(text).toContain(money(12));
    // No customer name, phone or email in the alert, its subject or the email it sent.
    const mails = ownerMailsAbout(m.billId);
    expect(mails).toHaveLength(1);
    for (const piece of [text, alert!.subject, mails[0].subject, mails[0].text])
      for (const secret of ["Nadia", "NADIA", "Secret", m.phone, "private.example"]) expect(piece).not.toContain(secret);
    // The list is still the source of truth: the payment is on it and unchanged by the alert.
    const row = (await getDb().prepare("SELECT settlement_issue AS issue, settlement_reviewed_at AS reviewed FROM online_payments WHERE id = ?").get(m.paymentId)) as { issue: string; reviewed: string | null };
    expect(row).toEqual({ issue: "underpaid", reviewed: null });
  });

  it("repeated processing (a retry, then the redirect) does not tell again, nor does a later look", async () => {
    const m = await pending(courtA);
    await callback(m.billId, { paidSen: 1200 });
    await callback(m.billId, { paidSen: 1200 });
    await callback(m.billId, { paidSen: 1200 });
    expect((await alertFor(m.paymentId))!.count).toBe(1);
    expect(ownerMailsAbout(m.billId)).toHaveLength(1);
  });

  it("concurrent callbacks tell once", async () => {
    const short = await pending(courtA);
    const over = await pending(courtA);
    await Promise.all([1, 2, 3, 4, 5].flatMap(() => [callback(short.billId, { paidSen: 800 }), callback(over.billId, { paidSen: 3000 })]));
    for (const m of [short, over]) {
      expect((await alertFor(m.paymentId))!.count).toBe(1);
      expect(ownerMailsAbout(m.billId)).toHaveLength(1);
    }
  });

  it("covers an excess paid, a mismatched collection and a payment after the hold was let go", async () => {
    const over = await pending(courtA);
    await callback(over.billId, { paidSen: 3000 });
    expect((await alertFor(over.paymentId))!.lastDetail).toContain("more than the page asked for");

    const wrong = await pending(courtA);
    await callback(wrong.billId, { collection: "colElsewhere" });
    expect((await alertFor(wrong.paymentId))!.lastDetail).toContain("another collection");

    const late = await pending(courtA);
    await getDb().prepare("UPDATE bookings SET hold_until = datetime('now', '-1 minutes') WHERE id = ?").run(late.bookingId);
    await releaseExpiredHolds();
    await callback(late.billId);
    const lapsed = await alertFor(late.paymentId);
    expect(lapsed!.lastDetail).toContain("hold was let go");
    expect(ownerMailsAbout(late.billId)).toHaveLength(1);
  });

  it("marking the payment checked clears its alert; a later new mismatch alerts again", async () => {
    const first = await pending(courtA);
    await callback(first.billId, { paidSen: 1200 });
    expect(await alertFor(first.paymentId)).toBeDefined();
    expect((await reviewPayment(first.paymentId, venueA, { id: 1, name: "Mara" }, "checked in Billplz")).ok).toBe(true);
    expect(await alertFor(first.paymentId)).toBeUndefined();
    // A second look is refused and changes nothing.
    expect((await reviewPayment(first.paymentId, venueA, { id: 1, name: "Mara" }, null)).ok).toBe(false);
    // Another venue's staff cannot clear it either (the review is by venue).
    const second = await pending(courtA);
    await callback(second.billId, { paidSen: 1500 });
    expect((await reviewPayment(second.paymentId, venueB, { id: 1, name: "Bram" }, null)).ok).toBe(false);
    expect(await alertFor(second.paymentId)).toBeDefined();
    expect(ownerMailsAbout(second.billId)).toHaveLength(1);
  });

  it("names only its own venue: a payment at one venue never mentions the other", async () => {
    const m = await pending(courtB);
    await callback(m.billId, { paidSen: 1000, key: OTHER_KEY, collection: "colVisB" });
    const alert = await alertFor(m.paymentId);
    expect(alert).toBeDefined();
    expect(alert!.lastDetail).toContain("Bravo Barn");
    expect(alert!.lastDetail).not.toContain("Alpha Arena");
    expect(alert!.subject).not.toContain("Alpha Arena");
  });

  it("past a handful standing at one venue, further ones are one line a day, cleared when all are checked", async () => {
    const made: Made[] = [];
    for (let i = 0; i < PAYMENT_ALERT_EACH_MAX + 3; i++) {
      const m = await pending(courtA);
      await callback(m.billId, { paidSen: 1000 });
      made.push(m);
    }
    const keys = (await checkAlerts()).map((a) => a.key);
    expect(keys.filter((k) => !k.includes(":many:"))).toHaveLength(PAYMENT_ALERT_EACH_MAX);
    const many = (await checkAlerts()).filter((a) => a.key.includes(":many:"));
    expect(many).toHaveLength(1);
    expect(many[0].count).toBe(1);
    expect(many[0].subject).toContain("Alpha Arena");
    // Eight payments, but six emails: five one by one and one line.
    expect(sent.filter((m) => m.to === ownerEmail)).toHaveLength(PAYMENT_ALERT_EACH_MAX + 1);
    for (const m of made) await reviewPayment(m.paymentId, venueA, { id: 1, name: "Mara" }, null);
    expect(await checkAlerts()).toEqual([]);
  });
});

/* ----------------------------------------------------------------------------- 3: counter refunds owed back */

describe("3. counter payments owed back are seen: a line in Needs attention and one message a day to managers", () => {
  /** 10:00 on a fixed day in the venues' zone (UTC+8): after the digest hour. */
  const at = (day: string, hourLocal: number) => new Date(`${day}T${String(hourLocal - 8).padStart(2, "0")}:00:00Z`);
  const DAY1 = "2031-03-10";
  const DAY2 = "2031-03-11";

  /** A booking paid at the counter, written down as owed back for a cause; `ageDays` old. Returns the owed row's id. */
  async function owe(
    venue: "A" | "B",
    cause: "customer_cancelled" | "closure" | "rain" | "outage" | "moved_cheaper" | "place_withdrawn",
    ageDays = 0,
    /** The moment the age is counted from: now, or the moment a test sets the clock to. */
    base: number = Date.now()
  ): Promise<number> {
    const court = venue === "A" ? courtA : courtB;
    const { date, hour } = nextSlot();
    const made = await createBooking({ courtId: court, date, hours: [hour], name: "Counter Customer Zed", phone: `0172${String(++n).padStart(7, "0")}` });
    if (!made.ok) throw new Error(made.error);
    const paid = await setPaymentStatus(made.booking.code, true, "cash");
    if (!paid.ok) throw new Error(paid.error);
    if (cause === "customer_cancelled") expect(await oweCounterToCustomer(made.booking.id, 1)).toBe(true);
    else if (cause === "place_withdrawn") {
      await getDb().prepare("INSERT INTO counter_refunds_owed (venue_id, booking_id, amount, via, cause) VALUES (?, ?, 5, 'cash', 'place_withdrawn')").run(venue === "A" ? venueA : venueB, made.booking.id);
    } else if (cause === "moved_cheaper")
      await getDb().prepare("INSERT INTO counter_refunds_owed (venue_id, booking_id, amount, via, cause) VALUES (?, ?, 4, 'cash', 'moved_cheaper')").run(venue === "A" ? venueA : venueB, made.booking.id);
    else expect(await oweCounter(made.booking.id, cause)).toBe(true);
    const row = (await getDb().prepare("SELECT id FROM counter_refunds_owed WHERE booking_id = ? ORDER BY id DESC LIMIT 1").get(made.booking.id)) as { id: number };
    await getDb().prepare("UPDATE counter_refunds_owed SET owed_since = ? WHERE id = ?").run(new Date(base - ageDays * 86_400_000).toISOString(), row.id);
    return row.id;
  }
  const clearOwed = async () => {
    await getDb().prepare("DELETE FROM messages WHERE dedupe_key LIKE 'counter-owed:%'").run();
    await getDb().prepare("UPDATE counter_refunds_owed SET settled_at = now(), outcome = 'back', admin_name = 'cleanup' WHERE settled_at IS NULL").run();
  };
  const attention = async (cookie: string) => {
    const res = await attentionGet(new NextRequest("http://localhost/api/admin/attention", { headers: { cookie } }));
    expect(res.status).toBe(200);
    return (await res.json()) as { counterOwed: { venueId: number; venueName: string; count: number; amount: number; oldestDays: number; overdue: number }[] };
  };
  const digestMessages = async (venueId?: number) =>
    (await getDb()
      .prepare(`SELECT recipient, dedupe_key FROM messages WHERE dedupe_key LIKE ? ORDER BY dedupe_key`)
      .all(venueId ? `counter-owed:${venueId}:%` : "counter-owed:%")) as { recipient: string; dedupe_key: string }[];

  beforeEach(async () => {
    await clearOwed();
  });

  it("is the control: nothing owed, no line, no message", async () => {
    expect((await attention(managerA.cookie)).counterOwed).toEqual([]);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(DAY1, 10));
    expect(await sendCounterOwedDigests()).toEqual([]);
    expect(await digestMessages()).toEqual([]);
  });

  it("Needs attention counts every cause, with the sum, the oldest age and the overdue ones; the desk sees it too", async () => {
    await owe("A", "customer_cancelled", 0);
    await owe("A", "closure", 1);
    await owe("A", "rain", REFUND_OVERDUE_DAYS);
    await owe("A", "moved_cheaper", REFUND_OVERDUE_DAYS + 3);
    await owe("A", "place_withdrawn", 0);
    await owe("A", "outage", 0);
    for (const cookie of [managerA.cookie, deskA.cookie]) {
      const { counterOwed: lines } = await attention(cookie);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatchObject({ venueId: venueA, venueName: "Alpha Arena", count: 6, oldestDays: REFUND_OVERDUE_DAYS + 3, overdue: 2 });
      expect(lines[0].amount).toBe(20 + 20 + 20 + 4 + 5 + 20);
      expect(JSON.stringify(lines)).not.toContain("Zed");
    }
  });

  it("is per venue: another venue's staff see only their own, the owner sees all", async () => {
    await owe("A", "closure", 3);
    await owe("B", "rain", 0);
    const a = (await attention(deskA.cookie)).counterOwed;
    const b = (await attention(deskB.cookie)).counterOwed;
    expect(a.map((l) => l.venueId)).toEqual([venueA]);
    expect(b.map((l) => l.venueId)).toEqual([venueB]);
    expect(b[0]).toMatchObject({ count: 1, overdue: 0 });
    const all = (await attention(ownerCookie)).counterOwed;
    expect(all.map((l) => l.venueId).sort()).toEqual([venueA, venueB].sort());
  });

  it("the overdue mark is the constant: one day short is not overdue, the day is", async () => {
    await owe("A", "closure", REFUND_OVERDUE_DAYS - 1);
    expect((await counterOwedSummary([venueA]))[0]).toMatchObject({ count: 1, overdue: 0, oldestDays: REFUND_OVERDUE_DAYS - 1, overdueAfterDays: REFUND_OVERDUE_DAYS });
    await owe("A", "closure", REFUND_OVERDUE_DAYS);
    expect((await counterOwedSummary([venueA]))[0]).toMatchObject({ count: 2, overdue: 1 });
  });

  it("a settled refund leaves the line, and nothing is settled by being told about", async () => {
    const id = await owe("A", "customer_cancelled", 3);
    await owe("A", "closure", 0);
    expect((await counterOwedSummary([venueA]))[0].count).toBe(2);
    const done = await settleOwed(id, "back", { id: 1, name: "Mara", role: "manager" });
    expect(done.ok).toBe(true);
    expect((await counterOwedSummary([venueA]))[0]).toMatchObject({ count: 1, overdue: 0 });
    // The digest tells about what is left and settles none of it.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(DAY1, 10));
    await sendCounterOwedDigests();
    expect((await counterOwed([venueA], "manager")).map((o) => o.status)).toEqual(["owed"]);
    await getDb().prepare("UPDATE messages SET status = 'sent' WHERE dedupe_key LIKE 'counter-owed:%'").run();
    expect((await counterOwed([venueA], "manager")).map((o) => o.status)).toEqual(["owed"]);
  });

  it("one message per manager per venue per day, from 09:00 venue time, with counts, the sum and ages and no item or name", async () => {
    for (let i = 0; i < 5; i++) await owe("A", i % 2 ? "closure" : "customer_cancelled", i === 0 ? 4 : 0, at(DAY1, COUNTER_OWED_DIGEST_HOUR).getTime());
    // Before the hour: nothing.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(DAY1, COUNTER_OWED_DIGEST_HOUR - 1));
    expect(await sendCounterOwedDigests()).toEqual([]);
    expect(await digestMessages()).toEqual([]);
    // At the hour: the venue's manager, not its desk, not another venue's staff, and not five messages.
    vi.setSystemTime(at(DAY1, COUNTER_OWED_DIGEST_HOUR));
    expect(await sendCounterOwedDigests()).toEqual([venueA]);
    const messages = await digestMessages();
    expect(messages.map((m) => m.recipient)).toEqual([managerA.email]);
    const mail = sent.filter((m) => m.dedupeKey?.startsWith("counter-owed:"));
    expect(mail).toHaveLength(1);
    expect(mail[0].to).toBe(managerA.email);
    expect(mail[0].text).toContain("Alpha Arena");
    expect(mail[0].text).toContain(`${money(100)} in all`);
    expect(mail[0].text).toContain("The oldest has waited 4 days");
    expect(mail[0].text).toContain(`${REFUND_OVERDUE_DAYS} days or more`);
    expect(mail[0].text).toContain("does not settle anything");
    for (const secret of ["Zed", "Counter Customer", "0172", "Bravo"]) expect(mail[0].subject + mail[0].text).not.toContain(secret);
  });

  it("repeat ticks, a restart and two servers at once send nothing more that day; the next day it goes again", async () => {
    await owe("A", "closure", 0);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(DAY1, 10));
    await Promise.all([sendCounterOwedDigests(), sendCounterOwedDigests(), sendCounterOwedDigests()]);
    await sendCounterOwedDigests();
    vi.setSystemTime(at(DAY1, 22));
    await sendCounterOwedDigests();
    expect(await digestMessages(venueA)).toHaveLength(1);
    vi.setSystemTime(at(DAY2, 10));
    await sendCounterOwedDigests();
    expect((await digestMessages(venueA)).map((m) => m.dedupe_key)).toEqual([`counter-owed:${venueA}:${DAY1}:${managerA.email}`, `counter-owed:${venueA}:${DAY2}:${managerA.email}`]);
  });

  it("stops when everything is settled", async () => {
    const id = await owe("A", "closure", 3);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(DAY1, 10));
    await sendCounterOwedDigests();
    expect(await digestMessages(venueA)).toHaveLength(1);
    expect((await settleOwed(id, "back", { id: 1, name: "Mara", role: "manager" })).ok).toBe(true);
    vi.setSystemTime(at(DAY2, 10));
    expect(await sendCounterOwedDigests()).toEqual([]);
    expect(await digestMessages(venueA)).toHaveLength(1);
  });

  it("each venue is told its own numbers only", async () => {
    const base = at(DAY1, 10).getTime();
    await owe("A", "closure", 0, base);
    await owe("A", "rain", 0, base);
    await owe("B", "outage", 0, base);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(DAY1, 10));
    expect((await sendCounterOwedDigests()).sort()).toEqual([venueA, venueB].sort());
    const a = sent.find((m) => m.to === managerA.email && m.dedupeKey?.startsWith("counter-owed:"))!;
    const b = sent.find((m) => m.to === managerB.email && m.dedupeKey?.startsWith("counter-owed:"))!;
    expect(a.text).toContain("Alpha Arena");
    expect(a.text).toContain(`${money(40)} in all`);
    expect(a.text).not.toContain("Bravo");
    expect(b.text).toContain("Bravo Barn");
    expect(b.text).toContain(`${money(20)} in all`);
    expect(b.text).not.toContain("Alpha");
    expect(sent.filter((m) => m.dedupeKey?.startsWith("counter-owed:") && [deskA.email, "dev@bravo.my"].includes(m.to))).toHaveLength(0);
  });

  it("the scheduler's short unit runs it", async () => {
    await owe("B", "closure", 0);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(at(DAY1, 10));
    await runScheduledWork(new Date(), "short");
    await runScheduledWork(new Date(), "short");
    expect(await digestMessages(venueB)).toHaveLength(1);
  });
});
