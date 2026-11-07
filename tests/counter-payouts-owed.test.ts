import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { listActivity } from "../src/lib/activity";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { cashUp, deskDays } from "../src/lib/cash-up";
import { counterPayoutsOn } from "../src/lib/counter-refunds";
import { getDb } from "../src/lib/db";
import { entryFeesOwed, feePayoutsOn, oweCounterRefund, settleEntryFee } from "../src/lib/entry-fee-refunds";
import {
  cancelBooking,
  createBooking,
  createCourt,
  createVenue,
  getPass,
  issuePass,
  listPassEntries,
  membershipById,
  payBookingWithPass,
  sellMembership,
  voidMembership,
  voidPass,
} from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { cancelTournament, createTournament, enter, setEntry } from "../src/lib/tournaments";
import { registerUser } from "../src/lib/auth";
import * as owedRoute from "../src/app/api/admin/bookings/owed/route";
import * as dayRoute from "../src/app/api/admin/bookings/route";

/**
 * Hardening, brief MONEY, C11 and D1 (ADR 0068): money handed back at the counter for a tournament entry fee, a pass or a membership is one list,
 * in the day's payouts beside the bookings', with who and when; a credit note is the tax document and is not cash paid, so a refund of a pass or
 * a membership sold at the counter is a task until a named member of staff says it was handed over. Run on Postgres too (the settling race).
 */

let venueId: number;
let otherVenue: number;
let courtId: number;
let manager: { id: number; name: string; role: "manager"; cookie: string };
let desk: { id: number; name: string; role: "desk"; cookie: string };
let outsider: { cookie: string };
let n = 0;
let slot = 3;
const today = todayISO();
const phone = () => `0155${String(++n).padStart(6, "0")}`;

async function staff(venue: number, role: "manager" | "desk") {
  const made = await createAdmin({ name: `${role} ${++n}`, email: `m68-${role}${n}@m68.test`, password: "a long enough password", venueId: venue, role });
  if (!made.ok) throw new Error(made.error);
  return { id: made.admin.id, name: made.admin.name, role, cookie: `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(made.admin.id)).token}` };
}

beforeAll(async () => {
  const v = await createVenue({ name: "Handback Hall", area: "PJ", address: "1", phone: "0312345678" });
  const o = await createVenue({ name: "Elsewhere Hall", area: "PJ", address: "2", phone: "0312345679" });
  if (!v.ok || !o.ok) throw new Error("venue");
  venueId = v.venue.id;
  otherVenue = o.venue.id;
  const c = await createCourt({ venueId, name: "C1", sport: "badminton", offPeakRate: 20, peakRate: 20 });
  if (!c.ok) throw new Error("court");
  courtId = c.court.id;
  manager = { ...(await staff(venueId, "manager")), role: "manager" };
  desk = { ...(await staff(venueId, "desk")), role: "desk" };
  outsider = await staff(otherVenue, "manager");
});

const req = (url: string, method: string, cookie: string, body?: unknown) =>
  new NextRequest(url, { method, headers: { "content-type": "application/json", cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const settleVia = (who: { cookie: string }, id: number) => owedRoute.POST(req("http://localhost/api/admin/bookings/owed", "POST", who.cookie, { id, kind: "entry_fee", outcome: "back" }));
const owedList = async (who: { cookie: string }) =>
  ((await (await dayRoute.GET(req(`http://localhost/api/admin/bookings?date=${today}`, "GET", who.cookie))).json()).feesOwed ?? []) as { id: number; kind: string; amount: number }[];
const rowsFor = async (col: "pass_id" | "membership_id" | "tournament_entry_id", id: number) =>
  (await getDb().prepare(`SELECT id, amount::float AS amount, via, cause, settled_at, admin_name, credit_note_id FROM counter_fee_refunds_owed WHERE ${col} = ? ORDER BY id`).all(id)) as {
    id: number;
    amount: number;
    via: string | null;
    cause: string;
    settled_at: string | null;
    admin_name: string | null;
    credit_note_id: number | null;
  }[];
const cashNow = async () => {
  const day = (await deskDays(venueId))[0];
  const up = await cashUp(venueId, day, null);
  return { day, givenBack: (method: string) => up.byMethod.find((m) => m.method === method)?.givenBack ?? 0 };
};
const sellPass = async (ph: string, over: Partial<Parameters<typeof issuePass>[0]> = {}) => {
  const p = await issuePass({ venueId, name: "Ten", entries: 10, price: 100, holderName: "Aisyah", holderPhone: ph, expiresOn: addDays(today, 60), adminId: null, paidVia: "Cash", ...over });
  if (!p.ok) throw new Error(JSON.stringify(p));
  return p.pass;
};

describe("D1: a counter-sold pass cancelled with a refund is a task until it is handed back", () => {
  it("writes the credit note as before and the amount as owed back, open; settled by staff it is in the day's payouts, once", async () => {
    const before = (await cashNow()).givenBack("cash");
    const pass = await sellPass(phone());
    expect((await voidPass(pass.id, { refund: true })).ok).toBe(true);
    const [row] = await rowsFor("pass_id", pass.id);
    expect(row).toMatchObject({ amount: 100, via: "cash", cause: "pass_refunded", settled_at: null, admin_name: null });
    expect(row.credit_note_id).not.toBeNull();
    // The credit note counts in the till as written; it is not cash paid, and nothing says who paid it until staff do.
    expect((await cashNow()).givenBack("cash")).toBe(before + 100);
    expect((await counterPayoutsOn([venueId], today)).some((p) => p.kind === "pass")).toBe(false);
    const listed = (await owedList(manager)).find((f) => f.id === row.id);
    expect(listed).toMatchObject({ kind: "pass", amount: 100 });

    const done = await settleVia(manager, row.id);
    expect(done.status).toBe(200);
    const paid = (await counterPayoutsOn([venueId], today)).find((p) => p.kind === "pass");
    expect(paid).toMatchObject({ id: row.id, amount: 100, via: "cash", adminName: manager.name, bookingCode: "", keptPercent: null });
    expect(paid!.what).toContain(pass.code);
    expect(paid!.creditNote).toMatch(/^CN-/);
    // Settling moves no money in the books: the credit note is the one written at the cancellation.
    expect((await cashNow()).givenBack("cash")).toBe(before + 100);
    expect((await owedList(manager)).some((f) => f.id === row.id)).toBe(false);
    expect((await listActivity([venueId])).some((e) => e.action === "payment.paid_out" && e.detail?.includes("refund of a pass") && e.detail.includes(pass.code))).toBe(true);
    // Said again (a retry, a double click): refused, one payout, one credit note.
    expect((await settleVia(manager, row.id)).status).toBeGreaterThanOrEqual(400);
    expect((await counterPayoutsOn([venueId], today)).filter((p) => p.kind === "pass" && p.id === row.id)).toHaveLength(1);
  });

  it("is written once however the void is repeated, and a pass voided without a refund, or for nothing, owes nothing", async () => {
    const pass = await sellPass(phone());
    const first = await voidPass(pass.id, { refund: true });
    expect(first.ok).toBe(true);
    expect((await voidPass(pass.id, { refund: true })).ok).toBe(false);
    expect(await rowsFor("pass_id", pass.id)).toHaveLength(1);

    const keep = await sellPass(phone());
    expect((await voidPass(keep.id)).ok).toBe(true);
    expect(await rowsFor("pass_id", keep.id)).toHaveLength(0);

    const spentAll = await sellPass(phone(), { entries: 1, price: 20 });
    const b = await createBooking({ courtId, date: addDays(today, ++slot), hours: [9], name: "Aisyah", phone: spentAll.holderPhone });
    if (!b.ok) throw new Error(JSON.stringify(b));
    expect((await payBookingWithPass(b.booking.id, spentAll.code)).ok).toBe(true);
    expect((await voidPass(spentAll.id, { refund: true })).ok).toBe(true);
    expect(await rowsFor("pass_id", spentAll.id)).toHaveLength(0);
  });

  it("two members of staff settling at once hand it back once", async () => {
    const pass = await sellPass(phone());
    await voidPass(pass.id, { refund: true });
    const [row] = await rowsFor("pass_id", pass.id);
    const both = await Promise.all([
      settleVia(manager, row.id).then((r) => r.status === 200),
      settleVia(manager, row.id).then((r) => r.status === 200),
      settleEntryFee(row.id, { id: manager.id, name: manager.name, role: "manager" }).then((r) => r.ok),
    ]);
    expect(both.filter(Boolean)).toHaveLength(1);
    expect((await counterPayoutsOn([venueId], today)).filter((p) => p.id === row.id && p.kind === "pass")).toHaveLength(1);
  });

  it("a pass sold online is owed on its payment, a pass paid with stored credit is not a counter payout: neither is on the list", async () => {
    const online = await sellPass(phone(), { paidVia: "Online (Billplz)" });
    expect((await voidPass(online.id, { refund: true })).ok).toBe(true);
    expect(await rowsFor("pass_id", online.id)).toHaveLength(0);
    const credit = await sellPass(phone(), { paidVia: "Stored credit" });
    expect((await voidPass(credit.id, { refund: true })).ok).toBe(true);
    expect(await rowsFor("pass_id", credit.id)).toHaveLength(0);
  });

  it("the entries a cancelled booking gives back to a pass voided with a refund are handed back as money, and owed the same way", async () => {
    const ph = phone();
    const pass = await sellPass(ph, { entries: 2, price: 40 });
    const b = await createBooking({ courtId, date: addDays(today, ++slot), hours: [10], name: "Aisyah", phone: ph });
    if (!b.ok) throw new Error(JSON.stringify(b));
    expect((await payBookingWithPass(b.booking.id, pass.code)).ok).toBe(true);
    expect((await voidPass(pass.id, { refund: true })).ok).toBe(true);
    const [first] = await rowsFor("pass_id", pass.id);
    expect(first.amount).toBe(20);
    expect((await cancelBooking(b.booking.code, ph)).ok).toBe(true);
    const rows = await rowsFor("pass_id", pass.id);
    expect(rows.map((r) => r.amount)).toEqual([20, 20]);
    expect(new Set(rows.map((r) => r.credit_note_id)).size).toBe(2);
    expect((await getPass(pass.code))!.status).toBe("void");
    expect((await listPassEntries(pass.id)).some((e) => e.reason.includes("handed back as"))).toBe(true);
  });

  it("the front desk hands back a refund written today, a manager one from an earlier day; another venue's staff see and settle nothing of it", async () => {
    const today1 = await sellPass(phone());
    await voidPass(today1.id, { refund: true });
    const [fresh] = await rowsFor("pass_id", today1.id);
    expect((await owedList(outsider)).some((f) => f.id === fresh.id)).toBe(false);
    expect((await settleVia(outsider, fresh.id)).status).toBe(403);
    expect((await settleVia(desk, fresh.id)).status).toBe(200);

    const old = await sellPass(phone());
    await voidPass(old.id, { refund: true });
    const [older] = await rowsFor("pass_id", old.id);
    await getDb().prepare("UPDATE counter_fee_refunds_owed SET owed_since = now() - interval '3 days' WHERE id = ?").run(older.id);
    expect((await settleVia(desk, older.id)).status).toBeGreaterThanOrEqual(400);
    expect(await rowsFor("pass_id", old.id)).toMatchObject([{ settled_at: null }]);
    expect((await settleVia(manager, older.id)).status).toBe(200);
  });
});

describe("D1: a counter-sold membership cancelled with a refund", () => {
  it("is written as owed back, open, and handed back from the list", async () => {
    const m = await sellMembership({ venueId, holderName: "Nurul", holderPhone: phone(), startsOn: today, expiresOn: addDays(today, 30), price: 80, adminId: manager.id });
    if (!m.ok) throw new Error(JSON.stringify(m));
    expect((await voidMembership(m.membership.id, { refund: true })).ok).toBe(true);
    const [row] = await rowsFor("membership_id", m.membership.id);
    expect(row).toMatchObject({ amount: 80, cause: "membership_refunded", settled_at: null });
    expect((await owedList(manager)).find((f) => f.id === row.id)).toMatchObject({ kind: "membership", amount: 80 });
    expect((await settleVia(manager, row.id)).status).toBe(200);
    const paid = (await counterPayoutsOn([venueId], today)).find((p) => p.kind === "membership" && p.id === row.id);
    expect(paid).toMatchObject({ amount: 80, adminName: manager.name });
    expect((await membershipById(m.membership.id))!.status).toBe("void");
  });

  it("owes nothing when cancelled without a refund", async () => {
    const m = await sellMembership({ venueId, holderName: "Nurul", holderPhone: phone(), startsOn: today, expiresOn: addDays(today, 30), price: 80, adminId: manager.id });
    if (!m.ok) throw new Error(JSON.stringify(m));
    expect((await voidMembership(m.membership.id)).ok).toBe(true);
    expect(await rowsFor("membership_id", m.membership.id)).toHaveLength(0);
  });
});

describe("C11: a tournament entry fee handed back at the counter is in the day's payouts and the cash-up", () => {
  it("owed is not paid: listed as owed, in no payout and no credit note; handed back it is in both, once, however often it is asked", async () => {
    const owner = await staff(venueId, "manager");
    const day = addDays(today, 40);
    const made = await createTournament(
      { venueId, name: "Handback Cup", sport: "badminton", format: "knockout", teamSize: 1, level: null, entryFee: 20, maxEntries: 8, startsOn: day, endsOn: day, startHour: 9, endHour: 12, courtIds: [courtId] },
      owner.id
    );
    if (!made.ok) throw new Error(made.error);
    const user = await registerUser({ name: "Player One", email: "p1@m68.test", phone: phone(), password: "a long enough password" });
    if (!user.ok) throw new Error("user");
    const entry = await enter(user.user, made.value.id);
    if (!entry.ok) throw new Error(entry.error);
    expect((await setEntry(entry.value.id, { paid: true, via: "qr" })).ok).toBe(true);
    const before = (await cashNow()).givenBack("qr");
    expect((await cancelTournament(made.value.id)).ok).toBe(true);
    // A repeat of the cancellation owes nothing twice.
    await cancelTournament(made.value.id);
    const [row] = await rowsFor("tournament_entry_id", entry.value.id);
    expect(await rowsFor("tournament_entry_id", entry.value.id)).toHaveLength(1);
    expect(row).toMatchObject({ amount: 20, via: "qr", settled_at: null });
    expect((await counterPayoutsOn([venueId], today)).some((p) => p.kind === "entry")).toBe(false);
    expect((await cashNow()).givenBack("qr")).toBe(before);
    expect((await entryFeesOwed([venueId], "manager")).find((f) => f.id === row.id)).toMatchObject({ kind: "entry", amount: 20 });

    const both = await Promise.all([settleVia(owner, row.id), settleVia(owner, row.id)]);
    expect(both.filter((r) => r.status === 200)).toHaveLength(1);
    const payouts = (await counterPayoutsOn([venueId], today)).filter((p) => p.kind === "entry");
    expect(payouts).toHaveLength(1);
    expect(payouts[0]).toMatchObject({ id: row.id, amount: 20, via: "qr", adminName: owner.name, bookingCode: "" });
    expect(payouts[0].what).toContain("Player One");
    expect(payouts[0].what).toContain("Handback Cup");
    // The credit note is in that day's cash-up under the method it was paid by: the payout list and the till agree.
    expect((await cashNow()).givenBack("qr")).toBe(before + 20);
    // Another day, and another venue, see none of it.
    expect((await counterPayoutsOn([venueId], addDays(today, -1))).some((p) => p.kind === "entry")).toBe(false);
    expect(await counterPayoutsOn([otherVenue], today)).toEqual([]);
    expect(await feePayoutsOn([], today)).toEqual([]);
  });
});

describe("the owed list's table keeps what it held, and takes pass and membership rows (migration 0326)", () => {
  const sql = fs.readFileSync(path.join(__dirname, "../db/migrations/0326_counter_refunds_owed_passes_and_memberships.sql"), "utf8");

  it("can be run again without changing a row, and refuses a row that is for nothing, for two things, or for a cause it does not know", async () => {
    const pass = await sellPass(phone());
    await voidPass(pass.id, { refund: true });
    const rowsBefore = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM counter_fee_refunds_owed").get()) as { n: number };
    await getDb().exec(sql);
    expect((await getDb().prepare("SELECT COUNT(*)::int AS n FROM counter_fee_refunds_owed").get()) as { n: number }).toEqual(rowsBefore);
    const db = getDb();
    const insert = (cols: string, vals: unknown[]) => db.prepare(`INSERT INTO counter_fee_refunds_owed (venue_id, receipt_source, amount, cause, ${cols}) VALUES (?, 'x', 5, ?, ${vals.slice(2).map(() => "?").join(",")})`).run(...vals);
    await expect(insert("tournament_entry_id", [venueId, "before_draw", null])).rejects.toThrow();
    await expect(insert("pass_id, membership_id", [venueId, "pass_refunded", pass.id, 1])).rejects.toThrow();
    await expect(insert("pass_id", [venueId, "refunded", pass.id])).rejects.toThrow();
  });

  it("a credit note is owed once: a second row for the same note is not written", async () => {
    const pass = await sellPass(phone());
    await voidPass(pass.id, { refund: true });
    const [row] = await rowsFor("pass_id", pass.id);
    const note = (await getDb().prepare("SELECT id, total::float AS total, paid_via, venue_id FROM receipts WHERE id = ?").get(row.credit_note_id)) as { id: number; total: number; paid_via: string; venue_id: number };
    expect(await oweCounterRefund({ id: note.id, total: note.total, paidVia: note.paid_via, venueId: note.venue_id }, { passId: pass.id })).toBe(false);
    expect(await rowsFor("pass_id", pass.id)).toHaveLength(1);
  });
});
