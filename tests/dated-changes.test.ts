import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { listActivity } from "../src/lib/activity";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { createApiKey } from "../src/lib/api-keys";
import { getDb } from "../src/lib/db";
import {
  applyDueCourtChanges,
  applyDueHours,
  listCourtChanges,
  listHoursChanges,
  setCourtHoursChange,
  setCourtRates,
  setHoursChange,
  withdrawCourtChange,
  withdrawHoursChange,
} from "../src/lib/dated-changes";
import { setHouseRules } from "../src/lib/house-rules";
import { setCourtActivities } from "../src/lib/resources";
import {
  adminCancelBooking,
  createBooking,
  createBookingSeries,
  createCourt,
  createVenue,
  getAvailability,
  getBookingById,
  getCourt,
  getVenue,
  getVenueClosure,
  quoteFor,
  searchAvailability,
  updateVenue,
  venueHours,
} from "../src/lib/store";
import { addDays, dayOfWeek, todayISO } from "../src/lib/time";
import * as bookingsRoute from "../src/app/api/bookings/route";
import * as quoteRoute from "../src/app/api/quote/route";
import * as apiAvailability from "../src/app/api/v1/availability/route";
import * as apiBookings from "../src/app/api/v1/bookings/route";
import * as hoursChangesRoute from "../src/app/api/admin/venues/[id]/hours-changes/route";
import * as hoursChangeRoute from "../src/app/api/admin/venues/[id]/hours-changes/[changeId]/route";
import * as courtChangesRoute from "../src/app/api/admin/courts/[id]/changes/route";
import * as bookingPoliciesRoute from "../src/app/api/admin/booking-policies/route";

/**
 * Opening hours, a court's rates and its own hours set from a later date
 * (audit R8 X1-13, ADR 0027): the date asked about decides which apply, on
 * every path; bookings already made keep their price; hours that would leave
 * bookings outside them are refused with every one listed; a change waiting
 * can be changed and withdrawn; one whose date comes applies by that alone and
 * is made the current settings when staff next touch them.
 */

const ZONE = "Asia/Kuala_Lumpur";
const at = (h: number) => h * 60;
let n = 0;
const phone = () => `0177${String(++n).padStart(6, "0")}`;

/** The first Monday at least ten days ahead: the day changes apply from. */
function mondayAhead(): string {
  let d = addDays(todayISO(ZONE), 10);
  while (dayOfWeek(d) !== 1) d = addDays(d, 1);
  return d;
}
const D = mondayAhead();

let venueId: number;
let court1: number;
let court2: number;
let managerCookie: string;
let deskCookie: string;
let writeKey: string;

const req = (url: string, method: string, cookie: string | null, body?: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(url, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": `10.62.${++n % 250}.${n % 200}`, ...(cookie ? { cookie } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const book = async (courtId: number, date: string, start: number, minutes = 60) => {
  const made = await createBooking({ courtId, date, start, minutes, name: "Hana", phone: phone() });
  if (!made.ok) throw new Error(made.error);
  return made.booking;
};
const quote = async (courtId: number, date: string, start: number, sport?: string) => {
  const q = await quoteFor({ courtId, date, start, minutes: 60, ...(sport ? { sport } : {}) });
  if (!q.ok) throw new Error(q.error);
  return q.quote.court;
};
const slotRate = async (courtId: number, date: string, minute: number) =>
  (await getAvailability(venueId, date)).find((c) => c.court.id === courtId)!.slots.find((s) => s.minute === minute)!.rate;
const starts = async (courtId: number, date: string) =>
  (await getAvailability(venueId, date)).find((c) => c.court.id === courtId)!.starts.map((s) => s.minute);

afterEach(() => vi.useRealTimers());

beforeAll(async () => {
  const made = await createVenue({ name: "Dated Courts", area: "PJ", address: "x", phone: "0312349090", openMin: at(8), closeMin: at(22) });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  await getDb().prepare("UPDATE venues SET published_at = now() WHERE id = ?").run(venueId);
  expect((await setHouseRules(venueId, { aheadDays: 60 })).ok).toBe(true);
  // The same rate at peak and off-peak, so the date alone moves the price.
  const c1 = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 20, peakRate: 20 });
  const c2 = await createCourt({ venueId, name: "Court 2", sport: "badminton", offPeakRate: 20, peakRate: 20 });
  if (!c1.ok || !c2.ok) throw new Error("courts");
  court1 = c1.court.id;
  court2 = c2.court.id;
  // Court 1 is also booked for pickleball, at its own rates.
  expect((await setCourtActivities(court1, [{ sport: "pickleball", offPeakRate: 10, peakRate: 10 }])).ok).toBe(true);
  const manager = await createAdmin({ name: "Mona Manager", email: "mona@dated.test", password: "manager-pass-1", venueId });
  const desk = await createAdmin({ name: "Dian Desk", email: "dian@dated.test", password: "desk-password-1", venueId, role: "desk" });
  if (!manager.ok || !desk.ok) throw new Error("staff");
  managerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(manager.admin.id)).token}`;
  deskCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.admin.id)).token}`;
  const key = await createApiKey(venueId, { name: "Their system", scope: "write" }, null);
  if (!key.ok) throw new Error("key");
  writeKey = key.key;
});

describe("rates from a date", () => {
  it("are refused for today or earlier, and checked as the rates table checks them", async () => {
    const court = (await getCourt(court1))!;
    expect(await setCourtRates(court, { from: todayISO(ZONE), offPeakRate: 30, peakRate: 30 })).toMatchObject({
      ok: false,
      error: "Choose a date after today: a change from today is saved with the settings as usual.",
    });
    expect(await setCourtRates(court, { from: D, offPeakRate: 30, peakRate: 30, memberOffPeakRate: 40 })).toMatchObject({
      ok: false,
      error: "The off-peak member rate is higher than the public one.",
    });
    expect(await setCourtRates(court, { from: D, offPeakRate: -1, peakRate: 30 })).toMatchObject({ ok: false });
  });

  it("a booking made before the change keeps the price it was sold at", async () => {
    const before = await book(court2, D, at(10));
    expect(before.totalPrice).toBe(20);
    const set = await setCourtRates((await getCourt(court2))!, { from: D, offPeakRate: 35, peakRate: 35 });
    expect(set).toMatchObject({ ok: true, was: "RM20/RM20", now: "RM35/RM35" });
    expect((await getBookingById(before.id))!.totalPrice).toBe(20);
    // A new booking that day is at the new rate; the day before, at the old.
    expect((await book(court2, D, at(12))).totalPrice).toBe(35);
    expect((await book(court2, addDays(D, -1), at(12))).totalPrice).toBe(20);
    // What is stored now is still today's rates.
    expect((await getCourt(court2))!.offPeakRate).toBe(20);
  });

  it("the quote, the board, search, the booking form, the counter and the API all price the date asked about", async () => {
    const set = await setCourtRates((await getCourt(court1))!, {
      from: D,
      offPeakRate: 30,
      peakRate: 30,
      activities: [{ sport: "pickleball", offPeakRate: 15, peakRate: 15 }],
    });
    expect(set.ok).toBe(true);
    const eve = addDays(D, -1);
    // The quote.
    expect(await quote(court1, eve, at(9))).toBe(20);
    expect(await quote(court1, D, at(9))).toBe(30);
    expect(await quote(court1, eve, at(9), "pickleball")).toBe(10);
    expect(await quote(court1, D, at(9), "pickleball")).toBe(15);
    const viaQuote = await quoteRoute.GET(req(`http://localhost/api/quote?courtId=${court1}&date=${D}&start=${at(9)}&minutes=60`, "GET", null));
    expect(viaQuote.status).toBe(200);
    expect(await viaQuote.json()).toMatchObject({ court: 30, total: 30 });
    // The board, its cells and the rates it shows.
    expect(await slotRate(court1, eve, at(9))).toBe(20);
    expect(await slotRate(court1, D, at(9))).toBe(30);
    expect((await getAvailability(venueId, D)).find((c) => c.court.id === court1)!.court.offPeakRate).toBe(30);
    expect((await getAvailability(venueId, eve)).find((c) => c.court.id === court1)!.court.offPeakRate).toBe(20);
    // Search.
    const found = await searchAvailability({ sport: "badminton", date: D, fromMin: at(9), toMin: at(9), minutes: 60, venueIds: [venueId] });
    // The cheapest court that day: Court 1 at RM30 (Court 2 is RM35 from D).
    expect(found[0]).toMatchObject({ court: { id: court1 }, totalPrice: 30 });
    const atCourt1 = (await searchAvailability({ sport: "pickleball", date: D, fromMin: at(9), toMin: at(9), minutes: 60, venueIds: [venueId] }))[0];
    expect(atCourt1.totalPrice).toBe(15);
    // The venue's own system.
    const apiDay = await apiAvailability.GET(req(`http://localhost/api/v1/availability?date=${D}`, "GET", null, undefined, { authorization: `Bearer ${writeKey}` }));
    const grid = (await apiDay.json()) as { courts: { id: number; slots: { minute: number; rate: number }[] }[] };
    expect(grid.courts.find((c) => c.id === court1)!.slots.find((s) => s.minute === at(9))!.rate).toBe(30);
    // Booked online, at the counter and through the API: the date's price.
    const ask = (start: number, date = D) => ({ courtId: court1, date, start: at(start), end: at(start + 1), name: "Ravi", phone: phone() });
    const online = await bookingsRoute.POST(req("http://localhost/api/bookings", "POST", null, ask(14)));
    const counter = await bookingsRoute.POST(req("http://localhost/api/bookings", "POST", managerCookie, ask(15)));
    const viaApi = await apiBookings.POST(req("http://localhost/api/v1/bookings", "POST", null, ask(16), { authorization: `Bearer ${writeKey}` }));
    for (const made of [online, counter, viaApi]) {
      expect(made.status).toBe(201);
      expect(((await made.json()) as { booking: { totalPrice: number } }).booking.totalPrice).toBe(30);
    }
    const earlier = await bookingsRoute.POST(req("http://localhost/api/bookings", "POST", managerCookie, ask(14, eve)));
    expect(((await earlier.json()) as { booking: { totalPrice: number } }).booking.totalPrice).toBe(20);
  });

  it("a weekly series spanning the date: each week at its own date's rates", async () => {
    const series = await createBookingSeries({ courtId: court1, date: addDays(D, -7), weeks: 3, start: at(11), minutes: 60, name: "Weekly", phone: phone() });
    if (!series.ok) throw new Error(series.error);
    expect(series.bookings.map((b) => [b.date, b.totalPrice])).toEqual([
      [addDays(D, -7), 20],
      [D, 30],
      [addDays(D, 7), 30],
    ]);
  });

  it("a change waiting can be changed, and withdrawn, and is listed until then", async () => {
    const listed = (await listCourtChanges(venueId)).find((c) => c.courtId === court1)!;
    expect(listed.rates).toHaveLength(1);
    const id = listed.rates[0].id;
    const later = addDays(D, 14);
    const extra = await setCourtRates((await getCourt(court1))!, { from: later, offPeakRate: 40, peakRate: 40 });
    if (!extra.ok) throw new Error(extra.error);
    expect(await quote(court1, later, at(9))).toBe(40);
    expect(await quote(court1, addDays(later, -1), at(9))).toBe(30);
    // Its date moved a day on.
    expect(await setCourtRates((await getCourt(court1))!, { id: extra.change.id, from: addDays(later, 1), offPeakRate: 45, peakRate: 45 })).toMatchObject({ ok: true });
    expect(await quote(court1, later, at(9))).toBe(30);
    expect(await quote(court1, addDays(later, 1), at(9))).toBe(45);
    // Two from one date are refused.
    expect(await setCourtRates((await getCourt(court1))!, { from: D, offPeakRate: 50, peakRate: 50 })).toMatchObject({
      ok: false,
      error: `There is already a change from ${D}. Change that one instead.`,
    });
    // Withdrawn: what applied before carries on.
    expect(await withdrawCourtChange((await getCourt(court1))!, extra.change.id)).toMatchObject({ ok: true });
    expect(await quote(court1, addDays(later, 1), at(9))).toBe(30);
    expect(await withdrawCourtChange((await getCourt(court1))!, extra.change.id)).toMatchObject({ ok: false, error: "That change is not waiting to apply." });
    expect((await listCourtChanges(venueId)).find((c) => c.courtId === court1)!.rates.map((r) => r.id)).toEqual([id]);
  });
});

describe("opening hours from a date", () => {
  it("narrowing is refused while bookings fall outside, listing every one of them", async () => {
    const outEarly = await book(court1, D, at(8));
    const outLate = await book(court2, addDays(D, 1), at(21));
    const inside = await book(court1, addDays(D, 2), at(12));
    const eveEarly = await book(court2, addDays(D, -1), at(8));
    const sundayAfter = addDays(D, 6);
    const onSunday = await book(court2, sundayAfter, at(13));
    // 10:00 to 20:00 from D, and closed on Sundays.
    const week = ["closed", null, null, null, null, null, null];
    const refused = await setHoursChange(venueId, { from: D, openMin: at(10), closeMin: at(20), weekHours: week });
    expect(refused).toMatchObject({ ok: false, error: "3 bookings already made fall outside those hours. Move or cancel them first." });
    if (refused.ok) throw new Error("refused");
    expect(refused.stranded).toEqual([
      { code: outEarly.code, date: D, startMin: at(8), endMin: at(9), court: "Court 1" },
      { code: outLate.code, date: addDays(D, 1), startMin: at(21), endMin: at(22), court: "Court 2" },
      { code: onSunday.code, date: sundayAfter, startMin: at(13), endMin: at(14), court: "Court 2" },
    ]);
    expect(refused.stranded!.map((s) => s.code)).not.toContain(inside.code);
    expect(refused.stranded!.map((s) => s.code)).not.toContain(eveEarly.code);
    // Through the route: 409, with the list, for staff to move or cancel them.
    const res = await hoursChangesRoute.POST(
      req(`http://localhost/api/admin/venues/${venueId}/hours-changes`, "POST", managerCookie, { from: D, openMin: at(10), closeMin: at(20), weekHours: week }),
      { params: Promise.resolve({ id: String(venueId) }) }
    );
    expect(res.status).toBe(409);
    expect(((await res.json()) as { stranded: unknown[] }).stranded).toHaveLength(3);
    // Front desk may not set them at all.
    const desk = await hoursChangesRoute.POST(
      req(`http://localhost/api/admin/venues/${venueId}/hours-changes`, "POST", deskCookie, { from: D, openMin: at(10), closeMin: at(20) }),
      { params: Promise.resolve({ id: String(venueId) }) }
    );
    expect(desk.status).toBe(403);
    // Moved or cancelled, it goes through.
    for (const b of [outEarly, outLate, onSunday]) expect((await adminCancelBooking(b.code)).ok).toBe(true);
    const ok = await hoursChangesRoute.POST(
      req(`http://localhost/api/admin/venues/${venueId}/hours-changes`, "POST", managerCookie, { from: D, openMin: at(10), closeMin: at(20), weekHours: week }),
      { params: Promise.resolve({ id: String(venueId) }) }
    );
    expect(ok.status).toBe(201);
    const log = (await listActivity([venueId])).find((a) => a.action === "hours.scheduled");
    expect(log?.detail).toBe(`Opening hours from ${D}: 8:00 AM–10:00 PM → 10:00 AM–8:00 PM, Sun closed`);
  });

  it("the hours of the date asked about apply: the board, booking, search and closed days", async () => {
    const eve = addDays(D, -1);
    expect(await venueHours(venueId, eve)).toMatchObject({ openMin: at(8), closeMin: at(22), closed: false });
    expect(await venueHours(venueId, D)).toMatchObject({ openMin: at(10), closeMin: at(20), closed: false });
    expect((await starts(court1, eve))[0]).toBe(at(8));
    expect((await starts(court1, D))[0]).toBe(at(10));
    expect(Math.max(...(await starts(court1, D)))).toBeLessThanOrEqual(at(19));
    expect(await createBooking({ courtId: court1, date: D, start: at(8), minutes: 60, name: "Early", phone: phone() })).toMatchObject({ ok: false, code: "HOURS_OUTSIDE_OPENING" });
    expect((await createBooking({ courtId: court1, date: eve, start: at(9), minutes: 60, name: "Early", phone: phone() })).ok).toBe(true);
    const early = await searchAvailability({ sport: "badminton", date: D, fromMin: at(8), toMin: at(9), minutes: 60, venueIds: [venueId] });
    expect(early).toHaveLength(0);
    // Sundays from then on are closed days; the Sunday before is not.
    expect(await getVenueClosure(venueId, addDays(D, 6))).not.toBeNull();
    expect(await getVenueClosure(venueId, addDays(D, -1))).toBeNull();
    // What is stored now is still today's hours, with the change beside it.
    const venue = (await getVenue(venueId))!;
    expect(venue).toMatchObject({ openMin: at(8), closeMin: at(22) });
    expect(venue.hoursChanges?.map((c) => c.from)).toEqual([D]);
  });

  it("changing today's hours leaves the change from a later date alone, and checks only the days before it", async () => {
    // A booking at 21:00 on D is outside the change already; today's hours narrowed to 21:00 do not reach it.
    const wider = await updateVenue(venueId, { closeMin: at(21) });
    expect(wider).toMatchObject({ ok: true, venue: { closeMin: at(21) } });
    expect(await venueHours(venueId, D)).toMatchObject({ openMin: at(10), closeMin: at(20) });
    expect((await updateVenue(venueId, { closeMin: at(22) })).ok).toBe(true);
  });

  it("a change waiting is listed, changed and withdrawn; one under which bookings were made is not withdrawn over them", async () => {
    const [change] = await listHoursChanges(venueId);
    expect(change).toMatchObject({ from: D, openMin: at(10), closeMin: at(20) });
    // Changed through the route: from a day later, 9 to 9.
    const patched = await hoursChangeRoute.PATCH(
      req(`http://localhost/api/admin/venues/${venueId}/hours-changes/${change.id}`, "PATCH", managerCookie, { from: addDays(D, 1), openMin: at(9), closeMin: at(21) }),
      { params: Promise.resolve({ id: String(venueId), changeId: String(change.id) }) }
    );
    expect(patched.status).toBe(200);
    expect(await venueHours(venueId, D)).toMatchObject({ openMin: at(8), closeMin: at(22) });
    expect(await venueHours(venueId, addDays(D, 1))).toMatchObject({ openMin: at(9), closeMin: at(21) });
    // Withdrawn: the hours before it carry on.
    const gone = await hoursChangeRoute.DELETE(
      req(`http://localhost/api/admin/venues/${venueId}/hours-changes/${change.id}`, "DELETE", managerCookie),
      { params: Promise.resolve({ id: String(venueId), changeId: String(change.id) }) }
    );
    expect(gone.status).toBe(200);
    expect(await listHoursChanges(venueId)).toEqual([]);
    expect(await venueHours(venueId, addDays(D, 1))).toMatchObject({ openMin: at(8), closeMin: at(22) });
    expect((await listActivity([venueId])).some((a) => a.action === "hours.withdrawn")).toBe(true);

    // Longer evenings from D: a booking is made into them; withdrawing would strand it.
    const longer = await setHoursChange(venueId, { from: D, openMin: at(8), closeMin: at(23) });
    if (!longer.ok) throw new Error(longer.error);
    const late = await book(court1, addDays(D, 3), at(22));
    expect(await withdrawHoursChange(venueId, longer.change.id)).toMatchObject({
      ok: false,
      stranded: [{ code: late.code, date: addDays(D, 3), startMin: at(22), endMin: at(23), court: "Court 1" }],
    });
    // Nor narrowed back over it.
    expect(await setHoursChange(venueId, { id: longer.change.id, from: D, openMin: at(8), closeMin: at(22) })).toMatchObject({ ok: false });
    expect((await adminCancelBooking(late.code)).ok).toBe(true);
    expect((await withdrawHoursChange(venueId, longer.change.id)).ok).toBe(true);
  });

  it("the evening before a change may not run into its first morning", async () => {
    const late = await updateVenue(venueId, { closeMin: at(26) });
    expect(late.ok).toBe(true);
    expect(await setHoursChange(venueId, { from: D, openMin: at(1), closeMin: at(20) })).toMatchObject({
      ok: false,
      error: `The evening before ${D} runs past that day's opening. Close earlier, or open later from ${D}.`,
    });
    expect((await updateVenue(venueId, { closeMin: at(22) })).ok).toBe(true);
  });
});

describe("a court's own hours from a date", () => {
  it("apply to that court alone from the date, and are refused over its bookings, listing them", async () => {
    const inWay = await book(court2, addDays(D, 2), at(9));
    const own = [null, null, null, null, null, null, null].map(() => ({ open: at(12), close: at(18) }));
    const court = (await getCourt(court2))!;
    const refused = await setCourtHoursChange(court, { from: D, weekHours: own });
    if (refused.ok) throw new Error("refused");
    // Every booking on Court 2 from D outside 12:00 to 18:00: the 10:00 sold before its price rise, and this one.
    expect(refused.stranded).toContainEqual({ code: inWay.code, date: addDays(D, 2), startMin: at(9), endMin: at(10), court: "Court 2" });
    expect(refused.stranded!.every((s) => s.startMin < at(12) || s.endMin > at(18))).toBe(true);
    expect(refused.stranded!.length).toBe(2);
    for (const s of refused.stranded!) expect((await adminCancelBooking(s.code)).ok).toBe(true);
    const res = await courtChangesRoute.POST(
      req(`http://localhost/api/admin/courts/${court2}/changes`, "POST", managerCookie, { kind: "hours", from: D, weekHours: own }),
      { params: Promise.resolve({ id: String(court2) }) }
    );
    expect(res.status).toBe(201);
    expect((await starts(court2, addDays(D, -2)))[0]).toBe(at(8));
    expect((await starts(court2, addDays(D, 1)))[0]).toBe(at(12));
    expect((await starts(court1, addDays(D, 1)))[0]).toBe(at(8));
  });
});

describe("a change whose date has come", () => {
  it("applies by its date alone, and is made the current settings when staff next look", async () => {
    // Rates from D on Court 1 (30, pickleball 15) and own hours from D on Court 2 are waiting; hours from D too.
    const hours = await setHoursChange(venueId, { from: D, openMin: at(7), closeMin: at(22) });
    if (!hours.ok) throw new Error(hours.error);
    const before = await book(court2, addDays(D, -1), at(14));
    // The clock reaches D, noon where the venue is.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(`${D}T04:00:00Z`));
    expect(todayISO(ZONE)).toBe(D);
    // Before anybody touches anything: the venue, the court and the price read as of today.
    expect((await getVenue(venueId))!.openMin).toBe(at(7));
    expect((await getCourt(court1))!.offPeakRate).toBe(30);
    expect((await getCourt(court1))!.activities.find((a) => a.sport === "pickleball")!.offPeakRate).toBe(15);
    expect(await quote(court1, addDays(D, 1), at(9))).toBe(30);
    // Staff look: made current, nothing left waiting.
    expect(await listHoursChanges(venueId)).toEqual([]);
    expect(await listCourtChanges(venueId)).toEqual([]);
    const row = (await getDb().prepare("SELECT open_min, hours_changes FROM venues WHERE id = ?").get(venueId)) as { open_min: number; hours_changes: string };
    expect(row).toEqual({ open_min: at(7), hours_changes: "[]" });
    const c1 = (await getDb().prepare("SELECT off_peak_rate, dated_changes FROM courts WHERE id = ?").get(court1)) as { off_peak_rate: number | string; dated_changes: string };
    expect(Number(c1.off_peak_rate)).toBe(30);
    expect(c1.dated_changes).toBe("[]");
    const pickle = (await getDb().prepare("SELECT off_peak_rate FROM court_activities WHERE court_id = ? AND sport = 'pickleball'").get(court1)) as { off_peak_rate: number | string };
    expect(Number(pickle.off_peak_rate)).toBe(15);
    // Court 2's own hours are now its booking rules' own.
    const policy = (await getDb().prepare("SELECT week_hours FROM booking_policies WHERE court_id = ? AND sport IS NULL").get(court2)) as { week_hours: string };
    expect(JSON.parse(policy.week_hours)[1]).toEqual({ open: at(12), close: at(18) });
    expect((await starts(court2, addDays(D, 1)))[0]).toBe(at(12));
    // Nothing about the bookings made before changed.
    expect((await getBookingById(before.id))!.totalPrice).toBe(20);
    expect(await applyDueHours(venueId)).toBe(0);
    expect(await applyDueCourtChanges({ venueId })).toBe(0);
  });
});

describe("booking rules' hours changed from today", () => {
  it("are refused while bookings already made would fall outside them, every one listed, and nothing is saved (B61)", async () => {
    const day = addDays(D, 3);
    const early = await book(court1, day, at(9));
    const opensBefore = (await starts(court1, day))[0];
    const own = [null, null, null, null, null, null, null].map(() => ({ open: at(12), close: at(18) }));
    const ask = () =>
      bookingPoliciesRoute.POST(
        req("http://localhost/api/admin/booking-policies", "POST", managerCookie, { venueId, level: "court", courtId: court1, settings: { weekHours: own } })
      );
    const refused = await ask();
    expect(refused.status).toBe(409);
    const body = await refused.json();
    expect(body.stranded).toContainEqual({ code: early.code, date: day, startMin: at(9), endMin: at(10), court: "Court 1" });
    // Nothing saved: the court opens that day as it did.
    expect((await starts(court1, day))[0]).toBe(opensBefore);
    for (const s of body.stranded as { code: string }[]) expect((await adminCancelBooking(s.code)).ok).toBe(true);
    expect((await ask()).status).toBe(200);
    expect((await starts(court1, day))[0]).toBe(at(12));
    // Put back for anything after.
    expect(
      (await bookingPoliciesRoute.POST(
        req("http://localhost/api/admin/booking-policies", "POST", managerCookie, { venueId, level: "court", courtId: court1, settings: { weekHours: null } })
      )).status
    ).toBe(200);
  });
});
