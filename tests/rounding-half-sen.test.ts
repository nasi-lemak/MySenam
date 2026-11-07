import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { setCancelPolicy } from "../src/lib/cancel-policy";
import { getDb } from "../src/lib/db";
import { savePaymentSettings, settleBill, startBookingPayment } from "../src/lib/payments";
import { roundMoney } from "../src/lib/region";
import { cancelBooking, createBooking, createCourt, createVenue } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * Hardening, brief MONEY, C13 (ADR 0068): the money in JavaScript (`roundMoney`, a float rounded with Math.round) and the money in SQL (numeric,
 * `ROUND`, half away from zero) can round a half sen differently, so a late cancellation's credit note and the amount owed back on the same payment
 * can differ by one sen. The owner's rule: financial rounding is never changed without proving the replacement is more correct, and a replacement
 * (one amount in integer sen, passed to the credit note, the wallet, the pass and the refund owed) is a change of its own. So this does NOT change it.
 * These tests pin both behaviours and the one case where they part, so it is understood and a later change is made on purpose, in its own change.
 */

describe("C13: where JavaScript and SQL round a half sen differently", () => {
  it("JavaScript's roundMoney rounds 7.575 down to 7.57 (the float is 7.5749999999999993), where SQL's ROUND of the exact 7.575 gives 7.58", async () => {
    expect(10.1 * 0.75).toBeLessThan(7.575);
    expect(roundMoney(10.1 * 0.75)).toBe(7.57);
    const sql = (await getDb().prepare("SELECT ROUND(10.10::numeric * 0.75::numeric, 2)::float AS v").get()) as { v: number };
    expect(sql.v).toBe(7.58);
    // A half sen that a float holds exactly (a .50 price, dyadic) does not part them.
    expect(roundMoney(10.5 * 0.75)).toBe(7.88);
    expect(((await getDb().prepare("SELECT ROUND(10.50::numeric * 0.75::numeric, 2)::float AS v").get()) as { v: number }).v).toBe(7.88);
  });

  it("over every price from RM0.01 to RM99.99 and a venue keeping 5% to 95% in steps of 5, they part only where the exact product is a half sen, and then by one sen", async () => {
    let parted = 0;
    let exactHalves = 0;
    for (let p = 1; p <= 9999; p++) {
      for (let k = 5; k <= 95; k += 5) {
        // The exact product in tenths of a sen: p sen * k / 100, as an integer count of 1/100 sen.
        const hundredths = p * k;
        const isHalf = hundredths % 100 === 50;
        if (isHalf) exactHalves++;
        const exact = Math.floor((hundredths + 50) / 100) / 100; // half away from zero, as SQL's numeric ROUND
        const js = roundMoney((p / 100) * (k / 100));
        if (Math.abs(js - exact) > 1e-9) {
          parted++;
          expect(isHalf).toBe(true);
          expect(Math.round(Math.abs(js - exact) * 100)).toBe(1);
          // JavaScript is the one that is a sen short: it never rounds a half up when SQL would.
          expect(js).toBeLessThan(exact);
        }
      }
    }
    // They do part (so the case is real), and only at half sen (a minority of those).
    expect(parted).toBeGreaterThan(0);
    expect(parted).toBeLessThan(exactHalves);
  });
});

describe("C13: the one case, end to end, as it stands (a late cancellation of an online payment of RM10.10, the venue keeping 25%)", () => {
  let venueId: number;
  let courtId: number;
  const date = addDays(todayISO(), 3);
  let n = 0;

  beforeAll(async () => {
    const made = await createVenue({ name: "Sen Hall", area: "PJ", address: "x", phone: "0300000010" });
    if (!made.ok) throw new Error("venue");
    venueId = made.venue.id;
    const court = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 10.1, peakRate: 10.1 });
    if (!court.ok) throw new Error("court");
    courtId = court.court.id;
    const saved = await savePaymentSettings(venueId, { apiKey: "api-key-1234", collectionId: "col123", xSignatureKey: "S-key", sandbox: true, enabled: true });
    if (!saved.ok) throw new Error(saved.error);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("the credit note is RM7.57 (JavaScript) and the amount owed back on the payment RM7.58 (SQL): a difference of one sen, pinned", async () => {
    await setCancelPolicy(venueId, { lateKeep: 25 });
    await getDb().prepare("UPDATE venues SET cancel_cutoff_hours = 168 WHERE id = ?").run(venueId);
    const phone = "0193330001";
    const made = await createBooking({ courtId, date, hours: [10], name: "Aina", phone, email: "a@x.my" });
    if (!made.ok) throw new Error(made.error);
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id: `half-sen-${++n}`, url: "https://www.billplz-sandbox.com/bills/x" })));
    const started = await startBookingPayment({ codes: [made.booking.code], phone });
    if (!started.ok) throw new Error("start");
    const bill = (await getDb().prepare("SELECT id, bill_id FROM online_payments ORDER BY id DESC LIMIT 1").get()) as { id: number; bill_id: string };
    await settleBill({ billId: bill.bill_id, paid: true, paidAt: null });
    expect(await cancelBooking(made.booking.code, phone)).toMatchObject({ ok: true });
    const pay = (await getDb().prepare("SELECT amount::float AS amount, refund_due::float AS due FROM online_payments WHERE id = ?").get(bill.id)) as { amount: number; due: number };
    const note = (await getDb().prepare("SELECT total::float AS total FROM receipts WHERE kind = 'credit_note' AND credits_ref = ?").get(made.booking.code)) as { total: number };
    expect(pay.amount).toBe(10.1);
    // The credit note (the tax document) and what is paid back (the gateway) part by one sen. Neither is more than was paid, the venue keeps the rest.
    expect(note.total).toBe(7.57);
    expect(pay.due).toBe(7.58);
    expect(pay.due - note.total).toBeCloseTo(0.01, 10);
    expect(pay.due).toBeLessThanOrEqual(pay.amount);
    // Cancelled again: nothing more is owed, nothing more credited (a repeat never moves either figure).
    expect((await cancelBooking(made.booking.code, phone)).ok).toBe(false);
    const again = (await getDb().prepare("SELECT refund_due::float AS due FROM online_payments WHERE id = ?").get(bill.id)) as { due: number };
    expect(again.due).toBe(7.58);
  });
});
