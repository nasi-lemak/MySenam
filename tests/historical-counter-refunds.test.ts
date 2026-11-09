import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { GET as historicalGet, POST as historicalPost } from "../src/app/api/admin/bookings/owed/historical/route";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { registerUser } from "../src/lib/auth";
import { cashUp, saveCashUpCount } from "../src/lib/cash-up";
import { counterOwed, counterPayoutsOn, owedRefund, settleOwed, type CancellingStaff } from "../src/lib/counter-refunds";
import { getDb } from "../src/lib/db";
import {
  HISTORICAL_REFUSALS,
  historicalCandidates,
  historicalRecords,
  obligationSince,
  previewHistorical,
  readHistorical,
  recordHistorical,
  type HistoricalCandidate,
  type HistoricalInput,
} from "../src/lib/historical-counter-refunds";
import { withdrawPlace } from "../src/lib/place-withdrawals";
import { createResources } from "../src/lib/resources";
import { cancelBooking, cancelUserBooking, createBooking, createBookingSeries, createCourt, createVenue, rescheduleBooking, setPaymentStatus } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * Brief HIST (ADR 0078): a customer's cancellation of a counter-paid booking (or a person they took off) from before migration 0346 wrote only
 * its credit note. A manager records what the evidence shows, once, as a settled, historical row of the list of money owed back: handed back
 * earlier (no payout, no till changes), handed back now (a payout today's cash-up counts), or part of each, with what is left and why. The
 * credit note's own day, already counted as cash leaving the till, is never rewritten.
 *
 * Legacy rows are made the way they were: the customer cancels, the owed row the current code writes is removed (0346 did not exist), and the
 * credit note is dated on a past day before 0346 was applied. Each scenario has its own run of past days; nothing depends on the time of day.
 */

const ZONE = "Asia/Kuala_Lumpur";
const today = () => todayISO(ZONE);
const at = (h: number) => h * 60;

let venueId: number;
let otherVenueId: number;
let flat: number; // RM20
let dear: number; // RM60
let cheap: number; // RM25
let pool: number; // RM10 a place
let manager: CancellingStaff & { id: number };
let manager2: CancellingStaff & { id: number };
let otherManager: CancellingStaff & { id: number };
let managerCookie: string;
let deskCookie: string;
let otherManagerCookie: string;
let n = 0;
let slotN = 0;
let run = 0;
const phone = () => `0178${String(100000 + ++n)}`;

/** Paid on P, cancelled on D, perhaps handed back on E: a run of past days of its own for each scenario, all in early 2026. */
function days() {
  const P = addDays("2026-01-05", 5 * run++);
  return { P, D: addDays(P, 1), E: addDays(P, 2) };
}
const local = (day: string) => `${day} 04:00:00`;

function slot() {
  const k = slotN++;
  return { date: addDays(today(), 3 + Math.floor(k / 12)), hour: 8 + (k % 12) };
}

async function paidAtCounter(court: number, via: "cash" | "qr" | "card" | "transfer" | null = "cash") {
  const s = slot();
  const ph = phone();
  const made = await createBooking({ courtId: court, date: s.date, hours: [s.hour], name: "Aina", phone: ph, email: "aina@hist.test" });
  if (!made.ok) throw new Error(JSON.stringify(made));
  const paid = await setPaymentStatus(made.booking.code, true, via);
  if (!paid.ok) throw new Error(paid.error);
  return { booking: made.booking, phone: ph, ...s };
}

const db = () => getDb();
const whenPaid = (bookingId: number, day: string) => db().prepare("UPDATE bookings SET paid_at = ? WHERE id = ?").run(local(day), bookingId);
const whenNote = (source: string, day: string) => db().prepare("UPDATE receipts SET issued_at = ? WHERE kind = 'credit_note' AND source = ?").run(local(day), source);
const noteOf = async (source: string) => (await db().prepare("SELECT id, number, total::float AS total, issued_at FROM receipts WHERE kind = 'credit_note' AND source = ?").get(source)) as { id: number; number: string; total: number; issued_at: string };
const payoutsOf = async (bookingId: number) =>
  (await db().prepare("SELECT id, amount::float AS amount, via, credit_note_id, historical_reconciliation, admin_name, paid_out_at FROM counter_payouts WHERE booking_id = ? ORDER BY id").all(bookingId)) as {
    id: number; amount: number; via: string | null; credit_note_id: number | null; historical_reconciliation: boolean; admin_name: string; paid_out_at: string;
  }[];
const owedOf = async (bookingId: number) =>
  (await db()
    .prepare(
      `SELECT id, cause, amount::float AS amount, via, owed_since, settled_at, outcome, admin_name, settled_via, withdrawal_id, historical_finding,
              historical_earlier_amount::float AS earlier_amount, historical_earlier_on::text AS earlier_on, historical_earlier_via,
              historical_now_amount::float AS now_amount, historical_remainder::float AS remainder, historical_remainder_reason, historical_evidence,
              historical_reason, historical_verified_by_admin_id, historical_verified_by_name, historical_counted_days_acknowledged
         FROM counter_refunds_owed WHERE booking_id = ? ORDER BY id`
    )
    .all(bookingId)) as Record<string, unknown>[];
const counts = async () =>
  (await db()
    .prepare(
      `SELECT (SELECT COUNT(*) FROM counter_refunds_owed)::int AS owed, (SELECT COUNT(*) FROM counter_payouts)::int AS payouts,
              (SELECT COUNT(*) FROM receipts)::int AS receipts, (SELECT COUNT(*) FROM wallet_entries)::int AS wallet,
              (SELECT COUNT(*) FROM staff_actions WHERE action = 'payment.historical_reconciled')::int AS logged`
    )
    .get()) as Record<string, number>;

/** A customer's cancellation from before 0346: the owed row the code writes now is taken away, and the credit note dated D. */
async function legacyCancel(court: number, via: "cash" | "qr" | "card" | "transfer" | null = "cash") {
  const { P, D, E } = days();
  const b = await paidAtCounter(court, via);
  await whenPaid(b.booking.id, P);
  expect((await cancelBooking(b.booking.code, b.phone)).ok).toBe(true);
  await db().prepare("DELETE FROM counter_refunds_owed WHERE booking_id = ? AND cause = 'customer_cancelled'").run(b.booking.id);
  await whenNote(`booking:${b.booking.id}`, D);
  const note = await noteOf(`booking:${b.booking.id}`);
  return { ...b, P, D, E, note };
}

const candidate = async (noteId: number): Promise<HistoricalCandidate | undefined> => (await historicalCandidates(null)).find((c) => c.creditNoteId === noteId);

function input(noteId: number, over: Partial<HistoricalInput> = {}): HistoricalInput {
  return {
    creditNoteId: noteId,
    finding: "now",
    earlier: null,
    now: { amount: 20, via: "cash" },
    evidence: "Till sheet of that day, no payout written; customer asked by phone",
    reason: "Customer confirmed nothing was handed back",
    remainderReason: null,
    acknowledgeCountedDays: false,
    ...over,
  };
}

/** One day's cash-up: the expected amount per till, and what the day says was handed back and is still owed. */
async function till(day: string) {
  const up = await cashUp(venueId, day, null);
  const e = (m: string) => up.expected.find((x) => x.method === m)?.expected ?? 0;
  return { up, cash: e("cash"), qr: e("qr"), handed: up.refunds.handed, owed: up.refunds.owedTotal, notes: up.expected.map((x) => [x.method, x.refundNotes]) };
}

const request = (method: "GET" | "POST", cookie: string, body?: object) =>
  new NextRequest("http://localhost/api/admin/bookings/owed/historical", { method, headers: { cookie, "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}) });

beforeAll(async () => {
  await ensureBootstrapAdmin();
  const make = async (name: string, ph: string) => {
    const v = await createVenue({ name, area: "Ipoh", address: "x", phone: ph, openMin: at(7), closeMin: at(23) });
    if (!v.ok) throw new Error("venue");
    await getDb().prepare("UPDATE venues SET published_at = datetime('now') WHERE id = ?").run(v.venue.id);
    return v.venue.id;
  };
  const court = async (venue: number, name: string, rate: number) => {
    const c = await createCourt({ venueId: venue, name, sport: "badminton", offPeakRate: rate, peakRate: rate, capacity: 1 });
    if (!c.ok) throw new Error(c.error);
    return c.court.id;
  };
  venueId = await make("Hist Hall", "0355550401");
  otherVenueId = await make("Hist Other Hall", "0355550402");
  flat = await court(venueId, "Flat", 20);
  dear = await court(venueId, "Dear", 60);
  cheap = await court(venueId, "Cheap", 25);
  const r = await createResources({ venueId, sport: "swimming", name: "Pool", offPeakRate: 10, peakRate: 10, capacity: 4, maxPlayers: 4 });
  if (!r.ok) throw new Error(r.error);
  pool = r.courts[0].id;
  const staff = async (name: string, email: string, venue: number, role: "manager" | "desk") => {
    const a = await createAdmin({ name, email, password: "a long enough password", venueId: venue, role });
    if (!a.ok) throw new Error("staff");
    return { staff: { id: a.admin.id, name: a.admin.name, role: a.admin.role }, cookie: `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(a.admin.id)).token}` };
  };
  const m = await staff("Mona Manager", "mona@hist.test", venueId, "manager");
  const m2 = await staff("Mike Manager", "mike@hist.test", venueId, "manager");
  const d = await staff("Dani Desk", "dani@hist.test", venueId, "desk");
  const o = await staff("Omar Other", "omar@hist.test", otherVenueId, "manager");
  manager = m.staff as typeof manager;
  manager2 = m2.staff as typeof manager;
  otherManager = o.staff as typeof manager;
  managerCookie = m.cookie;
  deskCookie = d.cookie;
  otherManagerCookie = o.cookie;
});

afterEach(() => vi.useRealTimers());

describe("the list of cancellations to review", () => {
  it("lists a pre-0346 customer cancellation per credit note, with its evidence, and no customer contact details", async () => {
    const l = await legacyCancel(flat, "qr");
    const c = await candidate(l.note.id);
    expect(c).toMatchObject({
      kind: "cancellation",
      venueId,
      venueName: "Hist Hall",
      bookingId: l.booking.id,
      bookingCode: l.booking.code,
      withdrawalId: null,
      creditNote: l.note.number,
      noteTotal: 20,
      noteDay: l.D,
      paidWith: "qr",
      logEvidence: [],
      otherNotes: { count: 0, total: 0 },
      storedCredit: 0,
      paidOutOnBooking: 0,
      possibleDuplicate: false,
    });
    expect(JSON.stringify(c)).not.toMatch(/Aina|aina@|0178/);
    expect(await obligationSince()).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("leaves out a cancellation written after 0346 (it has its owed row), one after 0346 without one, a staff cancellation, and another venue's from its managers", async () => {
    const owedNow = await paidAtCounter(flat);
    await cancelBooking(owedNow.booking.code, owedNow.phone);
    // After 0346 was applied, even without an owed row: not a pre-0346 cancellation.
    const recent = await paidAtCounter(flat);
    await cancelBooking(recent.booking.code, recent.phone);
    await db().prepare("DELETE FROM counter_refunds_owed WHERE booking_id = ?").run(recent.booking.id);
    // Logged as cancelled by staff.
    const byStaff = await legacyCancel(flat);
    await db().prepare("INSERT INTO staff_actions (admin_name, venue_id, booking_code, action, detail) VALUES ('Mona Manager', ?, ?, 'booking.cancelled', 'x')").run(venueId, byStaff.booking.code);
    const all = await historicalCandidates(null);
    const codes = all.map((c) => c.bookingCode);
    expect(codes).not.toContain(owedNow.booking.code);
    expect(codes).not.toContain(recent.booking.code);
    expect(codes).not.toContain(byStaff.booking.code);
    const mine = await legacyCancel(flat);
    expect((await historicalCandidates([venueId])).map((c) => c.creditNoteId)).toContain(mine.note.id);
    expect((await historicalCandidates([otherVenueId])).map((c) => c.creditNoteId)).not.toContain(mine.note.id);
    expect(await historicalCandidates([])).toEqual([]);
  });

  it("lists the same credit notes as the read-only script", async () => {
    await legacyCancel(flat, "card");
    const script = fs.readFileSync(path.join(__dirname, "..", "scripts", "reconcile-counter-cancellations.sql"), "utf8");
    const rows = (await db().prepare(script).all()) as { credit_note: string; booking_code: string; what: string }[];
    const listed = await historicalCandidates(null);
    expect(rows.map((r) => r.credit_note).sort()).toEqual(listed.map((c) => c.creditNote).sort());
    expect(rows.map((r) => r.what).sort()).toEqual(listed.map((c) => (c.kind === "withdrawal" ? "person taken off" : "cancellation")).sort());
  });
});

describe("handed back at the time (A): no payout, no till changes", () => {
  it("records it settled, historical, with the day, method and evidence; writes no payout, no credit note; no day's cash-up changes", async () => {
    const l = await legacyCancel(flat, "cash");
    const beforeD = await till(l.D);
    const beforeE = await till(l.E);
    const beforeToday = await till(today());
    // The old rule: the credit note left the till on its day.
    expect(beforeD.cash).toBe(-20);
    const before = await counts();

    const done = await recordHistorical(input(l.note.id, { finding: "earlier", earlier: { amount: 20, on: l.E, via: "cash" }, now: null }), manager);
    expect(done).toMatchObject({ ok: true, preview: { amount: 20, remainder: 0, writes: { payout: null, creditNote: false }, today: null, noteDay: { day: l.D }, earlierDay: { day: l.E } } });

    const [row] = await owedOf(l.booking.id);
    expect(row).toMatchObject({
      cause: "customer_cancelled",
      amount: 20,
      via: "cash",
      outcome: "back",
      admin_name: "Mona Manager",
      settled_via: null,
      historical_finding: "earlier",
      earlier_amount: 20,
      earlier_on: l.E,
      historical_earlier_via: "cash",
      now_amount: null,
      remainder: 0,
      historical_verified_by_admin_id: manager.id,
      historical_verified_by_name: "Mona Manager",
    });
    // Recorded now: never the cancellation's date, so no past day's "still owed" changes.
    expect(new Date(String(row.owed_since)).toISOString()).toBe(new Date(String(row.settled_at)).toISOString());
    expect(localDay(String(row.settled_at))).toBe(today());
    expect(await payoutsOf(l.booking.id)).toEqual([]);
    expect(await counts()).toEqual({ ...before, owed: before.owed + 1, logged: before.logged + 1 });
    // No day's till changed: D, E and today.
    expect(await till(l.D)).toEqual(beforeD);
    expect(await till(l.E)).toEqual(beforeE);
    expect((await till(today())).cash).toBe(beforeToday.cash);
    // Off the list to review; on the records as completed; not owed.
    expect(await candidate(l.note.id)).toBeUndefined();
    expect((await counterOwed(null, "manager")).some((o) => o.bookingId === l.booking.id)).toBe(false);
    expect(await owedRefund(Number(row.id), "manager")).toMatchObject({ status: "completed", historical: true, byCustomer: true });
    const record = (await historicalRecords([venueId])).find((r) => r.bookingCode === l.booking.code);
    expect(record).toMatchObject({ finding: "earlier", earlier: { amount: 20, on: l.E, via: "cash" }, now: null, amount: 20, remainder: 0, verifiedBy: "Mona Manager", creditNote: l.note.number });
    // The activity log says what was recorded, plainly.
    const log = (await db().prepare("SELECT admin_name, detail FROM staff_actions WHERE action = 'payment.historical_reconciled' AND booking_code = ?").get(l.booking.code)) as { admin_name: string; detail: string };
    expect(log.admin_name).toBe("Mona Manager");
    expect(log.detail).toContain(`handed back on ${l.E}`);
    expect(log.detail).toContain(l.note.number);
  });
});

describe("handed back now (B): a payout today, the note's day as it was", () => {
  it("writes the payout dated now on the old credit note, marked; today's cash-up counts it; the cancellation day is unchanged", async () => {
    const l = await legacyCancel(flat, "cash");
    const beforeD = await till(l.D);
    const beforeToday = await till(today());
    const note = await noteOf(`booking:${l.booking.id}`);
    const done = await recordHistorical(input(l.note.id), manager);
    expect(done).toMatchObject({ ok: true, preview: { writes: { payout: { amount: 20, via: "cash" } }, today: { day: today(), amount: 20, via: "cash" } } });
    const [p] = await payoutsOf(l.booking.id);
    expect(p).toMatchObject({ amount: 20, via: "cash", credit_note_id: l.note.id, historical_reconciliation: true, admin_name: "Mona Manager" });
    expect(localDay(String(p.paid_out_at))).toBe(today());
    // The cancellation's day: exactly as it was counted (the note is not "linked" by this payout or this owed row).
    expect(await till(l.D)).toEqual(beforeD);
    // Today: the till hands back RM20 in cash, as a payout.
    const after = await till(today());
    expect(Math.round((after.cash - beforeToday.cash) * 100) / 100).toBe(-20);
    expect(after.handed.find((h) => h.reference === l.booking.code)).toMatchObject({ amount: 20, method: "cash", countedAs: "payout", creditNote: l.note.number });
    expect((await counterPayoutsOn([venueId], today())).find((x) => x.bookingCode === l.booking.code)).toMatchObject({ amount: 20, via: "cash", creditNote: l.note.number });
    // The credit note is never edited, and none is written.
    expect(await noteOf(`booking:${l.booking.id}`)).toEqual(note);
    const [row] = await owedOf(l.booking.id);
    expect(row).toMatchObject({ historical_finding: "now", now_amount: 20, earlier_amount: null, amount: 20, remainder: 0 });
    expect((await db().prepare("SELECT COUNT(*)::int AS n FROM staff_actions WHERE action = 'payment.paid_out' AND booking_code = ?").get(l.booking.code)) as { n: number }).toEqual({ n: 1 });
  });

  it("paid by QR, handed back now in cash: the cash drawer pays, the QR account is untouched, both methods kept", async () => {
    const l = await legacyCancel(flat, "qr");
    const beforeToday = await till(today());
    expect((await recordHistorical(input(l.note.id, { now: { amount: 20, via: "cash" } }), manager)).ok).toBe(true);
    const after = await till(today());
    expect(Math.round((after.cash - beforeToday.cash) * 100) / 100).toBe(-20);
    expect(after.qr).toBe(beforeToday.qr);
    expect((await owedOf(l.booking.id))[0]).toMatchObject({ via: "qr", settled_via: "cash" });
    expect((await payoutsOf(l.booking.id))[0]).toMatchObject({ via: "cash" });
  });
});

describe("part earlier, part now, and what is left", () => {
  it("records both parts and a remainder with its reason; refuses a remainder without one, and more than the note", async () => {
    const l = await legacyCancel(flat, "cash");
    const both = (over: Partial<HistoricalInput>) =>
      input(l.note.id, { finding: "earlier_and_now", earlier: { amount: 8, on: l.D, via: "cash" }, now: { amount: 7, via: "transfer" }, ...over });
    expect(await recordHistorical(both({}), manager)).toEqual({ ok: false, error: HISTORICAL_REFUSALS.remainder });
    expect(await recordHistorical(both({ now: { amount: 13, via: "transfer" } }), manager)).toEqual({ ok: false, error: HISTORICAL_REFUSALS.tooMuch });
    const beforeD = await till(l.D);
    const done = await recordHistorical(both({ remainderReason: "The venue kept RM5 for the broken racket, agreed with the customer" }), manager);
    expect(done).toMatchObject({ ok: true, preview: { amount: 15, remainder: 5 } });
    expect((await owedOf(l.booking.id))[0]).toMatchObject({
      historical_finding: "earlier_and_now",
      amount: 15,
      earlier_amount: 8,
      now_amount: 7,
      remainder: 5,
      historical_remainder_reason: "The venue kept RM5 for the broken racket, agreed with the customer",
    });
    expect(await payoutsOf(l.booking.id)).toMatchObject([{ amount: 7, via: "transfer", historical_reconciliation: true }]);
    expect(await till(l.D)).toEqual(beforeD);
    const record = (await historicalRecords([venueId])).find((r) => r.bookingCode === l.booking.code)!;
    expect(record).toMatchObject({ earlier: { amount: 8 }, now: { amount: 7, via: "transfer" }, remainder: 5 });
  });
});

describe("refusals: what is not enough is not saved, and the case stays on the list", () => {
  it("needs a finding, evidence, a reason, complete parts, and an earlier day between the cancellation and yesterday; there is no 'not owed'", async () => {
    const l = await legacyCancel(flat);
    const base = { creditNoteId: l.note.id, finding: "now", now: { amount: 20, via: "cash" }, evidence: "Till sheet", reason: "Customer asked" };
    expect(readHistorical({ ...base, finding: "not_owed" })).toEqual({ ok: false, error: HISTORICAL_REFUSALS.finding });
    expect(readHistorical({ ...base, evidence: "  " })).toEqual({ ok: false, error: HISTORICAL_REFUSALS.evidence });
    expect(readHistorical({ ...base, reason: "" })).toEqual({ ok: false, error: HISTORICAL_REFUSALS.reason });
    expect(readHistorical({ ...base, now: { amount: 0, via: "cash" } })).toEqual({ ok: false, error: HISTORICAL_REFUSALS.now });
    expect(readHistorical({ ...base, now: { amount: 20, via: "cheque" } })).toEqual({ ok: false, error: HISTORICAL_REFUSALS.now });
    expect(readHistorical({ ...base, finding: "earlier", earlier: { amount: 20, via: "cash" } })).toEqual({ ok: false, error: HISTORICAL_REFUSALS.earlier });
    expect(readHistorical({ ...base, now: { amount: 20.005, via: "cash" } })).toEqual({ ok: false, error: HISTORICAL_REFUSALS.now });
    const early = await recordHistorical(input(l.note.id, { finding: "earlier", earlier: { amount: 20, on: addDays(l.D, -1), via: "cash" }, now: null }), manager);
    expect(early).toEqual({ ok: false, error: HISTORICAL_REFUSALS.earlierDay });
    const todays = await recordHistorical(input(l.note.id, { finding: "earlier", earlier: { amount: 20, on: today(), via: "cash" }, now: null }), manager);
    expect(todays).toEqual({ ok: false, error: HISTORICAL_REFUSALS.earlierDay });
    // Through the route: the same refusals, nothing written, the case still listed.
    const before = await counts();
    const res = await historicalPost(request("POST", managerCookie, { ...base, evidence: "" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe(HISTORICAL_REFUSALS.evidence);
    expect(await counts()).toEqual(before);
    expect(await candidate(l.note.id)).toBeDefined();
  });
});

describe("once: a duplicate submission and two managers at the same moment", () => {
  it("a second submission is refused as already recorded and writes nothing", async () => {
    const l = await legacyCancel(flat);
    expect((await recordHistorical(input(l.note.id), manager)).ok).toBe(true);
    const before = await counts();
    expect(await recordHistorical(input(l.note.id), manager)).toEqual({ ok: false, error: HISTORICAL_REFUSALS.already });
    expect(await recordHistorical(input(l.note.id, { finding: "earlier", earlier: { amount: 20, on: l.D, via: "cash" }, now: null }), manager2)).toEqual({ ok: false, error: HISTORICAL_REFUSALS.already });
    expect(await counts()).toEqual(before);
    const res = await historicalPost(request("POST", managerCookie, { creditNoteId: l.note.id, finding: "now", now: { amount: 20, via: "cash" }, evidence: "x", reason: "y" }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(HISTORICAL_REFUSALS.already);
  });

  it("two managers recording the same note at once: exactly one record and one payout", async () => {
    const l = await legacyCancel(flat);
    const before = await counts();
    const results = await Promise.all([recordHistorical(input(l.note.id), manager), recordHistorical(input(l.note.id), manager2)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    expect(results.filter((r) => !r.ok)).toEqual([{ ok: false, error: HISTORICAL_REFUSALS.already }]);
    expect(await owedOf(l.booking.id)).toHaveLength(1);
    expect(await payoutsOf(l.booking.id)).toHaveLength(1);
    expect(await counts()).toMatchObject({ owed: before.owed + 1, payouts: before.payouts + 1, receipts: before.receipts, logged: before.logged + 1 });
  });
});

describe("a day with a till count recorded", () => {
  it("previews who counted it and when, and needs the manager's explicit acknowledgement", async () => {
    const l = await legacyCancel(flat);
    const counted = await saveCashUpCount(await cashUp(venueId, l.D, null), { id: manager2.id, name: manager2.name }, [{ method: "cash", counted: 0 }], null);
    expect(counted.ok).toBe(true);
    const ask = input(l.note.id, { finding: "earlier", earlier: { amount: 20, on: l.D, via: "cash" }, now: null });
    const preview = await previewHistorical(ask);
    expect(preview).toMatchObject({ ok: true, preview: { needsAcknowledgement: true, noteDay: { day: l.D, counts: [{ by: "Mike Manager" }] }, today: null } });
    const before = await counts();
    // The preview wrote nothing.
    expect(await counts()).toEqual(before);
    expect(await recordHistorical(ask, manager)).toEqual({ ok: false, error: HISTORICAL_REFUSALS.acknowledge });
    expect(await counts()).toEqual(before);
    const beforeD = await till(l.D);
    expect((await recordHistorical({ ...ask, acknowledgeCountedDays: true }, manager)).ok).toBe(true);
    expect((await owedOf(l.booking.id))[0]).toMatchObject({ historical_counted_days_acknowledged: true });
    // The counted day is exactly as it was counted: the count, the expected amount and its variance.
    const afterD = await till(l.D);
    expect(afterD).toEqual(beforeD);
    expect(afterD.up.counts).toMatchObject([{ method: "cash", counted: 0, expected: -20, variance: 20 }]);
  });

  it("an uncounted day needs nothing", async () => {
    const l = await legacyCancel(flat);
    expect(await previewHistorical(input(l.note.id))).toMatchObject({ ok: true, preview: { needsAcknowledgement: false, noteDay: { counts: [] }, today: { counts: [] } } });
  });
});

describe("several obligations on one booking, and a booking moved cheaper first", () => {
  it("a pre-0346 withdrawal note and a cancellation note on one booking: two candidates, two records", async () => {
    const { D } = days();
    const who = await registerUser({ name: "Pool Person", email: `pool${++n}@hist.test`, phone: phone(), password: "a long enough password" });
    if (!who.ok) throw new Error(who.error);
    const s = slot();
    const made = await createBookingSeries({ weeks: 1, name: "Pool Person", phone: who.user.phone, userId: who.user.id, by: "staff", date: s.date, start: at(s.hour), end: at(s.hour + 1), courtId: pool, players: 3 });
    if (!made.ok) throw new Error(made.error);
    const booking = made.bookings[0];
    expect((await setPaymentStatus(booking.code, true, "cash")).ok).toBe(true);
    const w = await withdrawPlace(booking.id, { unnamed: 1 }, { kind: "customer", userId: who.user.id, name: "Pool Person" });
    expect(w.ok).toBe(true);
    expect((await cancelUserBooking(who.user.id, booking.id)).ok).toBe(true);
    // Before 0346: neither wrote an owed row.
    await db().prepare("DELETE FROM counter_refunds_owed WHERE booking_id = ?").run(booking.id);
    const wid = ((await db().prepare("SELECT id FROM place_withdrawals WHERE booking_id = ?").get(booking.id)) as { id: number }).id;
    await whenNote(`booking:${booking.id}:place:${wid}`, D);
    await whenNote(`booking:${booking.id}`, D);
    const placeNote = await noteOf(`booking:${booking.id}:place:${wid}`);
    const wholeNote = await noteOf(`booking:${booking.id}`);
    const listed = (await historicalCandidates([venueId])).filter((c) => c.bookingId === booking.id);
    expect(listed.map((c) => [c.kind, c.noteTotal, c.withdrawalId]).sort()).toEqual([
      ["cancellation", 20, null],
      ["withdrawal", 10, wid],
    ]);
    // Each shows the other as possible duplicate evidence.
    expect(listed.every((c) => c.otherNotes.count === 1 && c.possibleDuplicate)).toBe(true);
    expect((await recordHistorical(input(placeNote.id, { now: { amount: 10, via: "cash" } }), manager)).ok).toBe(true);
    expect((await recordHistorical(input(wholeNote.id, { finding: "earlier", earlier: { amount: 20, on: D, via: "cash" }, now: null }), manager)).ok).toBe(true);
    const rows = await owedOf(booking.id);
    expect(rows.map((r) => [r.cause, r.amount, r.withdrawal_id, r.historical_finding])).toEqual([
      ["place_withdrawn", 10, wid, "now"],
      ["customer_cancelled", 20, null, "earlier"],
    ]);
    expect(await payoutsOf(booking.id)).toMatchObject([{ amount: 10, credit_note_id: placeNote.id, historical_reconciliation: true }]);
    expect(await recordHistorical(input(placeNote.id, { now: { amount: 10, via: "cash" } }), manager)).toEqual({ ok: false, error: HISTORICAL_REFUSALS.already });
  });

  it("after a cheaper move handed back, the cancellation is listed with what is already back, and cannot record more than its note", async () => {
    const { P, D } = days();
    const b = await paidAtCounter(dear, "cash");
    expect((await rescheduleBooking(b.booking.code, { date: b.date, start: at(b.hour), courtId: cheap }, "customer")).ok).toBe(true);
    const move = (await counterOwed(null, "manager")).find((o) => o.bookingId === b.booking.id && o.cause === "moved_cheaper")!;
    expect(move.amount).toBe(35);
    expect((await settleOwed(move.id, "back", manager)).ok).toBe(true);
    await whenPaid(b.booking.id, P);
    expect((await cancelBooking(b.booking.code, b.phone)).ok).toBe(true);
    await db().prepare("DELETE FROM counter_refunds_owed WHERE booking_id = ? AND cause = 'customer_cancelled'").run(b.booking.id);
    await whenNote(`booking:${b.booking.id}`, D);
    const note = await noteOf(`booking:${b.booking.id}`);
    const c = await candidate(note.id);
    expect(c).toMatchObject({ kind: "cancellation", noteTotal: 25, paidOutOnBooking: 35, otherNotes: { count: 1, total: 35 }, possibleDuplicate: true });
    expect(await recordHistorical(input(note.id, { now: { amount: 26, via: "cash" }, remainderReason: null }), manager)).toEqual({ ok: false, error: HISTORICAL_REFUSALS.tooMuch });
    expect(await recordHistorical(input(note.id, { now: { amount: 25, via: "cash" } }), manager)).toMatchObject({ ok: true });
    // Together with the move's payout: exactly what was paid.
    expect((await payoutsOf(b.booking.id)).map((p) => [p.amount, p.historical_reconciliation])).toEqual([
      [35, false],
      [25, true],
    ]);
  });
});

describe("who may: managers of the venue only", () => {
  it("front desk is refused the list and the record; another venue's manager sees none of it and cannot record it", async () => {
    const l = await legacyCancel(flat);
    const body = { creditNoteId: l.note.id, finding: "now", now: { amount: 20, via: "cash" }, evidence: "Till sheet", reason: "Customer asked" };
    for (const res of [await historicalGet(request("GET", deskCookie)), await historicalPost(request("POST", deskCookie, body))]) {
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("MANAGER_ONLY");
    }
    const other = await (await historicalGet(request("GET", otherManagerCookie))).json();
    expect(other.candidates.map((c: HistoricalCandidate) => c.creditNoteId)).not.toContain(l.note.id);
    const before = await counts();
    const refused = await historicalPost(request("POST", otherManagerCookie, body));
    expect(refused.status).toBe(403);
    expect(await counts()).toEqual(before);
    // The venue's manager: listed, previewed, recorded; then another venue's manager learns nothing more of it.
    const mine = await (await historicalGet(request("GET", managerCookie))).json();
    expect(mine.candidates.map((c: HistoricalCandidate) => c.creditNoteId)).toContain(l.note.id);
    expect(mine.since).toMatch(/^\d{4}-/);
    const preview = await historicalPost(request("POST", managerCookie, { ...body, preview: true }));
    expect(preview.status).toBe(200);
    expect((await preview.json()).preview).toMatchObject({ amount: 20, writes: { payout: { amount: 20, via: "cash" } } });
    expect(await counts()).toEqual(before);
    const saved = await historicalPost(request("POST", managerCookie, body));
    expect(saved.status).toBe(200);
    expect((await saved.json()).recordId).toBeGreaterThan(0);
    const after = await historicalPost(request("POST", otherManagerCookie, body));
    expect(after.status).toBe(404);
    const records = await (await historicalGet(request("GET", otherManagerCookie))).json();
    expect(records.records.map((r: { bookingCode: string }) => r.bookingCode)).not.toContain(l.booking.code);
    expect(otherManager.role).toBe("manager");
  });
});

describe("rows written before 0348 read as they always did", () => {
  it("a settled customer cancellation with its payout (no new columns set) is not historical, and the cash-up still links its note", async () => {
    const { P, D } = days();
    const b = await paidAtCounter(flat, "cash");
    await whenPaid(b.booking.id, P);
    expect((await cancelBooking(b.booking.code, b.phone)).ok).toBe(true);
    const owed = (await counterOwed(null, "manager")).find((o) => o.bookingId === b.booking.id)!;
    expect(owed.historical).toBe(false);
    expect((await settleOwed(owed.id, "back", manager)).ok).toBe(true);
    await whenNote(`booking:${b.booking.id}`, D);
    await db().prepare("UPDATE counter_payouts SET paid_out_at = ?::timestamptz WHERE booking_id = ?").run(`${D}T04:00:00Z`, b.booking.id);
    await db().prepare("UPDATE counter_refunds_owed SET owed_since = ?::timestamptz, settled_at = ?::timestamptz WHERE booking_id = ?").run(`${D}T04:00:00Z`, `${D}T04:00:00Z`, b.booking.id);
    expect((await payoutsOf(b.booking.id))[0].historical_reconciliation).toBe(false);
    const d = await till(D);
    // ADR 0075: the note is put back, the payout taken out, on the same day: RM20 out in all, once.
    expect(d.cash).toBe(-20);
    expect(d.notes).toContainEqual(["cash", 20]);
    expect(await candidate((await noteOf(`booking:${b.booking.id}`)).id)).toBeUndefined();
    expect((await owedRefund(owed.id, "manager"))!.historical).toBe(false);
  });
});

/** A stored moment's day in Kuala Lumpur. */
function localDay(stamp: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(stamp));
}
