import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { moveBookingToDate } from "./helpers/bookings";
import { salesJournal } from "../src/lib/accounting";
import { createAdmin } from "../src/lib/admin-auth";
import { registerUser } from "../src/lib/auth";
import { customerReport } from "../src/lib/customer-report";
import { getDb } from "../src/lib/db";
import { creditBookingAdjustment } from "../src/lib/documents";
import { createBooking, createCourt, createVenue, issuePass, payBookingFromWallet, payBookingWithPass, setNoShow, setPaymentStatus, topUpWallet } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * Hardening, brief MONEY, D17 (ADR 0068): "spent" in the customer report is money the customer paid: not the price of an unpaid booking, of
 * one a pass paid (entries, not money) or of a friend's share. The ledger (the sales journal) is untouched and agrees with it.
 */

let venueId: number;
let courtId: number;
let adminId: number;
const today = todayISO();
let hour = 7;
let n = 0;
const phone = () => `0168${String(++n).padStart(6, "0")}`;

beforeAll(async () => {
  const v = await createVenue({ name: "Spent Courts", area: "PJ", address: "x", phone: "0355559999", openHour: 6, closeHour: 23 });
  if (!v.ok) throw new Error("venue");
  venueId = v.venue.id;
  const c = await createCourt({ venueId, name: "C1", sport: "badminton", offPeakRate: 20, peakRate: 20 });
  if (!c.ok) throw new Error("court");
  courtId = c.court.id;
  const a = await createAdmin({ name: "Spent Manager", email: "m@spent.my", password: "manager-pass-1", venueId });
  if (!a.ok) throw new Error("admin");
  adminId = a.admin.id;
});

/** A booking made ahead, then moved to `daysAgo` days ago (as time passing would), by `name` at `ph`. */
async function played(name: string, ph: string, daysAgo: number, userId?: number) {
  const made = await createBooking({ courtId, date: addDays(today, 5), hours: [hour++], name, phone: ph, ...(userId ? { userId } : {}) });
  if (!made.ok) throw new Error(JSON.stringify(made));
  if (hour > 21) hour = 7;
  return { booking: made.booking, move: () => moveBookingToDate(made.booking.id, addDays(today, -daysAgo)) };
}
const spentBy = async (ph: string, from = addDays(today, -29), to = today) => (await customerReport(venueId, from, to)).top.find((c) => c.phone === ph)?.spent;

describe("D17: spent is money paid", () => {
  it("counts a paid booking at what was paid, and an unpaid one at nothing", async () => {
    const ph = phone();
    const paid = await played("Aisyah", ph, 4);
    const unpaid = await played("Aisyah", ph, 3);
    expect((await setPaymentStatus(paid.booking.code, true, "cash")).ok).toBe(true);
    await paid.move();
    await unpaid.move();
    expect(await spentBy(ph)).toBe(20);
  });

  it("a booking a pass paid is not money spent; the pass's own sale is not a booking's", async () => {
    const ph = phone();
    const pass = await issuePass({ venueId, name: "Ten", entries: 10, price: 150, holderName: "Ben", holderPhone: ph, expiresOn: addDays(today, 60), adminId: null });
    if (!pass.ok) throw new Error(JSON.stringify(pass));
    const a = await played("Ben", ph, 4);
    const b = await played("Ben", ph, 3);
    expect((await payBookingWithPass(a.booking.id, pass.pass.code)).ok).toBe(true);
    expect((await setPaymentStatus(b.booking.code, true, "qr")).ok).toBe(true);
    await a.move();
    await b.move();
    expect(await spentBy(ph)).toBe(20);
    // Still two bookings and their hours: only the money changed.
    const row = (await customerReport(venueId, addDays(today, -29), today)).top.find((c) => c.phone === ph)!;
    expect(row.bookings).toBe(2);
  });

  it("an unpaid no-show is nothing; a paid no-show is kept money and counts", async () => {
    const ph = phone();
    const unpaid = await played("Chong", ph, 5);
    const paid = await played("Chong", ph, 4);
    expect((await setPaymentStatus(paid.booking.code, true, "cash")).ok).toBe(true);
    await unpaid.move();
    await paid.move();
    expect((await setNoShow(unpaid.booking.code, true)).ok).toBe(true);
    expect((await setNoShow(paid.booking.code, true)).ok).toBe(true);
    expect(await spentBy(ph)).toBe(20);
  });

  it("credit the customer bought and spent is theirs spent", async () => {
    const ph = phone();
    const user = await registerUser({ name: "Dina", email: "dina-spent@example.com", phone: ph, password: "password1" });
    if (!user.ok) throw new Error("user");
    expect((await topUpWallet({ userId: user.user.id, amount: 50, adminId, venueId })).ok).toBe(true);
    const b = await played("Dina", ph, 2, user.user.id);
    expect((await payBookingFromWallet(b.booking.id)).ok).toBe(true);
    await b.move();
    expect(await spentBy(ph)).toBe(20);
  });

  it("what was taken back on a credit note is not spent, and a deposit paid online is, on a booking not yet paid in full", async () => {
    const ph = phone();
    const paid = await played("Ema", ph, 6);
    expect((await setPaymentStatus(paid.booking.code, true, "cash")).ok).toBe(true);
    // A manager lowers the price afterwards by RM5: its credit note (lib/documents.ts creditBookingAdjustment) takes it off the receipt.
    expect(await creditBookingAdjustment(paid.booking.id, 1, 5, false)).not.toBeNull();
    const held = await played("Ema", ph, 5);
    await getDb().prepare("UPDATE bookings SET deposit_paid = 6, shares_paid = 6 WHERE id = ?").run(held.booking.id);
    await paid.move();
    await held.move();
    // 20 - 5 (the credit note) on the first; the RM6 deposit on the second, which is not paid in full.
    expect(await spentBy(ph)).toBe(21);
  });

  it("the ledger is the same, and agrees: the report's figures for a venue are the journal's net on its bookings", async () => {
    // A venue of its own, so the journal holds only these.
    const v = await createVenue({ name: "Ledger Courts", area: "PJ", address: "y", phone: "0355558888", openHour: 6, closeHour: 23 });
    if (!v.ok) throw new Error("venue");
    const c = await createCourt({ venueId: v.venue.id, name: "L1", sport: "badminton", offPeakRate: 20, peakRate: 20 });
    if (!c.ok) throw new Error("court");
    const mk = async (ph: string, h: number, daysAgo: number) => {
      const made = await createBooking({ courtId: c.court.id, date: addDays(today, 5), hours: [h], name: "Fadzil", phone: ph });
      if (!made.ok) throw new Error(JSON.stringify(made));
      return { b: made.booking, move: () => moveBookingToDate(made.booking.id, addDays(today, -daysAgo)) };
    };
    const ph = phone();
    const pass = await issuePass({ venueId: v.venue.id, name: "Ten", entries: 10, price: 150, holderName: "Fadzil", holderPhone: ph, expiresOn: addDays(today, 60), adminId: null });
    if (!pass.ok) throw new Error(JSON.stringify(pass));
    const a = await mk(ph, 8, 4);
    const b = await mk(ph, 9, 3);
    const u = await mk(ph, 10, 2);
    expect((await setPaymentStatus(a.b.code, true, "cash")).ok).toBe(true);
    expect((await payBookingWithPass(b.b.id, pass.pass.code)).ok).toBe(true);
    await a.move();
    await b.move();
    await u.move();
    const report = await customerReport(v.venue.id, addDays(today, -29), today);
    const rows = (await salesJournal(v.venue.id, addDays(today, -1), addDays(today, 1))).filter((r) => r.ref.startsWith("booking:"));
    // The journal has the one money booking and nothing for the pass-paid or the unpaid one.
    const net = rows.reduce((s, r) => s + r.gross, 0);
    expect(report.top[0].spent).toBe(20);
    expect(net).toBe(20);
    expect(rows.length).toBe(1);
  });
});
