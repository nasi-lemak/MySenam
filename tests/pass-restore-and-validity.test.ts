import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { listActivity } from "../src/lib/activity";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { getDb } from "../src/lib/db";
import { documentFor } from "../src/lib/documents";
import { passRestoreGraceDays, setPassRestoreGraceDays } from "../src/lib/pass-validity";
import {
  adminCancelBooking,
  cancelBooking,
  createBooking,
  createCourt,
  createVenue,
  getPass,
  issuePass,
  listPassEntries,
  payBookingWithPass,
  payBookingWithPasses,
  rescheduleBooking,
  usablePassesForHolder,
  voidPass,
} from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import * as extendRoute from "../src/app/api/admin/passes/[id]/extend/route";
import * as settingsRoute from "../src/app/api/admin/pass-settings/route";

/**
 * Audit 9 D1, D4 and H5 (ADR 0062): entries given back to a pass that has ended are not dead; a cancelled pass is never revived, its
 * entry's value is handed back as money; a pass is judged on the day of the session it pays; a manager can extend a pass, with a reason.
 */

let venueId: number;
let otherVenue: number;
let courtId: number;
let manager: { id: number; name: string; cookie: string };
let desk: { id: number; name: string; cookie: string };
let outsider: { cookie: string };
let slot = 0;
const today = todayISO();

async function staff(venue: number, role: "manager" | "desk") {
  const made = await createAdmin({ name: `${role} ${++slot}`, email: `fx8-${role}${slot}@fx8.test`, password: "a long enough password", venueId: venue, role });
  if (!made.ok) throw new Error(made.error);
  return { id: made.admin.id, name: `${role} ${slot}`, cookie: `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(made.admin.id)).token}` };
}

beforeAll(async () => {
  const v = await createVenue({ name: "Pass Restore Hall", area: "PJ", address: "1", phone: "0312345678" });
  if (!v.ok) throw new Error("venue");
  venueId = v.venue.id;
  const o = await createVenue({ name: "Elsewhere Hall", area: "PJ", address: "2", phone: "0312345679" });
  if (!o.ok) throw new Error("venue");
  otherVenue = o.venue.id;
  const c = await createCourt({ venueId, name: "C1", sport: "badminton", offPeakRate: 20, peakRate: 20 });
  if (!c.ok) throw new Error("court");
  courtId = c.court.id;
  manager = await staff(venueId, "manager");
  desk = await staff(venueId, "desk");
  outsider = await staff(otherVenue, "manager");
});

let n = 0;
const phone = () => `0191${String(++n).padStart(6, "0")}`;
async function sell(ph: string, over: Partial<Parameters<typeof issuePass>[0]> = {}) {
  const p = await issuePass({ venueId, name: "Pass", entries: 10, price: 100, holderName: "Aisyah", holderPhone: ph, expiresOn: addDays(today, 60), adminId: null, ...over });
  if (!p.ok) throw new Error(JSON.stringify(p));
  return p.pass;
}
// Each booking its own hour and day, so none of them clash.
async function book(ph: string, offset: number, hours: number[]) {
  const b = await createBooking({ courtId, date: addDays(today, offset), hours, name: "Aisyah", phone: ph });
  if (!b.ok) throw new Error(JSON.stringify(b));
  return b.booking;
}
const age = (passId: number, expiresOn: string) => getDb().prepare("UPDATE passes SET expires_on = ? WHERE id = ?").run(expiresOn, passId);
const creditNotes = async (passId: number) => {
  const receipt = (await documentFor(`pass:${passId}`))!;
  const row = (await getDb().prepare("SELECT COALESCE(SUM(total), 0)::float AS t, COUNT(*)::int AS n FROM receipts WHERE kind = 'credit_note' AND credits_id = ?").get(receipt.id)) as { t: number; n: number };
  return row;
};
const req = (url: string, method: string, cookie: string | null, body?: unknown) =>
  new NextRequest(url, { method, headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
const extendVia = (who: { cookie: string } | null, id: number, body: unknown) =>
  extendRoute.POST(req(`http://localhost/api/admin/passes/${id}/extend`, "POST", who?.cookie ?? null, body), { params: Promise.resolve({ id: String(id) }) });

describe("D1: entries given back to a pass that has ended", () => {
  it("an entry restored on a cancellation extends the ended pass by the venue's grace, written in its history, and is usable again", async () => {
    const ph = phone();
    const pass = await sell(ph, { entries: 2, price: 40 });
    const b = await book(ph, 3, [9]);
    expect((await payBookingWithPass(b.id, pass.code)).ok).toBe(true);
    await age(pass.id, addDays(today, -1));
    expect((await getPass(pass.code))!.unusableReason).toBeDefined();
    expect((await cancelBooking(b.code, ph)).ok).toBe(true);
    const after = (await getPass(pass.code))!;
    expect(after.remaining).toBe(2);
    expect(after.expiresOn).toBe(addDays(today, 30));
    expect(after.unusableReason).toBeUndefined();
    const history = await listPassEntries(pass.id);
    expect(history.find((e) => e.delta === 0)?.reason).toBe(`Valid until ${addDays(today, -1)} → ${addDays(today, 30)}: 1 entry given back for ${b.code} after the pass had ended, 30 days to use them`);
    // No money moves: the entry is the customer's to use.
    expect((await creditNotes(pass.id)).n).toBe(0);
    const next = await book(ph, 5, [9]);
    expect((await payBookingWithPass(next.id, pass.code)).ok).toBe(true);
  });

  it("the venue's own cancellation extends it the same way", async () => {
    const ph = phone();
    const pass = await sell(ph, { entries: 1, price: 20 });
    const b = await book(ph, 4, [10]);
    expect((await payBookingWithPass(b.id, pass.code)).ok).toBe(true);
    await age(pass.id, addDays(today, -3));
    expect((await adminCancelBooking(b.code)).ok).toBe(true);
    expect((await getPass(pass.code))!).toMatchObject({ remaining: 1, expiresOn: addDays(today, 30) });
  });

  it("a pass still valid is not touched; a grace of 0 leaves the ended pass ended, as before", async () => {
    const ph = phone();
    const live = await sell(ph, { entries: 1, price: 20, expiresOn: addDays(today, 40) });
    const b1 = await book(ph, 6, [9]);
    expect((await payBookingWithPass(b1.id, live.code)).ok).toBe(true);
    expect((await cancelBooking(b1.code, ph)).ok).toBe(true);
    expect((await getPass(live.code))!.expiresOn).toBe(addDays(today, 40));
    expect((await listPassEntries(live.id)).some((e) => e.delta === 0)).toBe(false);

    expect(await setPassRestoreGraceDays(venueId, 0)).toMatchObject({ ok: true, days: 0, was: 30 });
    const off = await sell(ph, { entries: 1, price: 20 });
    const b2 = await book(ph, 7, [9]);
    expect((await payBookingWithPass(b2.id, off.code)).ok).toBe(true);
    await age(off.id, addDays(today, -1));
    expect((await cancelBooking(b2.code, ph)).ok).toBe(true);
    expect((await getPass(off.code))!).toMatchObject({ remaining: 1, expiresOn: addDays(today, -1) });
    expect((await getPass(off.code))!.unusableReason).toBeDefined();
    expect(await setPassRestoreGraceDays(venueId, 30)).toMatchObject({ ok: true, days: 30, was: 0 });
  });

  it("two cancellations at once give the entry back once and extend once", async () => {
    const ph = phone();
    const pass = await sell(ph, { entries: 2, price: 40 });
    const b = await book(ph, 8, [9]);
    expect((await payBookingWithPass(b.id, pass.code)).ok).toBe(true);
    await age(pass.id, addDays(today, -2));
    await Promise.all([cancelBooking(b.code, ph), cancelBooking(b.code, ph)]);
    const after = (await getPass(pass.code))!;
    expect(after.remaining).toBe(2);
    expect((await listPassEntries(pass.id)).filter((e) => e.delta === 0)).toHaveLength(1);
  });

  it("a late cancellation that gives nothing back does not extend the ended pass", async () => {
    const ph = phone();
    const pass = await sell(ph, { entries: 2, price: 40 });
    const b = await book(ph, 9, [9]);
    expect((await payBookingWithPass(b.id, pass.code)).ok).toBe(true);
    await age(pass.id, addDays(today, -1));
    // The venue keeps the whole entry on a late cancellation (a share of 0 rounds to no entry): nothing is given back, so nothing is extended.
    const { refundBookingToPass } = await import("../src/lib/store");
    expect((await refundBookingToPass(b.id, 0)).ok).toBe(true);
    expect((await getPass(pass.code))!).toMatchObject({ remaining: 1, expiresOn: addDays(today, -1) });
  });
});

describe("H5 and D1: a pass cancelled with the unused part handed back is not revived", () => {
  it("cancelling the booking it still pays hands the entry's value back in money, up to the price and no more", async () => {
    const ph = phone();
    const pass = await sell(ph, { entries: 10, price: 100 });
    const b = await book(ph, 4, [10, 11]);
    expect((await payBookingWithPass(b.id, pass.code)).ok).toBe(true); // 8 left
    expect(await voidPass(pass.id, { refund: true })).toMatchObject({ ok: true, refunded: 80 });
    expect((await creditNotes(pass.id)).t).toBe(80);
    expect((await cancelBooking(b.code, ph)).ok).toBe(true);
    // All 100 handed back in all; the cancelled pass is not given entries it cannot use, nor revived.
    expect((await creditNotes(pass.id)).t).toBe(100);
    const after = (await getPass(pass.code))!;
    expect(after.status).toBe("void");
    // As it stood when it was cancelled (8 unused, refunded then): the 2 entries were not added back to it.
    expect(after.remaining).toBe(8);
    expect(after.expiresOn).toBe(addDays(today, 60));
    const reasons = (await listPassEntries(pass.id)).map((e) => e.reason);
    expect(reasons.some((r) => r.startsWith("Pass cancelled: 2 entries from") && r.includes("handed back as"))).toBe(true);
    expect((await listActivity([venueId])).some((e) => e.action === "pass.restored_after_void" && e.detail?.includes(b.code))).toBe(true);
    // Said again, nothing more is handed back.
    expect((await cancelBooking(b.code, ph)).ok).toBe(false);
    expect((await creditNotes(pass.id)).t).toBe(100);
  });

  it("H5: a pass whose only entry is on a future booking, cancelled with a refund of nothing, hands the entry back on cancelling the booking (the venue's cancellation too)", async () => {
    const ph = phone();
    const pass = await sell(ph, { entries: 1, price: 50 });
    const b = await book(ph, 5, [10]);
    expect((await payBookingWithPass(b.id, pass.code)).ok).toBe(true);
    const voided = await voidPass(pass.id, { refund: true });
    expect(voided).toMatchObject({ ok: true });
    expect((voided as { refunded?: number }).refunded ?? 0).toBe(0);
    expect((await adminCancelBooking(b.code)).ok).toBe(true);
    expect((await creditNotes(pass.id)).t).toBe(50);
    expect((await getPass(pass.code))!).toMatchObject({ status: "void", remaining: 0 });
  });

  it("cancelled without a refund, the sale stays sold: the entry goes back to the ledger and the history says it is not handed back", async () => {
    const ph = phone();
    const pass = await sell(ph, { entries: 3, price: 30 });
    const b = await book(ph, 6, [10]);
    expect((await payBookingWithPass(b.id, pass.code)).ok).toBe(true);
    expect(await voidPass(pass.id)).toMatchObject({ ok: true });
    expect((await cancelBooking(b.code, ph)).ok).toBe(true);
    expect((await creditNotes(pass.id)).n).toBe(0);
    expect((await getPass(pass.code))!).toMatchObject({ status: "void", remaining: 3 });
    expect((await listPassEntries(pass.id)).some((e) => e.reason.includes("cancelled without a refund"))).toBe(true);
  });
});

describe("D4: a pass is judged on the day of the session it pays", () => {
  it("a pass that ends before the session cannot pay it; one inside its validity still can", async () => {
    const ph = phone();
    const pass = await sell(ph, { entries: 5, price: 50, expiresOn: addDays(today, 2) });
    const late = await book(ph, 10, [9]);
    const refused = await payBookingWithPass(late.id, pass.code);
    expect(refused).toMatchObject({ ok: false });
    expect((refused as { error: string }).error).toContain(`ends on ${addDays(today, 2)}`);
    expect((await getPass(pass.code))!.remaining).toBe(5);
    const inside = await book(ph, 2, [9]);
    expect((await payBookingWithPass(inside.id, pass.code)).ok).toBe(true);
    // The last day itself counts (the end is inclusive).
    const lastDay = await book(ph, 2, [10]);
    expect((await payBookingWithPass(lastDay.id, pass.code)).ok).toBe(true);
  });

  it("a series that straddles the end: the weeks inside are paid, the weeks after are left unpaid with the reason", async () => {
    const ph = phone();
    const pass = await sell(ph, { entries: 5, price: 50, expiresOn: addDays(today, 6) });
    const weeks = [await book(ph, 2, [11]), await book(ph, 7, [11]), await book(ph, 12, [11])];
    const results = [];
    for (const w of weeks) results.push(await payBookingWithPasses(w.id, [pass.code]));
    expect(results.map((r) => r.ok)).toEqual([true, false, false]);
    expect((await getPass(pass.code))!.remaining).toBe(4);
  });

  it("the counter lists a pass for a session only if it is good on that day", async () => {
    const ph = phone();
    const pass = await sell(ph, { entries: 5, price: 50, expiresOn: addDays(today, 5) });
    expect((await usablePassesForHolder(venueId, ph, addDays(today, 5))).map((p) => p.id)).toContain(pass.id);
    expect((await usablePassesForHolder(venueId, ph, addDays(today, 6))).map((p) => p.id)).not.toContain(pass.id);
    expect((await usablePassesForHolder(venueId, ph)).map((p) => p.id)).toContain(pass.id);
  });

  it("a booking paid with a pass is not moved past the pass's end", async () => {
    const ph = phone();
    const pass = await sell(ph, { entries: 5, price: 50, expiresOn: addDays(today, 6) });
    const b = await book(ph, 3, [12]);
    expect((await payBookingWithPass(b.id, pass.code)).ok).toBe(true);
    const past = await rescheduleBooking(b.code, { date: addDays(today, 9), startHour: 12 }, "customer");
    expect(past).toMatchObject({ ok: false, code: "FX8_MOVE_PAST_PASS" });
    const within = await rescheduleBooking(b.code, { date: addDays(today, 5), startHour: 12 }, "customer");
    expect(within.ok).toBe(true);
  });
});

describe("D4 race: two bookings take the last entry", () => {
  it("one wins, one stays unpaid, however many ask at once", async () => {
    const ph = phone();
    const pass = await sell(ph, { entries: 1, price: 10 });
    const bs = [await book(ph, 12, [12]), await book(ph, 12, [13]), await book(ph, 12, [14])];
    const res = await Promise.all(bs.map((b) => payBookingWithPass(b.id, pass.code)));
    expect(res.filter((r) => r.ok)).toHaveLength(1);
    expect((await getPass(pass.code))!.remaining).toBe(0);
  });

  it("a cancellation and a payment at once: never an entry from nothing", async () => {
    const ph = phone();
    const pass = await sell(ph, { entries: 1, price: 10 });
    const [a, b] = [await book(ph, 13, [12]), await book(ph, 13, [13])];
    expect((await payBookingWithPass(a.id, pass.code)).ok).toBe(true);
    const [cancelled, paid] = await Promise.all([cancelBooking(a.code, ph), payBookingWithPass(b.id, pass.code)]);
    expect(cancelled.ok).toBe(true);
    const left = (await getPass(pass.code))!.remaining;
    // Either b paid before the entry came back (then 0 left after the restore is 1 - 1 + 1 - 1...), or after: the ledger always adds up to the entries sold.
    const spent = (await listPassEntries(pass.id)).reduce((s, e) => s + e.delta, 0);
    expect(left).toBe(1 + spent);
    expect(left).toBe(paid.ok ? 0 : 1);
  });
});

describe("a manager extends a pass, with a reason", () => {
  it("moves the end later, in the pass's history and the activity log; the desk and another venue's manager cannot", async () => {
    const ph = phone();
    const pass = await sell(ph, { entries: 3, price: 30, expiresOn: addDays(today, 5) });
    const target = addDays(today, 40);
    expect((await extendVia(null, pass.id, { expiresOn: target, reason: "Closed for repairs" })).status).toBe(401);
    expect((await extendVia(desk, pass.id, { expiresOn: target, reason: "Closed for repairs" })).status).toBe(403);
    expect((await extendVia(outsider, pass.id, { expiresOn: target, reason: "Closed for repairs" })).status).toBe(403);
    expect((await getPass(pass.code))!.expiresOn).toBe(addDays(today, 5));
    const res = await extendVia(manager, pass.id, { expiresOn: target, reason: "Closed for repairs" });
    expect(res.status).toBe(200);
    expect((await getPass(pass.code))!.expiresOn).toBe(target);
    expect((await listPassEntries(pass.id)).find((e) => e.delta === 0)?.reason).toBe(`Valid until ${addDays(today, 5)} → ${target}, extended by ${manager.name}: Closed for repairs`);
    expect((await listActivity([venueId])).some((e) => e.action === "pass.extended" && e.detail?.includes("Closed for repairs"))).toBe(true);
  });

  it("an ended pass is brought back by days from today; a reason is required; an earlier end, a cancelled pass and an unknown one are refused", async () => {
    const ph = phone();
    const pass = await sell(ph, { entries: 3, price: 30 });
    await age(pass.id, addDays(today, -10));
    expect((await extendVia(manager, pass.id, { days: 14 })).status).toBe(409);
    const bad = await extendVia(manager, pass.id, { days: 14, reason: "x" });
    expect(await bad.json()).toMatchObject({ code: "FX8_PASS_REASON" });
    expect(await (await extendVia(manager, pass.id, { expiresOn: addDays(today, -12), reason: "Too early" })).json()).toMatchObject({ code: "FX8_PASS_NOT_LATER" });
    expect(await (await extendVia(manager, pass.id, { expiresOn: "2999-01-01", reason: "Too far" })).json()).toMatchObject({ code: "FX8_PASS_TOO_FAR" });
    expect(await (await extendVia(manager, pass.id, { reason: "No day given" })).json()).toMatchObject({ code: "FX8_PASS_DATE" });
    expect((await extendVia(manager, pass.id, { days: 14, reason: "Customer was ill" })).status).toBe(200);
    expect((await getPass(pass.code))!.expiresOn).toBe(addDays(today, 14));
    expect((await getPass(pass.code))!.unusableReason).toBeUndefined();
    expect(await voidPass(pass.id)).toMatchObject({ ok: true });
    expect(await (await extendVia(manager, pass.id, { days: 14, reason: "Too late" })).json()).toMatchObject({ code: "FX8_PASS_VOID" });
    expect((await extendVia(manager, 999999, { days: 14, reason: "Nobody" })).status).toBe(404);
  });
});

describe("the venue's setting", () => {
  it("is 30 by default, a manager's to change within 0 to 365, and logged", async () => {
    expect(await passRestoreGraceDays(venueId)).toBe(30);
    const get = await settingsRoute.GET(req(`http://localhost/api/admin/pass-settings?venueId=${venueId}`, "GET", desk.cookie));
    expect(await get.json()).toEqual({ settings: { restoreGraceDays: 30, recommended: 30 } });
    const post = (who: { cookie: string }, body: unknown) => settingsRoute.POST(req("http://localhost/api/admin/pass-settings", "POST", who.cookie, body));
    expect((await post(desk, { venueId, restoreGraceDays: 10 })).status).toBe(403);
    expect((await post(outsider, { venueId, restoreGraceDays: 10 })).status).toBe(403);
    expect((await post(manager, { venueId, restoreGraceDays: 366 })).status).toBe(400);
    expect((await post(manager, { venueId, restoreGraceDays: -1 })).status).toBe(400);
    expect((await post(manager, { venueId, restoreGraceDays: 2.5 })).status).toBe(400);
    expect((await post(manager, { venueId, restoreGraceDays: 45 })).status).toBe(200);
    expect(await passRestoreGraceDays(venueId)).toBe(45);
    expect((await listActivity([venueId])).some((e) => e.action === "settings.changed" && e.detail?.includes("30 → 45"))).toBe(true);
    expect((await post(manager, { venueId, restoreGraceDays: 30 })).status).toBe(200);
  });
});
