import fs from "node:fs";
import path from "node:path";
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
import { createBooking, createCourt, createVenue, hireFor, returnHire, stateDepositMethod, takeHire } from "../src/lib/store";
import { todayISO } from "../src/lib/time";
import * as hireRoute from "../src/app/api/admin/hire/route";

/**
 * Hardening, brief MONEY, C10 (ADR 0068): a hire deposit taken before its method was recorded (migration 0308) shows "not recorded" and stays that
 * way; staff can say, once, how it was held. The statement is written beside the marker (who, when), never over it, and from then on the deposit is
 * counted under that method and what is kept back goes in the takings under it. Run on Postgres too (two statements at once).
 */

const ZONE = "Asia/Kuala_Lumpur";
let venueId: number;
let otherVenue: number;
let deskId: number;
let asDesk: string;
let asManager: string;
let asOutsider: string;
let seq = 0;
let hourN = 8;

async function fleet() {
  const created = await createCourt({ venueId, name: `Canoe ${++seq}`, sport: "kayak", offPeakRate: 15, peakRate: 20, capacity: 6, deposit: 50 });
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
  const b = await createBooking({ courtId, date, hours: [hour], name: "Paddler", phone: `01556000${String(10 + seq++).padStart(2, "0")}` });
  if (!b.ok) throw new Error(JSON.stringify(b));
  vi.setSystemTime(new Date(`${date}T${String(hour).padStart(2, "0")}:15:00+08:00`));
  return b.booking;
}
/** A deposit as an earlier release wrote it: an amount, and no method. */
async function legacy(amount = 40) {
  const court = await fleet();
  const b = await running(court.id);
  await getDb().prepare("INSERT INTO hire_records (booking_id, deposit) VALUES (?, ?)").run(b.id, amount);
  return b;
}
const asDeskStaff = <T>(work: () => Promise<T>) => asStaff({ id: deskId, name: "Dee Desk" }, work);
const post = (cookie: string, body: unknown) =>
  hireRoute.POST(new NextRequest("http://localhost/api/admin/hire", { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }));
const row = async (bookingId: number) =>
  (await getDb()
    .prepare("SELECT deposit_via, deposit_via_stated, deposit_via_stated_by_name, deposit_via_stated_at, returned_via FROM hire_records WHERE booking_id = ?")
    .get(bookingId)) as { deposit_via: string | null; deposit_via_stated: string | null; deposit_via_stated_by_name: string | null; deposit_via_stated_at: unknown; returned_via: string | null };

beforeAll(async () => {
  const v = await createVenue({ name: "Canoe Till", area: "PJ", address: "x", phone: "0377772222" });
  const o = await createVenue({ name: "Other Till", area: "PJ", address: "y", phone: "0377773333" });
  if (!v.ok || !o.ok) throw new Error("venue");
  venueId = v.venue.id;
  otherVenue = o.venue.id;
  const desk = await createAdmin({ name: "Dee Desk", email: "dee@canoe.my", password: "desk-password-1", venueId, role: "desk" });
  const mgr = await createAdmin({ name: "Mo Manager", email: "mo@canoe.my", password: "manager-password-1", venueId });
  const out = await createAdmin({ name: "Ola Outsider", email: "ola@other.my", password: "manager-password-2", venueId: otherVenue });
  if (!desk.ok || !mgr.ok || !out.ok) throw new Error("admins");
  deskId = desk.admin.id;
  asDesk = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.admin.id)).token}`;
  asManager = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(mgr.admin.id)).token}`;
  asOutsider = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(out.admin.id)).token}`;
});
afterEach(() => vi.useRealTimers());

describe("C10: saying how a deposit taken before the method was recorded was held", () => {
  it("is written beside the marker with who and when, never over it, and the deposit is counted under it from then on", async () => {
    const b = await legacy(40);
    const before = await hireDepositsHeld(venueId);
    expect(before.byMethod.some((m) => m.method === null && m.amount >= 40)).toBe(true);
    const done = await asDeskStaff(() => stateDepositMethod(b.code, "qr"));
    expect(done).toMatchObject({ ok: true, changed: true, hire: { deposit: 40, depositVia: null, depositViaStated: { via: "qr", by: "Dee Desk" } } });
    // The legacy marker stays: the recorded method is still empty.
    expect(await row(b.id)).toMatchObject({ deposit_via: null, deposit_via_stated: "qr", deposit_via_stated_by_name: "Dee Desk" });
    expect((await row(b.id)).deposit_via_stated_at).not.toBeNull();
    expect((await hireFor(b.id))!.depositVia).toBeNull();
    // Held under QR now, no longer under "not recorded".
    const after = await hireDepositsHeld(venueId);
    expect(after.total).toBe(before.total);
    expect(after.byMethod.find((m) => m.method === "qr")!.amount).toBe((before.byMethod.find((m) => m.method === "qr")?.amount ?? 0) + 40);
    expect(after.byMethod.find((m) => m.method === null)?.amount ?? 0).toBe((before.byMethod.find((m) => m.method === null)?.amount ?? 0) - 40);
    const sheet = await cashUp(venueId, todayISO(ZONE), null);
    expect(sheet.deposits.held.find((h) => h.method === "qr")!.amount).toBeGreaterThanOrEqual(40);
  });

  it("lets an amount be kept from it: the takings go in under the stated method, with no method to say again, and a different one is refused", async () => {
    const b = await legacy(40);
    const damage = { condition: "damaged" as const, deductions: [{ reason: "damage", amount: 15 }], note: "Cracked paddle" };
    // Before it is stated, an amount cannot be kept (never cash by default).
    expect(await returnHire(b.code, damage)).toMatchObject({ ok: false, error: expect.stringContaining("how the deposit was held") });
    expect((await stateDepositMethod(b.code, "transfer")).ok).toBe(true);
    expect(await returnHire(b.code, { ...damage, via: "cash" })).toMatchObject({ ok: false, error: expect.stringContaining("held by transfer") });
    expect((await asDeskStaff(() => returnHire(b.code, damage))).ok).toBe(true);
    const sale = (await getDb().prepare("SELECT s.paid_via FROM counter_sales s JOIN hire_records h ON h.id = s.hire_record_id WHERE h.booking_id = ?").get(b.id)) as { paid_via: string };
    expect(sale.paid_via).toBe("transfer");
    // Given back, it is under the stated method in the day's deposits, and the marker is still there.
    const entries = (await cashUp(venueId, todayISO(ZONE), null)).deposits.entries.filter((e) => e.bookingCode === b.code);
    expect(entries.map((e) => [e.event, e.method])).toEqual([["taken", "transfer"], ["returned", "transfer"]]);
    expect((await row(b.id)).deposit_via).toBeNull();
  });

  it("can be said once: the same again changes nothing, another method, a recorded one, or one said on return is refused", async () => {
    const b = await legacy(25);
    expect(await stateDepositMethod(b.code, "cash")).toMatchObject({ ok: true, changed: true });
    const first = await row(b.id);
    expect(await stateDepositMethod(b.code, "cash")).toMatchObject({ ok: true, changed: false });
    expect(await row(b.id)).toEqual(first);
    expect(await stateDepositMethod(b.code, "card")).toMatchObject({ ok: false, error: expect.stringContaining("already stated") });
    expect((await row(b.id)).deposit_via_stated).toBe("cash");

    const court = await fleet();
    const recorded = await running(court.id);
    expect((await takeHire(recorded.code, 50, "card")).ok).toBe(true);
    expect(await stateDepositMethod(recorded.code, "cash")).toMatchObject({ ok: false, error: expect.stringContaining("recorded when it was taken") });

    const said = await legacy(30);
    expect((await returnHire(said.code, { condition: "damaged", deductions: [{ reason: "damage", amount: 5 }], note: "Chipped", via: "qr" })).ok).toBe(true);
    expect(await stateDepositMethod(said.code, "cash")).toMatchObject({ ok: false });

    expect(await stateDepositMethod(b.code, "bitcoin")).toMatchObject({ ok: false });
    expect(await stateDepositMethod("NOSUCH1", "cash")).toMatchObject({ ok: false });
    const waived = await running((await fleet()).id);
    expect((await takeHire(waived.code, 0)).ok).toBe(true);
    expect(await stateDepositMethod(waived.code, "cash")).toMatchObject({ ok: false, error: expect.stringContaining("No deposit") });
  });

  it("two statements at once leave one: the first wins, the other is refused or changes nothing", async () => {
    const b = await legacy(35);
    const both = await Promise.all([stateDepositMethod(b.code, "cash"), stateDepositMethod(b.code, "qr"), stateDepositMethod(b.code, "cash")]);
    const state = (await row(b.id)).deposit_via_stated;
    expect(["cash", "qr"]).toContain(state);
    expect(both.filter((r) => r.ok && r.changed === true)).toHaveLength(1);
    // Whoever lost was refused (another method) or saw the same words said already (no change).
    for (const r of both) if (!r.ok) expect(r.error).toContain("already stated");
  });

  it("over the route: the desk and a manager of the venue may say it, nobody else; it is logged once, and a repeat logs nothing", async () => {
    const b = await legacy(45);
    const say = (cookie: string, via: unknown) => post(cookie, { code: b.code, action: "state_method", via });
    expect((await say(asOutsider, "cash")).status).toBe(403);
    expect((await say(asDesk, "bitcoin")).status).toBe(400);
    expect((await row(b.id)).deposit_via_stated).toBeNull();
    const ok = await say(asDesk, "card");
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ changed: true, hire: { depositVia: null, depositViaStated: { via: "card", by: "Dee Desk" } } });
    const again = await say(asManager, "card");
    expect(again.status).toBe(200);
    expect((await again.json()).changed).toBe(false);
    expect((await say(asManager, "cash")).status).toBe(409);
    const logged = (await listActivity([venueId])).filter((e) => e.action === "hire.method_stated" && e.bookingCode === b.code);
    expect(logged).toHaveLength(1);
    expect(logged[0].detail).toContain("card");
  });
});

describe("migration 0327", () => {
  it("can be run again without changing a deposit, and refuses a method that is not a counter one", async () => {
    const b = await legacy(20);
    await stateDepositMethod(b.code, "qr");
    const sql = fs.readFileSync(path.join(__dirname, "../db/migrations/0327_hire_deposit_method_stated.sql"), "utf8");
    await getDb().exec(sql);
    expect((await row(b.id)).deposit_via_stated).toBe("qr");
    await expect(getDb().prepare("UPDATE hire_records SET deposit_via_stated = 'bitcoin' WHERE booking_id = ?").run(b.id)).rejects.toThrow();
  });
});
