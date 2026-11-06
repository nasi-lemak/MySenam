import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { asStaff } from "../src/lib/acting-staff";
import { listActivity } from "../src/lib/activity";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { cashUp } from "../src/lib/cash-up";
import { getDb } from "../src/lib/db";
import { hireDepositsHeld } from "../src/lib/hire-deposits";
import { venueReport } from "../src/lib/reports";
import { createBooking, createCourt, createVenue, returnHire, takeHire } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import * as cashUpRoute from "../src/app/api/admin/cash-up/route";
import * as hireRoute from "../src/app/api/admin/hire/route";

/**
 * Hire deposits and the cash-up (audit 9, C10, E13, H10; ADR 0061): how a deposit is held is said when the kit goes out and never
 * assumed afterwards; the cash-up lists deposits taken, given back and kept by method and what is still held (one definition, the
 * reports' liability); what each till should hold is the journal's net plus the deposits' part; and what the cashier counted is
 * recorded with the variance.
 */

const ZONE = "Asia/Kuala_Lumpur";
let venueId: number;
let deskId: number;
let otherDeskId: number;
let managerId: number;
let asDesk: string;
let asOtherDesk: string;
let asManager: string;
let seq = 0;
let hourN = 8;

async function fleet(deposit: number) {
  const created = await createCourt({ venueId, name: `Kayak ${++seq}`, sport: "kayak", offPeakRate: 15, peakRate: 20, capacity: 6, deposit });
  if (!created.ok) throw new Error(created.error);
  return created.court;
}
/** An hour today that is running now, with the clock frozen inside it. */
async function running(courtId: number) {
  vi.useRealTimers();
  const date = todayISO(ZONE);
  const hour = hourN++;
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(`${date}T${String(hour - 1).padStart(2, "0")}:30:00+08:00`));
  const b = await createBooking({ courtId, date, hours: [hour], name: "Paddler", phone: `01555000${String(10 + seq++).padStart(2, "0")}` });
  if (!b.ok) throw new Error(JSON.stringify(b));
  vi.setSystemTime(new Date(`${date}T${String(hour).padStart(2, "0")}:15:00+08:00`));
  return b.booking;
}
const asDeskStaff = <T>(work: () => Promise<T>) => asStaff({ id: deskId, name: "Dee Desk" }, work);
const post = (cookie: string, body: unknown) =>
  cashUpRoute.POST(new NextRequest("http://localhost/api/admin/cash-up", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }));

beforeAll(async () => {
  const v = await createVenue({ name: "Kayak Till", area: "PJ", address: "x", phone: "0377771111" });
  if (!v.ok) throw new Error("venue");
  venueId = v.venue.id;
  const desk = await createAdmin({ name: "Dee Desk", email: "dee@kayak.my", password: "desk-password-1", venueId, role: "desk" });
  const other = await createAdmin({ name: "Ola Desk", email: "ola@kayak.my", password: "desk-password-2", venueId, role: "desk" });
  const mgr = await createAdmin({ name: "Mo Manager", email: "mo@kayak.my", password: "manager-password-1", venueId });
  if (!desk.ok || !other.ok || !mgr.ok) throw new Error("admins");
  deskId = desk.admin.id;
  otherDeskId = other.admin.id;
  managerId = mgr.admin.id;
  asDesk = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(deskId)).token}`;
  asOtherDesk = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(otherDeskId)).token}`;
  asManager = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(managerId)).token}`;
});
afterEach(() => vi.useRealTimers());

describe("how a deposit is held", () => {
  it("is said when the kit goes out: a deposit above nothing without a method is refused, a waived one needs none", async () => {
    const court = await fleet(50);
    const a = await running(court.id);
    expect(await takeHire(a.code)).toMatchObject({ ok: false, error: expect.stringContaining("how the deposit is held") });
    expect(await takeHire(a.code, 50, "online" as never)).toMatchObject({ ok: false });
    const out = await asDeskStaff(() => takeHire(a.code, 50, "qr"));
    expect(out).toMatchObject({ ok: true, hire: { deposit: 50, depositVia: "qr" } });
    const row = (await getDb().prepare("SELECT deposit_via, taken_by_name FROM hire_records WHERE booking_id = ?").get(a.id)) as { deposit_via: string; taken_by_name: string };
    expect(row).toEqual({ deposit_via: "qr", taken_by_name: "Dee Desk" });
    const waived = await running(court.id);
    expect(await takeHire(waived.code, 0)).toMatchObject({ ok: true, hire: { deposit: 0, depositVia: null } });
  });

  it("is never assumed on the way back: what is kept follows the recorded method, a different one is refused, and an unrecorded one must be said (no cash by default)", async () => {
    const court = await fleet(50);
    const a = await running(court.id);
    expect((await takeHire(a.code, 50, "card")).ok).toBe(true);
    const damage = { condition: "damaged" as const, deductions: [{ reason: "damage", amount: 20 }], note: "Cracked paddle" };
    expect(await returnHire(a.code, { ...damage, via: "cash" })).toMatchObject({ ok: false, error: expect.stringContaining("held by card") });
    expect((await returnHire(a.code, damage)).ok).toBe(true);
    const sale = (await getDb().prepare("SELECT s.paid_via FROM counter_sales s JOIN hire_records h ON h.id = s.hire_record_id WHERE h.booking_id = ?").get(a.id)) as { paid_via: string };
    expect(sale.paid_via).toBe("card");

    // A deposit taken before the method was recorded: kept in part, it must be said how it was held.
    const old = await running(court.id);
    await getDb().prepare("INSERT INTO hire_records (booking_id, deposit) VALUES (?, 40)").run(old.id);
    expect(await returnHire(old.code, damage)).toMatchObject({ ok: false, error: expect.stringContaining("how the deposit was held") });
    expect((await returnHire(old.code, { ...damage, via: "transfer" })).ok).toBe(true);
    // And returned whole, nothing is kept, so nothing is put down as cash: its method stays unrecorded.
    const whole = await running(court.id);
    await getDb().prepare("INSERT INTO hire_records (booking_id, deposit) VALUES (?, 25)").run(whole.id);
    expect((await returnHire(whole.code, { condition: "ok" })).ok).toBe(true);
    const back = (await getDb().prepare("SELECT returned_via FROM hire_records WHERE booking_id = ?").get(whole.id)) as { returned_via: string | null };
    expect(back.returned_via).toBeNull();
  });

  it("over the route: via is cash, qr, transfer or card, and the log says how it was held", async () => {
    const court = await fleet(30);
    const a = await running(court.id);
    const take = (body: Record<string, unknown>) => hireRoute.POST(new NextRequest("http://localhost/api/admin/hire", { method: "POST", headers: { cookie: asDesk, "content-type": "application/json" }, body: JSON.stringify({ code: a.code, action: "take", ...body }) }));
    expect((await take({ via: "bitcoin" })).status).toBe(400);
    expect((await take({})).status).toBe(409);
    expect((await take({ via: "cash" })).status).toBe(200);
    expect((await listActivity([venueId])).some((x) => x.action === "hire.taken" && x.bookingCode === a.code && x.detail?.includes("(cash)"))).toBe(true);
    const row = (await getDb().prepare("SELECT taken_by_name FROM hire_records WHERE booking_id = ?").get(a.id)) as { taken_by_name: string };
    expect(row.taken_by_name).toBe("Dee Desk");
  });
});

describe("the cash-up with hire deposits", () => {
  it("lists deposits taken, given back and kept by method, what is still held, and what each till should hold; the reports' liability is the same figure", async () => {
    const court = await fleet(50);
    const date = todayISO(ZONE);
    const before = await cashUp(venueId, date, null);
    const baseHeld = before.deposits.heldTotal;
    const exp = (c: typeof before, m: string) => c.expected.find((e) => e.method === m);
    const baseCash = exp(before, "cash")?.expected ?? 0;
    const baseCard = exp(before, "card")?.expected ?? 0;
    const baseQr = exp(before, "qr")?.expected ?? 0;

    const a = await running(court.id); // cash 50, back whole
    expect((await asDeskStaff(() => takeHire(a.code, 50, "cash"))).ok).toBe(true);
    const b = await running(court.id); // card 40, 10 kept
    expect((await asDeskStaff(() => takeHire(b.code, 40, "card"))).ok).toBe(true);
    const c = await running(court.id); // qr 30, still out
    expect((await asDeskStaff(() => takeHire(c.code, 30, "qr"))).ok).toBe(true);
    expect((await asDeskStaff(() => returnHire(a.code, { condition: "ok" }))).ok).toBe(true);
    expect((await asDeskStaff(() => returnHire(b.code, { condition: "damaged", deductions: [{ reason: "damage", amount: 10 }], note: "Scratched hull" }))).ok).toBe(true);

    const after = await cashUp(venueId, date, null);
    const dep = (m: string) => after.deposits.byMethod.find((x) => x.method === m);
    const was = (m: string) => before.deposits.byMethod.find((x) => x.method === m);
    expect(dep("cash")).toMatchObject({ taken: (was("cash")?.taken ?? 0) + 50, givenBack: (was("cash")?.givenBack ?? 0) + 50 });
    expect(dep("card")).toMatchObject({ taken: (was("card")?.taken ?? 0) + 40, givenBack: (was("card")?.givenBack ?? 0) + 30, kept: (was("card")?.kept ?? 0) + 10 });
    expect(dep("qr")).toMatchObject({ taken: (was("qr")?.taken ?? 0) + 30, givenBack: was("qr")?.givenBack ?? 0 });
    // Still held for customers: the QR 30 only.
    expect(after.deposits.heldTotal).toBeCloseTo(baseHeld + 30, 2);
    expect(after.deposits.held.find((h) => h.method === "qr")!.amount).toBeGreaterThanOrEqual(30);
    // The one definition: the reports' liability is the venue's deposits held now.
    const owed = (await venueReport(venueId, date, addDays(date, 1)))!.liabilities.owed;
    expect(owed.hireDeposits).toBe((await hireDepositsHeld(venueId)).total);
    expect(owed.hireDeposits).toBeCloseTo(after.deposits.heldTotal, 2);
    // Deposits are not takings: the kept 10 is the only money in the day's takings (card), as a sale.
    expect(after.byMethod.find((m) => m.method === "card")!.taken).toBeCloseTo((before.byMethod.find((m) => m.method === "card")?.taken ?? 0) + 10, 2);
    // What each till should hold: the journal's net plus deposits taken less every deposit let go of (the kept part is already a sale).
    expect(exp(after, "cash")!.expected).toBeCloseTo(baseCash, 2); // 50 in, 50 out
    expect(exp(after, "card")!.expected).toBeCloseTo(baseCard + 10, 2); // 40 held, 30 back, 10 kept: +10
    expect(exp(after, "qr")!.expected).toBeCloseTo(baseQr + 30, 2); // still in the account
    // One member of staff's: who took and gave back each is kept; another's sees none of them.
    const mine = await cashUp(venueId, date, deskId);
    expect(mine.deposits.entries.filter((e) => [a.code, b.code, c.code].includes(e.bookingCode))).toHaveLength(5);
    const theirs = await cashUp(venueId, date, otherDeskId);
    expect(theirs.deposits.entries.some((e) => [a.code, b.code, c.code].includes(e.bookingCode))).toBe(false);
  });

  it("a deposit taken on one day and given back on the next is held at the end of the first", async () => {
    const court = await fleet(60);
    const a = await running(court.id);
    expect((await takeHire(a.code, 60, "cash")).ok).toBe(true);
    const date = todayISO(ZONE);
    // Put its handover on yesterday: held at the end of yesterday, and given back today.
    await getDb().prepare("UPDATE hire_records SET taken_at = ? WHERE booking_id = ?").run(`${addDays(date, -1)} 04:00:00`, a.id);
    const yesterday = await cashUp(venueId, addDays(date, -1), null);
    expect(yesterday.deposits.entries.some((e) => e.bookingCode === a.code && e.event === "taken")).toBe(true);
    expect(yesterday.deposits.held.some((h) => h.method === "cash" && h.amount >= 60)).toBe(true);
    expect((await returnHire(a.code, { condition: "ok" })).ok).toBe(true);
    const yesterdayAgain = await cashUp(venueId, addDays(date, -1), null);
    expect(yesterdayAgain.deposits.heldTotal).toBe(yesterday.deposits.heldTotal);
    const today = await cashUp(venueId, date, null);
    expect(today.deposits.entries.some((e) => e.bookingCode === a.code && e.event === "returned")).toBe(true);
  });
});

describe("what the cashier counted", () => {
  it("is recorded with the variance against what was expected, worked out by the server, per till and per person; a recount is another record, the latest counting", async () => {
    const date = todayISO(ZONE);
    const own = await cashUp(venueId, date, deskId);
    const expectedCash = own.expected.find((e) => e.method === "cash")!.expected;
    // The caller cannot say what was expected; only what was counted.
    const res = await post(asDesk, { venueId, date, counts: [{ method: "cash", counted: expectedCash - 5, expected: 9999 }, { method: "card", counted: own.expected.find((e) => e.method === "card")!.expected }], note: "Gave a RM5 refund from the float" });
    expect(res.status).toBe(200);
    const first = (await res.json()).counts as { method: string; counted: number; expected: number; variance: number; note: string }[];
    expect(first.find((c) => c.method === "cash")).toMatchObject({ counted: expectedCash - 5, expected: expectedCash, variance: -5, note: "Gave a RM5 refund from the float" });
    expect(first.find((c) => c.method === "card")!.variance).toBe(0);
    // The sheet shows it, for this person's cash-up and not for everybody's.
    expect((await cashUp(venueId, date, deskId)).counts.find((c) => c.method === "cash")).toMatchObject({ variance: -5, countedBy: "Dee Desk" });
    expect((await cashUp(venueId, date, null)).counts).toEqual([]);
    // A recount: another record, and it counts; the first stays.
    expect((await post(asDesk, { venueId, date, counts: [{ method: "cash", counted: expectedCash }] })).status).toBe(200);
    expect((await cashUp(venueId, date, deskId)).counts.find((c) => c.method === "cash")).toMatchObject({ variance: 0 });
    const rows = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM cash_up_counts WHERE venue_id = ? AND method = 'cash' AND scope_staff_id = ?").get(venueId, deskId)) as { n: number };
    expect(rows.n).toBe(2);
    // A manager counts everybody's.
    expect((await post(asManager, { venueId, date, counts: [{ method: "cash", counted: 1 }] })).status).toBe(200);
    expect((await cashUp(venueId, date, null)).counts.find((c) => c.method === "cash")).toMatchObject({ counted: 1 });
    expect((await listActivity([venueId])).filter((a) => a.action === "cashup.counted").length).toBeGreaterThanOrEqual(3);
  });

  it("is refused for a method that is not a till, an amount that is not money, nothing counted, another's shift or another day", async () => {
    const date = todayISO(ZONE);
    for (const counts of [[], [{ method: "online", counted: 5 }], [{ method: "cash", counted: -1 }], [{ method: "cash", counted: 1.005 }], [{ method: "cash", counted: "5" }], [{ method: "cash", counted: 1 }, { method: "cash", counted: 2 }]])
      expect((await post(asDesk, { venueId, date, counts })).status).toBe(400);
    // Front desk counts its own, today or yesterday; not somebody else's, not another day.
    expect((await post(asDesk, { venueId, date, staffId: otherDeskId, counts: [{ method: "cash", counted: 1 }] })).status).toBe(403);
    expect((await post(asDesk, { venueId, date: addDays(date, -5), counts: [{ method: "cash", counted: 1 }] })).status).toBe(403);
    expect((await post(asOtherDesk, { venueId, date, counts: [{ method: "cash", counted: 3 }] })).status).toBe(200);
    expect((await cashUp(venueId, date, deskId)).counts.find((c) => c.method === "cash")!.counted).toBe((await cashUp(venueId, date, deskId)).expected.find((e) => e.method === "cash")!.expected);
    // Another venue's staff cannot count this venue's.
    const elsewhere = await createVenue({ name: "Elsewhere", area: "PJ", address: "y", phone: "0377772222" });
    if (!elsewhere.ok) throw new Error("venue");
    const stranger = await createAdmin({ name: "Stan", email: "stan@kayak.my", password: "manager-password-3", venueId: elsewhere.venue.id });
    if (!stranger.ok) throw new Error("admin");
    const cookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(stranger.admin.id)).token}`;
    expect((await post(cookie, { venueId, date, counts: [{ method: "cash", counted: 1 }] })).status).toBe(403);
  });
});
