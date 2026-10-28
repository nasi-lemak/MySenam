import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { POST as cancelRoute } from "../src/app/api/admin/bookings/cancel/route";
import { POST as cancelSeriesRoute } from "../src/app/api/admin/bookings/cancel-series/route";
import { GET as dayRoute } from "../src/app/api/admin/bookings/route";
import { listActivity } from "../src/lib/activity";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { registerUser } from "../src/lib/auth";
import { setCancelPolicy } from "../src/lib/cancel-policy";
import { COUNTER_REFUSALS, counterPayoutsOn, previewStaffCancel, previewStaffSeries, staffCancel, staffCancelSeries } from "../src/lib/counter-refunds";
import { getDb } from "../src/lib/db";
import {
  createBooking,
  createBookingSeries,
  createCourt,
  createVenue,
  getWalletBalance,
  setPaymentStatus,
  updateVenue,
} from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * Staff cancelling a booking that was paid (X1-1, X1-10): shown what was paid
 * and how and the venue's terms first, then settling it as chosen: back the
 * way it was paid (a counter payout, by whom, on its credit note), as stored
 * credit, or keeping the venue's late share. A counter payment taken on an
 * earlier day goes back only by a manager. Two cancels at once settle once.
 */

let venueId: number;
let courtId: number;
let manager: { id: number; name: string; role: "manager" };
let desk: { id: number; name: string; role: "desk" };
let deskCookie: string;
let managerCookie: string;
let n = 0;
const phone = () => `0166600${String(++n).padStart(3, "0")}`;
const today = () => todayISO();

async function customer() {
  const made = await registerUser({ name: `Rita ${++n}`, email: `rita${n}@example.com`, phone: phone(), password: "password1" });
  if (!made.ok) throw new Error("user");
  return made.user;
}

/** A booking `days` ahead at `hour`, paid at the counter by `via` (or unpaid). */
async function book(days: number, hour: number, opts: { via?: "cash" | "qr" | "card" | "transfer" | null; userId?: number } = {}) {
  const made = await createBooking({ courtId, date: addDays(today(), days), hours: [hour], name: "Rita", phone: phone(), ...(opts.userId ? { userId: opts.userId } : {}) });
  if (!made.ok) throw new Error(made.error);
  if (opts.via !== undefined) {
    const paid = await setPaymentStatus(made.booking.code, true, opts.via);
    if (!paid.ok) throw new Error(paid.error);
  }
  return made.booking;
}

const payoutsOf = async (bookingId: number) =>
  (await getDb().prepare("SELECT amount::float AS amount, via, kept_percent, admin_name, credit_note_id FROM counter_payouts WHERE booking_id = ?").all(bookingId)) as {
    amount: number;
    via: string | null;
    kept_percent: number | null;
    admin_name: string;
    credit_note_id: number | null;
  }[];
const creditNote = async (bookingId: number) =>
  (await getDb().prepare("SELECT id, total::float AS total, paid_via FROM receipts WHERE source = ? AND kind = 'credit_note'").get(`booking:${bookingId}`)) as
    | { id: number; total: number; paid_via: string }
    | undefined;
const statusOf = async (code: string) =>
  (await getDb().prepare("SELECT status, late_cancelled, late_kept_percent FROM bookings WHERE code = ?").get(code)) as {
    status: string;
    late_cancelled: number;
    late_kept_percent: number | null;
  };
const paidEarlier = (bookingId: number) =>
  getDb().prepare("UPDATE bookings SET paid_at = ? WHERE id = ?").run(`${addDays(today(), -2)}T03:00:00.000Z`, bookingId);

const post = (handler: (req: NextRequest) => Promise<Response>, path: string, cookie: string, body: object) =>
  handler(new NextRequest(`http://localhost${path}`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) }));

beforeAll(async () => {
  await ensureBootstrapAdmin();
  const made = await createVenue({ name: "Till Hall", area: "Ipoh", address: "x", phone: "0355554444", openHour: 7, closeHour: 23 });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  // Free to cancel up to 72 hours before (the most a venue sets), so tomorrow is always late; past that the venue keeps half.
  await updateVenue(venueId, { cancelCutoffHours: 72 });
  await setCancelPolicy(venueId, { lateKeep: 50 });
  const court = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 20, peakRate: 20, capacity: 1 });
  if (!court.ok) throw new Error(court.error);
  courtId = court.court.id;
  const m = await createAdmin({ name: "Musa Manager", email: "musa@till.my", password: "manager-pass-1", venueId });
  const d = await createAdmin({ name: "Dina Desk", email: "dina@till.my", password: "desk-password-1", venueId, role: "desk" });
  if (!m.ok || !d.ok) throw new Error("staff");
  manager = { id: m.admin.id, name: m.admin.name, role: "manager" };
  desk = { id: d.admin.id, name: d.admin.name, role: "desk" };
  managerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(m.admin.id)).token}`;
  deskCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(d.admin.id)).token}`;
});

describe("what staff are shown before cancelling", () => {
  it("says what was paid, how and when, the venue's terms, and each way to settle it", async () => {
    const user = await customer();
    const b = await book(5, 9, { via: "cash", userId: user.id });
    const seen = await previewStaffCancel(b.code, "desk");
    if (!seen.ok) throw new Error(seen.error);
    expect(seen.preview).toMatchObject({ paid: 20, paidVia: "cash", how: "counter", late: false, cutoffHours: 72, keptPercent: null, managerOnly: false, account: true });
    expect(seen.preview.options.map((o) => o.outcome)).toEqual(["back", "credit"]);
  });

  it("offers the venue's late share only past its cutoff, and credit only to a booking made from an account", async () => {
    const b = await book(1, 22, { via: "qr" });
    const seen = await previewStaffCancel(b.code, "manager");
    if (!seen.ok) throw new Error(seen.error);
    expect(seen.preview).toMatchObject({ late: true, keptPercent: 50, account: false });
    expect(seen.preview.options).toEqual([
      { outcome: "back", refund: 20, kept: 0 },
      { outcome: "keep", refund: 10, kept: 10 },
    ]);
    expect((await staffCancel(b.code, manager, { outcome: "credit" })).result).toMatchObject({ ok: false, error: COUNTER_REFUSALS.noAccount });
    expect((await statusOf(b.code)).status).toBe("confirmed");
  });

  it("has nothing to settle on a booking nobody paid", async () => {
    const b = await book(6, 9);
    const seen = await previewStaffCancel(b.code, "desk");
    if (!seen.ok) throw new Error(seen.error);
    expect(seen.preview).toMatchObject({ paid: 0, how: "none", options: [{ outcome: "back", refund: 0, kept: 0 }] });
    const done = await staffCancel(b.code, desk);
    expect(done.result.ok).toBe(true);
    expect(await payoutsOf(b.id)).toEqual([]);
  });
});

describe("settling a counter payment", () => {
  it("back the way it was paid: a payout for the till, by whom, on the credit note", async () => {
    const b = await book(7, 9, { via: "cash" });
    const done = await staffCancel(b.code, manager, { outcome: "back", expectRefund: 20 });
    expect(done.result.ok).toBe(true);
    expect(done.settled).toMatchObject({ outcome: "back", refund: 20, kept: 0, paidOut: { amount: 20, via: "cash" } });
    const note = await creditNote(b.id);
    expect(note).toMatchObject({ total: 20, paid_via: "Cash" });
    expect(await payoutsOf(b.id)).toEqual([{ amount: 20, via: "cash", kept_percent: null, admin_name: "Musa Manager", credit_note_id: note!.id }]);
    const till = await counterPayoutsOn([venueId], today());
    expect(till.find((p) => p.bookingCode === b.code)).toMatchObject({ amount: 20, via: "cash", adminName: "Musa Manager" });
    // Nothing on another venue's list, nor on another day's.
    expect((await counterPayoutsOn([venueId + 999], today())).length).toBe(0);
    expect((await counterPayoutsOn([venueId], addDays(today(), -1))).some((p) => p.bookingCode === b.code)).toBe(false);
  });

  it("as stored credit: to the booking's account, with the member of staff; the credit note says so and nothing leaves the till", async () => {
    const user = await customer();
    const b = await book(8, 9, { via: "card", userId: user.id });
    const done = await staffCancel(b.code, desk, { outcome: "credit" });
    expect(done.result.ok).toBe(true);
    expect(done.settled).toMatchObject({ outcome: "credit", credited: 20 });
    expect(await getWalletBalance(user.id)).toBe(20);
    const entry = (await getDb().prepare("SELECT amount::float AS amount, admin_id FROM wallet_entries WHERE booking_id = ?").get(b.id)) as { amount: number; admin_id: number };
    expect(entry).toEqual({ amount: 20, admin_id: desk.id });
    expect(await creditNote(b.id)).toMatchObject({ total: 20, paid_via: "Stored credit" });
    expect(await payoutsOf(b.id)).toEqual([]);
  });

  it("keeping the venue's late share: a late cancel at its terms, the rest handed back", async () => {
    const b = await book(1, 21, { via: "transfer" });
    const done = await staffCancel(b.code, manager, { outcome: "keep" });
    expect(done.result.ok).toBe(true);
    expect(done.settled).toMatchObject({ outcome: "keep", refund: 10, kept: 10, paidOut: { amount: 10, via: "transfer" } });
    expect(await statusOf(b.code)).toEqual({ status: "cancelled", late_cancelled: 1, late_kept_percent: 50 });
    expect(await creditNote(b.id)).toMatchObject({ total: 10 });
    expect(await payoutsOf(b.id)).toMatchObject([{ amount: 10, kept_percent: 50 }]);
  });

  it("keeps nothing inside the free window: the late share is not offered there", async () => {
    const b = await book(9, 9, { via: "cash" });
    expect((await staffCancel(b.code, manager, { outcome: "keep" })).result).toMatchObject({ ok: false, error: COUNTER_REFUSALS.notOffered });
    expect((await statusOf(b.code)).status).toBe("confirmed");
  });

  it("refuses when what would go back is not what staff were shown", async () => {
    const b = await book(10, 9, { via: "cash" });
    expect((await staffCancel(b.code, manager, { outcome: "back", expectRefund: 25 })).result).toMatchObject({ ok: false, error: COUNTER_REFUSALS.changed });
    expect((await statusOf(b.code)).status).toBe("confirmed");
  });
});

describe("who may give a counter payment back", () => {
  it("the desk, for its own counter takings of the day", async () => {
    const b = await book(11, 9, { via: "cash" });
    expect((await staffCancel(b.code, desk, { outcome: "back" })).result.ok).toBe(true);
    expect(await payoutsOf(b.id)).toMatchObject([{ admin_name: "Dina Desk" }]);
  });

  it("a manager only, for one taken on an earlier day, as Mark unpaid is", async () => {
    const b = await book(12, 9, { via: "cash" });
    await paidEarlier(b.id);
    const seen = await previewStaffCancel(b.code, "desk");
    expect(seen.ok && seen.preview.managerOnly).toBe(true);
    for (const outcome of ["back", "credit", "keep"] as const)
      expect((await staffCancel(b.code, desk, { outcome })).result.ok).toBe(false);
    expect((await staffCancel(b.code, desk, { outcome: "back" })).result).toMatchObject({ error: COUNTER_REFUSALS.manager });
    expect((await statusOf(b.code)).status).toBe("confirmed");
    expect((await staffCancel(b.code, manager, { outcome: "back" })).result.ok).toBe(true);
  });

  it("the desk still cancels one paid online on any day: that money is owed back on the payment, as before", async () => {
    const b = await book(13, 9);
    await getDb().prepare("UPDATE bookings SET payment_status = 'paid', paid_via = 'online', paid_at = ? WHERE id = ?").run(`${addDays(today(), -3)}T03:00:00.000Z`, b.id);
    const seen = await previewStaffCancel(b.code, "desk");
    if (!seen.ok) throw new Error(seen.error);
    expect(seen.preview).toMatchObject({ how: "online", managerOnly: false });
    expect(seen.preview.options.map((o) => o.outcome)).toEqual(["back"]);
    expect((await staffCancel(b.code, desk, { outcome: "credit" })).result).toMatchObject({ ok: false, error: COUNTER_REFUSALS.notOffered });
    expect((await staffCancel(b.code, desk, { outcome: "back" })).result.ok).toBe(true);
    expect(await payoutsOf(b.id)).toEqual([]);
  });
});

describe("two cancels at the same moment", () => {
  it("settle once: one payout, one credit note", async () => {
    const b = await book(4, 9, { via: "cash" });
    const [a, c] = await Promise.all([staffCancel(b.code, manager, { outcome: "back" }), staffCancel(b.code, desk, { outcome: "back" })]);
    expect([a.result.ok, c.result.ok].filter(Boolean)).toHaveLength(1);
    expect(await payoutsOf(b.id)).toHaveLength(1);
    const notes = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM receipts WHERE source = ?").get(`booking:${b.id}`)) as { n: number };
    expect(notes.n).toBe(1);
  });

  it("settle once when one gives it back in cash and the other as credit", async () => {
    const user = await customer();
    const b = await book(4, 10, { via: "cash", userId: user.id });
    const [a, c] = await Promise.all([staffCancel(b.code, manager, { outcome: "back" }), staffCancel(b.code, manager, { outcome: "credit" })]);
    expect([a.result.ok, c.result.ok].filter(Boolean)).toHaveLength(1);
    const credited = await getWalletBalance(user.id);
    const paidOut = (await payoutsOf(b.id)).reduce((s, p) => s + p.amount, 0);
    expect(credited + paidOut).toBe(20);
  });
});

describe("the routes", () => {
  it("preview, then cancel as chosen, in the activity log with the payout; the day's list shows it for the till", async () => {
    const b = await book(1, 20, { via: "cash" });
    const seen = await post(cancelRoute, "/api/admin/bookings/cancel", deskCookie, { code: b.code, preview: true });
    expect(seen.status).toBe(200);
    const { preview } = await seen.json();
    expect(preview.options.find((o: { outcome: string }) => o.outcome === "keep")).toEqual({ outcome: "keep", refund: 10, kept: 10 });
    const done = await post(cancelRoute, "/api/admin/bookings/cancel", deskCookie, { code: b.code, outcome: "keep", expectRefund: 10 });
    expect(done.status).toBe(200);
    expect((await done.json()).settled).toMatchObject({ outcome: "keep", paidOut: { amount: 10, via: "cash" } });
    const log = await listActivity([venueId], { bookingCode: b.code });
    expect(log.map((l) => l.action).sort()).toEqual(["booking.cancelled", "payment.paid_out"]);
    expect(log.find((l) => l.action === "payment.paid_out")).toMatchObject({ adminName: "Dina Desk", detail: expect.stringContaining("handed back at the counter, by Cash") });
    expect(log.find((l) => l.action === "booking.cancelled")!.detail).toContain("the venue kept");
    const day = await dayRoute(new NextRequest(`http://localhost/api/admin/bookings?date=${today()}`, { headers: { cookie: deskCookie } }));
    const { payouts } = await day.json();
    expect(payouts.find((p: { bookingCode: string }) => p.bookingCode === b.code)).toMatchObject({ amount: 10, adminName: "Dina Desk" });
  });

  it("refuses the desk a counter payment from an earlier day, and leaves the booking booked", async () => {
    const b = await book(5, 10, { via: "cash" });
    await paidEarlier(b.id);
    const res = await post(cancelRoute, "/api/admin/bookings/cancel", deskCookie, { code: b.code, outcome: "back" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe(COUNTER_REFUSALS.manager);
    expect((await statusOf(b.code)).status).toBe("confirmed");
    expect((await post(cancelRoute, "/api/admin/bookings/cancel", managerCookie, { code: b.code })).status).toBe(200);
  });

  it("rejects an outcome it does not know", async () => {
    const b = await book(5, 11, { via: "cash" });
    expect((await post(cancelRoute, "/api/admin/bookings/cancel", managerCookie, { code: b.code, outcome: "half" })).status).toBe(400);
  });
});

describe("a weekly series, by staff", () => {
  async function series(weeks: number, hour: number) {
    const who = phone();
    const made = await createBookingSeries({ courtId, date: addDays(today(), 4), hours: [hour], weeks, name: "Liga", phone: who });
    if (!made.ok) throw new Error(made.error);
    for (const b of made.bookings) await setPaymentStatus(b.code, true, "cash");
    return { seriesCode: made.seriesCode!, codes: made.bookings.map((b) => b.code), ids: made.bookings.map((b) => b.id) };
  }

  it("previews each week on its own terms, and cancels the weeks chosen, settled as chosen", async () => {
    const s = await series(3, 12);
    const plan = await previewStaffSeries(s.seriesCode, "desk");
    if (!plan.ok) throw new Error(plan.error);
    expect(plan.weeks.map((w) => w.code)).toEqual(s.codes);
    expect(plan.weeks.every((w) => w.paid === 20 && w.how === "counter" && !w.late)).toBe(true);
    const done = await staffCancelSeries(s.seriesCode, s.codes.slice(1), desk, { outcome: "back", expect: { [s.codes[1]]: 20, [s.codes[2]]: 20 } });
    if (!done.ok) throw new Error(done.error);
    expect(done.cancelled.map((c) => c.booking.code)).toEqual(s.codes.slice(1));
    expect(done.left).toEqual([]);
    expect((await statusOf(s.codes[0])).status).toBe("confirmed");
    for (const id of s.ids.slice(1)) expect(await payoutsOf(id)).toMatchObject([{ amount: 20, via: "cash", admin_name: "Dina Desk" }]);
  });

  it("leaves a week the desk may not refund, naming why, and cancels the rest", async () => {
    const s = await series(2, 13);
    await paidEarlier(s.ids[0]);
    const done = await staffCancelSeries(s.seriesCode, s.codes, desk, { outcome: "back" });
    if (!done.ok) throw new Error(done.error);
    expect(done.cancelled.map((c) => c.booking.code)).toEqual([s.codes[1]]);
    expect(done.left).toEqual([{ code: s.codes[0], error: COUNTER_REFUSALS.manager }]);
  });

  it("through the route: previews, cancels, and logs the series", async () => {
    const s = await series(2, 14);
    const seen = await post(cancelSeriesRoute, "/api/admin/bookings/cancel-series", managerCookie, { seriesCode: s.seriesCode, preview: true });
    expect(seen.status).toBe(200);
    expect((await seen.json()).weeks).toHaveLength(2);
    const done = await post(cancelSeriesRoute, "/api/admin/bookings/cancel-series", managerCookie, { seriesCode: s.seriesCode, codes: s.codes, outcome: "back" });
    expect(done.status).toBe(200);
    expect((await done.json()).cancelled).toHaveLength(2);
    const log = await listActivity([venueId], { bookingCode: s.seriesCode });
    expect(log.map((l) => l.action)).toEqual(["booking.series_cancelled"]);
    // Another venue's staff cannot see or cancel it.
    const other = await createVenue({ name: "Elsewhere", area: "Ipoh", address: "y", phone: "0355559999", openHour: 7, closeHour: 23 });
    if (!other.ok) throw new Error("venue");
    const stranger = await createAdmin({ name: "Sam Stranger", email: "sam@else.my", password: "stranger-pass-1", venueId: other.venue.id });
    if (!stranger.ok) throw new Error("staff");
    const cookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(stranger.admin.id)).token}`;
    expect((await post(cancelSeriesRoute, "/api/admin/bookings/cancel-series", cookie, { seriesCode: s.seriesCode, preview: true })).status).toBe(403);
  });
});
