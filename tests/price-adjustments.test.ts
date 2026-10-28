import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { NextRequest } from "next/server";
import { salesJournal } from "../src/lib/accounting";
import { listActivity } from "../src/lib/activity";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { getDb } from "../src/lib/db";
import { bookingSale, documentFor } from "../src/lib/documents";
import { bookingsCsv } from "../src/lib/export";
import { translator } from "../src/lib/i18n";
import { adjustBookingPrice } from "../src/lib/price-adjustments";
import { receiptLineText } from "../src/lib/receipts";
import { adminCancelBooking, applyPromo, createBooking, createCourt, createPromoCode, createVenue, setPaymentStatus } from "../src/lib/store";
import { setVenueTax } from "../src/lib/tax";
import { addDays, todayISO } from "../src/lib/time";
import { POST as adjustPost, GET as adjustGet } from "../src/app/api/admin/bookings/adjust-price/route";

/**
 * X1-17: a manager's price adjustment on one booking, with a reason, through
 * the one price and receipt path. Before payment the price changes and the
 * receipt shows the difference; after a counter payment only a lower price,
 * the difference on a credit note, the receipt as sold; a later cancellation
 * gives back only what is left. The adjusted price takes no more discounts.
 */

const ZONE = "Asia/Kuala_Lumpur";
const today = todayISO(ZONE);
let venueId: number;
let courtId: number;
let asDesk: string;
let asManager: string;
let manager: { id: number; name: string; role: "manager" };
let slot = 9;

const call = (handler: (req: NextRequest) => Promise<Response>, cookie: string, body?: unknown, query = "") =>
  handler(
    new NextRequest(`http://localhost/api/admin/bookings/adjust-price${query}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { cookie, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  );

/** A booking of an hour at RM30, each on an hour of its own. */
async function booking() {
  const made = await createBooking({ courtId, date: addDays(today, 3), hours: [slot++], name: "Hana", phone: "0123450000" });
  if (!made.ok) throw new Error(made.error);
  return made.booking;
}

const total = async (id: number) =>
  Number(((await getDb().prepare("SELECT total_price::float AS t FROM bookings WHERE id = ?").get(id)) as { t: number }).t);

beforeAll(async () => {
  const v = await createVenue({ name: "Adjust Hall", area: "PJ", address: "x", phone: "0366661111" });
  if (!v.ok) throw new Error("venue");
  venueId = v.venue.id;
  await setVenueTax(venueId, { registered: true, name: "SST", rate: 6, regNo: "W10-1808-31000002" });
  const c = await createCourt({ venueId, name: "Court A", sport: "badminton", offPeakRate: 30, peakRate: 30 });
  if (!c.ok) throw new Error("court");
  courtId = c.court.id;
  const desk = await createAdmin({ name: "Desk Dan", email: "dan@adjust.my", password: "desk-password-1", venueId, role: "desk" });
  const mgr = await createAdmin({ name: "Manager May", email: "may@adjust.my", password: "manager-password-1", venueId });
  if (!desk.ok || !mgr.ok) throw new Error("admins");
  manager = { id: mgr.admin.id, name: mgr.admin.name, role: "manager" };
  asDesk = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.admin.id)).token}`;
  asManager = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(mgr.admin.id)).token}`;
});

describe("before it is paid", () => {
  it("is a manager's, with a reason: the price changes and the receipt shows the difference", async () => {
    const b = await booking();
    const desk = await call(adjustPost, asDesk, { code: b.code, amount: 20, reason: "Lights were out last week" });
    expect(desk.status).toBe(403);
    expect((await desk.json()).code).toBe("MANAGER_ONLY");
    const noReason = await call(adjustPost, asManager, { code: b.code, amount: 20, reason: "x" });
    expect(noReason.status).toBe(400);
    expect((await noReason.json()).code).toBe("P8B_ADJUST_REASON");
    expect((await call(adjustPost, asManager, { code: b.code, amount: -1, reason: "Lights were out last week" })).status).toBe(400);

    const res = await call(adjustPost, asManager, { code: b.code, amount: 20, reason: "Lights were out last week" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.adjustment).toMatchObject({ before: 30, after: 20, delta: -10, complimentary: false, paid: false, adminName: "Manager May" });
    expect(body.creditNote).toBeNull();
    expect(await total(b.id)).toBe(20);
    const sale = (await bookingSale(b.id))!;
    expect(sale.total).toBe(20);
    expect(sale.lines.reduce((s, l) => s + l.amount, 0)).toBeCloseTo(20, 2);
    expect(sale.lines[0].amount).toBe(30);
    const line = sale.lines.find((l) => l.adjusted)!;
    expect(line).toMatchObject({ amount: -10, adjusted: "adjusted", description: "Price adjusted by the venue" });
    expect(receiptLineText(translator("ms"), line)).toBe("Harga dilaraskan oleh pusat");
    expect((await call(adjustPost, asManager, { code: b.code, amount: 20, reason: "Again the same" })).status).toBe(409);

    const log = await listActivity([venueId], { bookingCode: b.code });
    expect(log[0]).toMatchObject({ action: "booking.price_adjusted", adminName: "Manager May" });
    expect(log[0].detail).toContain("Lights were out last week");
    const shown = await (await call(adjustGet, asDesk, undefined, `?code=${b.code}`)).json();
    expect(shown.adjustments).toHaveLength(1);
    // Paid afterwards: the journal takes the adjusted price, tax inside it.
    await setPaymentStatus(b.code, true, "cash");
    const row = (await salesJournal(venueId, today, today)).find((r) => r.number === b.code)!;
    expect(row).toMatchObject({ gross: 20, tax: 1.13 });
    expect(await bookingsCsv(venueId, addDays(today, 3), addDays(today, 3))).toContain("-10.00");
  });

  it("complimentary: free, the receipt saying so", async () => {
    const b = await booking();
    const res = await call(adjustPost, asManager, { code: b.code, complimentary: true, reason: "Sponsor's hour, agreed" });
    expect(res.status).toBe(200);
    expect(await total(b.id)).toBe(0);
    const sale = (await bookingSale(b.id))!;
    expect(sale.lines.find((l) => l.adjusted)).toMatchObject({ amount: -30, adjusted: "complimentary", description: "Complimentary" });
  });

  it("keeps the discounts already on it, and takes no more after", async () => {
    const promo = await createPromoCode({ venueId, code: "TENOFF", description: "RM10 off", kind: "amount", value: 10, validFrom: today, validTo: addDays(today, 30), adminId: manager.id });
    if (!promo.ok) throw new Error(promo.error);
    const b = await booking();
    expect((await applyPromo(b.id, "TENOFF")).ok).toBe(true);
    expect(await total(b.id)).toBe(20);
    expect((await adjustBookingPrice({ code: b.code, amount: 15, reason: "Price matched to a phone quote", staff: manager })).ok).toBe(true);
    const sale = (await bookingSale(b.id))!;
    // Court time, the code, then the manager's difference: what the customer pays.
    expect(sale.lines.map((l) => l.amount)).toEqual([30, -10, -5]);
    const other = await booking();
    expect((await adjustBookingPrice({ code: other.code, amount: 25, reason: "Regular's goodwill", staff: manager })).ok).toBe(true);
    expect(await applyPromo(other.id, "TENOFF")).toMatchObject({ ok: false, code: "P8B_PRICE_ADJUSTED" });
    expect(await total(other.id)).toBe(25);
  });

  it("is refused for a cancelled booking, below what was paid on it, and where others share it", async () => {
    const b = await booking();
    await getDb().prepare("UPDATE bookings SET shares_paid = 12 WHERE id = ?").run(b.id);
    expect(await adjustBookingPrice({ code: b.code, amount: 10, reason: "Too low for the deposit", staff: manager })).toMatchObject({ ok: false, code: "P8B_ADJUST_BELOW_PAID" });
    await getDb().prepare("UPDATE bookings SET shares_paid = 0 WHERE id = ?").run(b.id);
    await getDb().prepare("INSERT INTO booking_splits (booking_id, parts, share, token) VALUES (?, 2, 15, ?)").run(b.id, `split-${b.id}`);
    expect(await adjustBookingPrice({ code: b.code, amount: 20, reason: "Shared by friends", staff: manager })).toMatchObject({ ok: false, code: "P8B_ADJUST_SHARED" });
    const c = await booking();
    await adminCancelBooking(c.code);
    expect(await adjustBookingPrice({ code: c.code, amount: 20, reason: "Cancelled already", staff: manager })).toMatchObject({ ok: false, code: "P8B_ADJUST_CANCELLED" });
    expect(await adjustBookingPrice({ code: "MS-NOPE00", amount: 20, reason: "Not a booking", staff: manager })).toMatchObject({ ok: false, status: 404 });
    expect(await adjustBookingPrice({ code: c.code, amount: 20, reason: "Desk trying", staff: { ...manager, role: "desk" } })).toMatchObject({ ok: false, status: 403 });
  });
});

describe("after it was paid at the counter", () => {
  it("only comes down, on a credit note given back the way it was paid; the receipt stays as sold", async () => {
    const b = await booking();
    await setPaymentStatus(b.code, true, "cash");
    expect(await adjustBookingPrice({ code: b.code, amount: 35, reason: "Raising it is not this", staff: manager })).toMatchObject({ ok: false, code: "P8B_ADJUST_ONLY_DOWN" });
    const res = await call(adjustPost, asManager, { code: b.code, amount: 25, reason: "Court light flickered" });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.adjustment).toMatchObject({ before: 30, after: 25, delta: -5, paid: true });
    expect(body.creditNote.number).toMatch(/^CN-/);
    // The booking's own receipt is unchanged: what was sold.
    expect(await total(b.id)).toBe(30);
    expect((await bookingSale(b.id))!.lines.some((l) => l.adjusted)).toBe(false);
    const note = (await documentFor(`booking:${b.id}:adjust:${body.adjustment.id}`))!;
    expect(note).toMatchObject({ kind: "credit_note", total: 5, paidVia: "Cash", credits: b.code, note: "receipt.p8b.adjusted", staffName: "Manager May" });
    expect(note.tax).toMatchObject({ rate: 6, amount: 0.28 });

    // Cancelled later: only what is left goes back, so receipts and credit notes add up to nothing.
    await adminCancelBooking(b.code);
    const cancelled = (await documentFor(`booking:${b.id}`))!;
    expect(cancelled.total).toBe(25);
    const rows = (await salesJournal(venueId, today, today)).filter((r) => r.number === b.code || r.number === note.number || r.number === cancelled.number);
    expect(rows.reduce((s, r) => s + r.gross, 0)).toBeCloseTo(0, 2);
  });

  it("is refused for one paid online, with credit or a pass: money goes back by a refund", async () => {
    const b = await booking();
    await getDb().prepare("UPDATE bookings SET payment_status = 'paid', paid_via = 'online', paid_at = ? WHERE id = ?").run(new Date().toISOString(), b.id);
    expect(await adjustBookingPrice({ code: b.code, amount: 20, reason: "Paid online", staff: manager })).toMatchObject({ ok: false, code: "P8B_ADJUST_NOT_COUNTER" });
  });
});

describe("two adjustments at once", () => {
  it("take turns under the booking's lock: the price and the record agree", async () => {
    const b = await booking();
    const results = await Promise.all([
      adjustBookingPrice({ code: b.code, amount: 22, reason: "First manager", staff: manager }),
      adjustBookingPrice({ code: b.code, amount: 18, reason: "Second manager", staff: manager }),
    ]);
    expect(results.filter((r) => r.ok).length).toBeGreaterThanOrEqual(1);
    const { sum } = (await getDb().prepare("SELECT COALESCE(SUM(delta), 0)::float AS sum FROM booking_price_adjustments WHERE booking_id = ?").get(b.id)) as { sum: number };
    expect(roundTo(30 + Number(sum))).toBe(await total(b.id));
    const sale = (await bookingSale(b.id))!;
    expect(roundTo(sale.lines.reduce((s, l) => s + l.amount, 0))).toBe(await total(b.id));
  });
});

const roundTo = (n: number) => Math.round(n * 100) / 100;
