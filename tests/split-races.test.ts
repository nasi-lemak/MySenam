import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.sg";
process.env.MYSENAM_COUNTRY = "SG";

import { getDb } from "../src/lib/db";
import { savePaymentSettings, settleBill, startSplitPayment } from "../src/lib/payments";
import { splitBooking, splitByToken } from "../src/lib/splits";
import { createBooking, createCourt, createVenue, findBooking } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * Splitting a booking (audit R8, X3-12): decided under the booking's lock,
 * so two first splits at once make one split rather than an error, and the
 * shares never change once a friend has paid, or while one is paying at the
 * amount their page was opened with. Run on Postgres too.
 */

let courtId: number;
let n = 0;

function fakeStripe() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: { method?: string } = {}) => {
      if (init.method === "POST") {
        const id = `cs_test_race${++n}`;
        return Response.json({ id, url: `https://checkout.stripe.com/c/pay/${id}` });
      }
      const id = decodeURIComponent(url.split("/").pop()!);
      return Response.json({ id, payment_status: "paid", status: "complete", payment_intent: `pi_${id}` });
    })
  );
}

const billOf = (url: string) => url.split("/").pop()!;
const friend = (i: number) => ({ name: `Friend ${i}`, phone: `9200000${i}`, email: `r${i}@example.sg` });

async function booking(hour: number) {
  const made = await createBooking({ courtId, date: addDays(todayISO(), 3), hours: [hour], name: "Host Tan", phone: "91234567" });
  if (!made.ok) throw new Error(made.error);
  return made.booking;
}

beforeAll(async () => {
  const made = await createVenue({ name: "Race Courts", area: "Bishan", address: "x", phone: "61230000" });
  if (!made.ok) throw new Error("venue");
  const court = await createCourt({ venueId: made.venue.id, name: "Court 1", sport: "badminton", offPeakRate: 30, peakRate: 30 });
  if (!court.ok) throw new Error("court");
  courtId = court.court.id;
  const saved = await savePaymentSettings(made.venue.id, { credentials: { secretKey: "rk_test_racekey12345678", webhookSecret: "whsec_race1234567890" }, sandbox: true, enabled: true });
  if (!saved.ok) throw new Error(saved.error);
});

afterEach(() => vi.unstubAllGlobals());
afterAll(() => {
  delete process.env.MYSENAM_COUNTRY;
});

describe("splitting at the same moment", () => {
  it("two first splits make one split, neither failing", async () => {
    const b = await booking(8);
    const both = await Promise.all([splitBooking(b.code, b.phone, 2), splitBooking(b.code, b.phone, 3)]);
    expect(both.every((r) => r.ok)).toBe(true);
    const rows = (await getDb().prepare("SELECT parts FROM booking_splits WHERE booking_id = ?").all(b.id)) as { parts: number }[];
    expect(rows).toHaveLength(1);
    // Both links are the one split's.
    expect(new Set(both.map((r) => (r.ok ? r.split.token : "")))).toEqual(new Set([both[0].ok ? both[0].split.token : "x"]));
  });
});

describe("changing the split", () => {
  it("is refused while a friend is paying at the share as it was, and once they have paid", async () => {
    fakeStripe();
    const b = await booking(9);
    const made = await splitBooking(b.code, b.phone, 3);
    if (!made.ok) throw new Error(made.error);
    const started = await startSplitPayment(made.split.token, friend(1));
    if (!started.ok) throw new Error(started.error);
    expect(started.amount).toBe(10);
    expect(await splitBooking(b.code, b.phone, 2)).toMatchObject({
      ok: false,
      status: 409,
      error: "A friend is paying their share now, so the split stays as it is until that payment is settled.",
    });
    await settleBill({ billId: billOf(started.url), paid: true, paidAt: null });
    expect(await splitBooking(b.code, b.phone, 2)).toMatchObject({ ok: false, status: 409, error: "A friend has paid already, so the split stays as it is." });
    // The share paid is the share the split says, and the booker owes the rest.
    expect(await splitByToken(made.split.token)).toMatchObject({ parts: 3, share: 10, paid: 1, closed: null });
    expect((await findBooking(b.code, b.phone))!).toMatchObject({ sharesPaid: 10, paymentStatus: "unpaid" });
  });

  it("and a friend's share settling at once leave a split whose shares agree with what was paid", async () => {
    fakeStripe();
    const b = await booking(10);
    const made = await splitBooking(b.code, b.phone, 3);
    if (!made.ok) throw new Error(made.error);
    const started = await startSplitPayment(made.split.token, friend(2));
    if (!started.ok) throw new Error(started.error);
    const [resplit] = await Promise.all([splitBooking(b.code, b.phone, 2), settleBill({ billId: billOf(started.url), paid: true, paidAt: null })]);
    expect(resplit.ok).toBe(false);
    const split = (await getDb().prepare("SELECT parts, share::float AS share FROM booking_splits WHERE booking_id = ?").get(b.id)) as { parts: number; share: number };
    const paid = (await getDb()
      .prepare("SELECT amount::float AS amount FROM online_payments WHERE purpose = 'split' AND status = 'paid' AND refund_due = 0 AND split_id = (SELECT id FROM booking_splits WHERE booking_id = ?)")
      .all(b.id)) as { amount: number }[];
    expect(paid.map((p) => p.amount)).toEqual([split.share]);
    expect(split).toEqual({ parts: 3, share: 10 });
  });
});
