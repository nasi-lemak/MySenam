/// <reference types="vite/client" />
import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { updatePolicy } from "../src/lib/booking-policy";
import { getDb } from "../src/lib/db";
import { ruleFor, saveRule, deleteRule, listRules, importTide, addTideEntry, deleteTide, listTide, tideStations, type LaunchRule } from "../src/lib/launch-windows";
import { keepStranded, monthPreview, publishedWindows, strandedByLaunch } from "../src/lib/launch-worklist";
import { instantOf } from "../src/lib/interval";
import { rainOut } from "../src/lib/rain-outs";
import { moveSeries, previewSeriesMove } from "../src/lib/series-moves";
import {
  adminCancelBooking,
  blockSlots,
  closeVenueDay,
  createBooking,
  createBookingSeries,
  createClassSessions,
  createCourt,
  createVenue,
  findBookingByCode,
  getAvailability,
  quoteFor,
  rescheduleBooking,
  searchAvailability,
} from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * Launch and tide windows for water hire (ADR 0037): a resource's daily window narrows its bookable hours on every path that
 * books, moves or searches; a table that runs out closes the day; nothing already booked is cancelled when a window changes,
 * it is listed. The maths is tests/launch-day.test.ts.
 */

const ZONE = "Asia/Kuala_Lumpur";
const day = (n: number) => addDays(todayISO(ZONE), n);
const at = (h: number, m = 0) => h * 60 + m;
const week = (from: number, to: number) => Array.from({ length: 7 }, () => ({ from, to }));
let n = 0;
const phone = () => `0177770${String(++n).padStart(3, "0")}`;

let venueId: number;
let otherVenue: number;
let managerCookie: string;
let deskCookie: string;
let otherCourt: number;
let courtN = 0;

const make = async (capacity = 1, sport: "kayak" | "badminton" = "kayak") => {
  const c = await createCourt({ venueId, name: `Craft ${++courtN}`, sport, offPeakRate: 20, peakRate: 20, capacity });
  if (!c.ok) throw new Error(c.error);
  return c.court.id;
};
const rule = async (courtId: number, extra: Record<string, unknown> = {}, from = at(7, 10), to = at(10, 40)) => {
  const r = await saveRule(venueId, { courtId, source: "weekly", weekly: week(from, to), ...extra }, null);
  if (!r.ok) throw new Error(r.error);
  return r.rule;
};
const book = (courtId: number, date: string, start: number, end: number, extra: Record<string, unknown> = {}) =>
  createBooking({ courtId, date, start, end, name: "Paddler", phone: phone(), ...extra });
const board = async (courtId: number, date: string) => (await getAvailability(venueId, date)).find((c) => c.court.id === courtId)!;

beforeAll(async () => {
  await ensureBootstrapAdmin();
  const v = await createVenue({ name: "Bay Hire", area: "Langkawi", address: "1 Jalan Pantai", phone: "0495551111", openMin: at(6), closeMin: at(20) });
  if (!v.ok) throw new Error("venue");
  venueId = v.venue.id;
  const o = await createVenue({ name: "Other Bay", area: "Penang", address: "2 Jalan Pantai", phone: "0495552222", openMin: at(6), closeMin: at(20) });
  if (!o.ok) throw new Error("venue");
  otherVenue = o.venue.id;
  const oc = await createCourt({ venueId: otherVenue, name: "Other craft", sport: "kayak", offPeakRate: 20, peakRate: 20 });
  if (!oc.ok) throw new Error(oc.error);
  otherCourt = oc.court.id;
  // Starts every ten minutes, from half an hour to four hours, no notice, for every court of this venue.
  expect(await updatePolicy({ venue: venueId }, { startEvery: 10, lengthStep: 10, minLength: 30, maxLength: 240, noticeMinutes: 0 })).toMatchObject({ ok: true });
  const manager = await createAdmin({ name: "Mina Manager", email: "mina@bay.my", password: "manager-pass-1", venueId });
  const desk = await createAdmin({ name: "Dan Desk", email: "dan@bay.my", password: "desk-password-1", venueId, role: "desk" });
  if (!manager.ok || !desk.ok) throw new Error("staff");
  managerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(manager.admin.id)).token}`;
  deskCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.admin.id)).token}`;
});

describe("setting a rule", () => {
  it("keeps one rule per resource and activity, replacing it when set again", async () => {
    const court = await make();
    const first = await rule(court);
    const again = await rule(court, {}, at(8), at(11));
    expect(again.id).toBe(first.id);
    expect(again.weekly![0]).toEqual({ from: at(8), to: at(11) });
    expect((await listRules(venueId)).filter((r) => r.courtId === court)).toHaveLength(1);
  });

  it("refuses a window across midnight, none at all, an unknown source, a resource of another venue and an activity it does not offer", async () => {
    const court = await make();
    const across = await saveRule(venueId, { courtId: court, source: "weekly", weekly: week(at(22), 1500) }, null);
    expect(across).toMatchObject({ ok: false });
    expect(!across.ok && across.error).toMatch(/never crosses midnight/);
    expect(await saveRule(venueId, { courtId: court, source: "weekly", weekly: week(at(10), at(9)) }, null)).toMatchObject({ ok: false });
    expect(await saveRule(venueId, { courtId: court, source: "weekly", weekly: Array(7).fill(null) }, null)).toMatchObject({ ok: false });
    expect(await saveRule(venueId, { courtId: court, source: "weekly", weekly: [1, 2] }, null)).toMatchObject({ ok: false });
    expect(await saveRule(venueId, { courtId: court, source: "moon", weekly: week(at(8), at(9)) }, null)).toMatchObject({ ok: false });
    expect(await saveRule(venueId, { courtId: otherCourt, source: "weekly", weekly: week(at(8), at(9)) }, null)).toMatchObject({ ok: false });
    expect(await saveRule(venueId, { courtId: court, sport: "squash", source: "weekly", weekly: week(at(8), at(9)) }, null)).toMatchObject({ ok: false });
    expect(await saveRule(venueId, { courtId: court, source: "weekly", weekly: week(at(8), at(9)), minWindowMin: -1 }, null)).toMatchObject({ ok: false });
    expect(await saveRule(venueId, { courtId: court, source: "weekly", weekly: week(at(8), at(9)), returnBufferMin: 500 }, null)).toMatchObject({ ok: false });
    expect(await listRules(venueId).then((r) => r.some((x) => x.courtId === court))).toBe(false);
  });

  it("checks the tide half: a station, and a height in range or minutes around a tide", async () => {
    const court = await make();
    const base = { courtId: court, source: "tide" };
    expect(await saveRule(venueId, { ...base, tide: { rule: "height", minHeight: 2 } }, null)).toMatchObject({ ok: false });
    expect(await saveRule(venueId, { ...base, station: "Kuah", tide: { rule: "height", minHeight: 99 } }, null)).toMatchObject({ ok: false });
    expect(await saveRule(venueId, { ...base, station: "Kuah", tide: { rule: "height", minHeight: "" } }, null)).toMatchObject({ ok: false });
    expect(await saveRule(venueId, { ...base, station: "Kuah", tide: { rule: "event", eventKind: "mid", eventMinutes: 60 } }, null)).toMatchObject({ ok: false });
    expect(await saveRule(venueId, { ...base, station: "Kuah", tide: { rule: "event", eventKind: "high", eventMinutes: 9999 } }, null)).toMatchObject({ ok: false });
    expect(await saveRule(venueId, { ...base, station: "Kuah", tide: {} }, null)).toMatchObject({ ok: false });
    const ok = await saveRule(venueId, { ...base, station: "  Kuah   Jetty ", tide: { rule: "height", minHeight: 2.25 }, minWindowMin: 45, returnBufferMin: 20 }, null);
    expect(ok).toMatchObject({ ok: true, rule: { station: "Kuah Jetty", tide: { rule: "height", minHeightCm: 225 }, minWindowMin: 45, returnBufferMin: 20 } });
  });

  it("prefers a rule for one activity over the resource's rule for all", () => {
    const mk = (id: number, sport: string | null) => ({ id, sport }) as unknown as LaunchRule;
    expect(ruleFor([mk(1, null), mk(2, "kayak")], "kayak")!.id).toBe(2);
    expect(ruleFor([mk(1, null), mk(2, "kayak")], "badminton")!.id).toBe(1);
    expect(ruleFor([mk(2, "kayak")], "badminton")).toBeNull();
  });
});

describe("a fixed launch window, on every way of booking", () => {
  it("books inside it and says, outside it, what the window is: the customer's, the counter's and a manager's override alike", async () => {
    const court = await make();
    await rule(court);
    const date = day(3);
    expect(await book(court, date, at(8), at(9))).toMatchObject({ ok: true });
    for (const [start, end] of [[at(6), at(7)], [at(10), at(11)], [at(7), at(8)], [at(11), at(12)]]) {
      const refused = await book(court, date, start, end);
      expect(refused, `${start}-${end}`).toMatchObject({ ok: false, code: "LAUNCH_WINDOW", vars: { window: "7:10 AM–10:40 AM" } });
    }
    // The counter, a manager going past the booking rules: not past the window, which is the venue's data to change.
    expect(await book(court, date, at(11), at(12), { by: "staff", staff: { override: true } })).toMatchObject({ ok: false, code: "LAUNCH_WINDOW" });
    // On the edges of the window.
    expect(await book(court, date, at(7, 10), at(8))).toMatchObject({ ok: true });
    expect(await book(court, date, at(9, 40), at(10, 40))).toMatchObject({ ok: true });
  });

  it("is told in the quote, before any booking is made", async () => {
    const court = await make();
    await rule(court);
    expect(await quoteFor({ courtId: court, date: day(3), start: at(11), end: at(12) })).toMatchObject({ ok: true, allowed: false, refusal: { code: "LAUNCH_WINDOW" } });
    expect(await quoteFor({ courtId: court, date: day(3), start: at(8), end: at(9) })).toMatchObject({ ok: true, allowed: true });
  });

  it("with a return buffer: a hire must be back that long before the window closes, and the refusal says by when", async () => {
    const court = await make();
    await rule(court, { returnBufferMin: 30 });
    const date = day(3);
    expect(await book(court, date, at(9), at(10, 10))).toMatchObject({ ok: true });
    expect(await book(court, date, at(8), at(10, 30))).toMatchObject({ ok: false, code: "LAUNCH_RETURN", vars: { back: "10:10 AM", minutes: 30 } });
    expect(await book(court, date, at(11), at(12))).toMatchObject({ ok: false, code: "LAUNCH_WINDOW" });
  });

  it("composes with the court's own cleaning time: the return buffer is on the booking's end, cleaning after may run past the window", async () => {
    const court = await make();
    await rule(court, { returnBufferMin: 30 });
    expect(await updatePolicy({ court }, { operationalAfter: 20 })).toMatchObject({ ok: true });
    const date = day(3);
    // Ends at 10:10, the last return; its cleaning (10:10 to 10:30) is the venue's own and is held.
    const made = await book(court, date, at(9), at(10, 10));
    expect(made).toMatchObject({ ok: true });
    expect(await book(court, date, at(10, 20), at(10, 30))).toMatchObject({ ok: false });
    // What is held runs to 10:30, past the window's last return and its close: only the booking's own end is the window's.
    const held = (await getDb().prepare("SELECT upper(occupied) AS e FROM claims WHERE booking_id = ?").get(made.ok ? made.booking.id : 0)) as { e: string | Date };
    expect(new Date(held.e).getTime()).toBe(instantOf(date, at(10, 30), ZONE).getTime());
    // The last start the board offers for a 30-minute hire is the one that ends at 10:10.
    const starts = (await board(court, date)).starts;
    expect(Math.max(...starts.map((s) => s.minute))).toBeLessThanOrEqual(at(9, 40));
  });

  it("narrows the board: cells outside say why, starts and longest hire stay inside, and the day's windows are on the court", async () => {
    const court = await make();
    await rule(court, { returnBufferMin: 30 });
    const b = await board(court, day(4));
    expect(b.launch).toEqual({ windows: [{ start: at(7, 10), end: at(10, 40) }], returnBuffer: 30 });
    const cell = (minute: number) => b.slots.find((s) => s.minute === minute)!;
    expect(cell(at(6))).toMatchObject({ available: false, outside: true, launchReason: "outside_launch" });
    expect(cell(at(9))).toMatchObject({ available: true });
    expect(cell(at(10, 15))).toMatchObject({ available: false, outside: true, launchReason: "return_buffer" });
    expect(cell(at(12))).toMatchObject({ available: false, outside: true, launchReason: "outside_launch" });
    expect(b.starts.every((s) => s.minute >= at(7, 10) && s.minute + 30 <= at(10, 10))).toBe(true);
    const nine = b.starts.find((s) => s.minute === at(9))!;
    // From 09:00 the longest is to 10:10, the last return.
    expect(nine.maxLength).toBe(70);
  });

  it("is kept in search, which offers only starts inside the window", async () => {
    // A venue of its own: search shows each venue's cheapest court for a time.
    const v = await createVenue({ name: "Search Bay", area: "Kuah", address: "3 Jalan Pantai", phone: "0495553333", openMin: at(6), closeMin: at(20) });
    if (!v.ok) throw new Error("venue");
    const c = await createCourt({ venueId: v.venue.id, name: "Search craft", sport: "kayak", offPeakRate: 20, peakRate: 20 });
    if (!c.ok) throw new Error(c.error);
    expect(await updatePolicy({ venue: v.venue.id }, { startEvery: 10, lengthStep: 10, minLength: 30, maxLength: 240, noticeMinutes: 0 })).toMatchObject({ ok: true });
    const before = await searchAvailability({ sport: "kayak", date: day(4), venueIds: [v.venue.id], minutes: 60 });
    expect(before.some((r) => r.startMin === at(12))).toBe(true);
    const saved = await saveRule(v.venue.id, { courtId: c.court.id, source: "weekly", weekly: week(at(7, 10), at(10, 40)) }, null);
    expect(saved.ok).toBe(true);
    const found = await searchAvailability({ sport: "kayak", date: day(4), venueIds: [v.venue.id], minutes: 60 });
    expect(found.length).toBeGreaterThan(0);
    expect(found.every((r) => r.startMin >= at(7, 10) && r.endMin <= at(10, 40))).toBe(true);
  });

  it("applies to each occurrence of a series, and the same by weekday", async () => {
    const court = await make();
    // Fridays only: one weekday has a window.
    const date = day(3);
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    const weekly = Array.from({ length: 7 }, (_, i) => (i === weekday ? { from: at(7, 10), to: at(10, 40) } : null));
    expect(await saveRule(venueId, { courtId: court, source: "weekly", weekly }, null)).toMatchObject({ ok: true });
    expect(await book(court, date, at(8), at(9))).toMatchObject({ ok: true });
    // Another weekday has none.
    const other = day(4);
    expect(await book(court, other, at(8), at(9))).toMatchObject({ ok: false, code: "LAUNCH_CLOSED" });
    expect((await board(court, other)).slots.every((s) => !s.available)).toBe(true);
  });

  it("shuts a day with no window and says so on the customers' board and the preview", async () => {
    const court = await make();
    const date = day(3);
    const weekday = new Date(`${date}T00:00:00Z`).getUTCDay();
    const r = await saveRule(venueId, { courtId: court, source: "weekly", weekly: Array.from({ length: 7 }, (_, i) => (i === weekday ? { from: at(8), to: at(9) } : null)) }, null);
    expect(r.ok).toBe(true);
    const month = date.slice(0, 7);
    const preview = await monthPreview(venueId, r.ok ? r.rule.id : 0, month);
    expect(preview.ok && preview.days.find((d) => d.date === date)).toMatchObject({ windows: [{ start: at(8), end: at(9) }], why: null });
    expect(preview.ok && preview.days.find((d) => d.date === day(4))).toMatchObject({ windows: [], why: "outside_launch" });
  });
});

describe("a tide table", () => {
  const stationCsv = (date: string, rows: [string, string, number][]) => ["date,time,type,height_m", ...rows.map(([t, k, h]) => `${date},${t},${k},${h}`)].join("\n");
  const station = "Kuah";
  let court: number;

  it("is imported with every row checked, nothing stored on a fault, and a preview that stores nothing", async () => {
    const bad = await importTide(venueId, { station, csv: "date,time,type,height_m\n2030-01-01,05:00,high,3\n2030-01-01,xx,low,0.5\n2030-01-01,11:00,mid,1" }, null);
    expect(bad).toMatchObject({ ok: false, errors: [{ line: 3, code: "time" }, { line: 4, code: "type" }] });
    expect(await tideStations(venueId)).toEqual([]);
    const csv = stationCsv(day(10), [["05:00", "low", 0.5], ["10:00", "high", 3.0], ["16:00", "low", 0.4], ["22:30", "high", 3.1]]);
    const preview = await importTide(venueId, { station, csv, preview: true }, null);
    expect(preview).toMatchObject({ ok: true, added: 4, changed: 0, unchanged: 0, preview: true, from: day(10), until: day(10) });
    expect(await tideStations(venueId)).toEqual([]);
    const done = await importTide(venueId, { station, csv }, null);
    expect(done).toMatchObject({ ok: true, added: 4 });
    expect(await tideStations(venueId)).toEqual([{ station, entries: 4, from: day(10), until: day(10) }]);
  });

  it("replaces an entry at the same moment, counting what changed, and keeps entries typed by hand apart", async () => {
    const csv = stationCsv(day(10), [["05:00", "low", 0.5], ["10:00", "high", 3.2], ["16:00", "low", 0.4], ["22:30", "high", 3.1]]);
    expect(await importTide(venueId, { station, csv }, null)).toMatchObject({ ok: true, added: 0, changed: 1, unchanged: 3 });
    const typed = await addTideEntry(venueId, { station, date: day(11), time: "04:30", kind: "low", heightM: "0.6" }, null);
    expect(typed).toMatchObject({ ok: true, added: 1 });
    expect(await addTideEntry(venueId, { station, date: day(11), time: "bad", kind: "low", heightM: "0.6" }, null)).toMatchObject({ ok: false, errors: [{ code: "time" }] });
    const entries = await listTide(venueId, station, day(10));
    expect(entries.map((e) => [e.date, e.time, e.kind, e.heightCm, e.source])).toEqual([
      [day(10), "05:00", "low", 50, "csv"],
      [day(10), "10:00", "high", 320, "csv"],
      [day(10), "16:00", "low", 40, "csv"],
      [day(10), "22:30", "high", 310, "csv"],
      [day(11), "04:30", "low", 60, "typed"],
    ]);
    // Another venue's table is its own.
    expect(await listTide(otherVenue, station, day(10))).toEqual([]);
  });

  it("opens the hours the tide is high enough for, and closes every date the table does not cover", async () => {
    court = await make();
    const saved = await saveRule(venueId, { courtId: court, source: "tide", station, tide: { rule: "height", minHeight: 2 }, minWindowMin: 30 }, null);
    expect(saved).toMatchObject({ ok: true });
    const date = day(10);
    const b = await board(court, date);
    expect(b.launch!.windows).toHaveLength(1);
    const w = b.launch!.windows[0];
    // Rising from 05:00 to 10:00 and falling to 16:00, high through the middle of the day.
    expect(w.start).toBeGreaterThan(at(6));
    expect(w.start).toBeLessThan(at(10));
    expect(w.end).toBeGreaterThan(at(10));
    expect(w.end).toBeLessThan(at(16));
    const inside = { start: Math.ceil(w.start / 10) * 10, end: Math.ceil(w.start / 10) * 10 + 60 };
    expect(await book(court, date, inside.start, inside.end)).toMatchObject({ ok: true });
    expect(await book(court, date, at(6), at(7))).toMatchObject({ ok: false, code: "LAUNCH_WINDOW" });
    // The day before the table begins, and the day after it ends: no tide data, never open.
    for (const d of [day(8), day(14)]) {
      expect(await book(court, d, at(10), at(11)), d).toMatchObject({ ok: false, code: "TIDE_NO_DATA" });
      const cells = (await board(court, d)).slots;
      expect(cells.every((s) => !s.available && s.launchReason === "no_tide_data"), d).toBe(true);
    }
  });

  it("closes the later weeks of a series the table does not reach: skipped with the reason, or the whole series refused", async () => {
    const date = day(10);
    const w = (await board(court, date)).launch!.windows[0];
    // After the hour the first test of this table booked from the window's start.
    const start = Math.ceil(w.start / 10) * 10 + 70;
    const skipping = await createBookingSeries({ courtId: court, date, start, end: start + 60, weeks: 3, skipConflicts: true, name: "Series", phone: phone() });
    expect(skipping, JSON.stringify(skipping)).toMatchObject({ ok: true, skipped: [{ date: addDays(date, 7), reason: "no tide data" }, { date: addDays(date, 14), reason: "no tide data" }] });
    expect(skipping.ok && skipping.bookings).toHaveLength(1);
    const whole = await createBookingSeries({ courtId: court, date, start: start + 130, end: start + 190, weeks: 2, name: "Series", phone: phone() });
    expect(whole).toMatchObject({ ok: false });
    expect(!whole.ok && whole.error).toMatch(/no tide data/);
    // Nothing of the refused series was made.
    expect(await getDb().prepare("SELECT COUNT(*)::int AS n FROM bookings WHERE court_id = ? AND date = ?").get(court, date)).toMatchObject({ n: 2 });
  });

  it("is the same for classes: each session must be inside its day's window", async () => {
    const date = day(10);
    const w = (await board(court, date)).launch!.windows[0];
    const start = Math.ceil((w.start + 10) / 10) * 10;
    expect(await createClassSessions({ courtId: court, name: "Dawn paddle", instructor: "Ali", date, start: at(6), end: at(7), capacity: 1, price: 30 })).toMatchObject({ ok: false, code: "LAUNCH_WINDOW" });
    expect(await createClassSessions({ courtId: court, name: "Term paddle", instructor: "Ali", date, start, end: start + 30, capacity: 1, price: 30, weeks: 2 })).toMatchObject({ ok: false, code: "LAUNCH_WEEK", vars: { date: addDays(date, 7) } });
    // (After the bookings above: the hour from the window's start, and the series' hour after it.)
    const free = Math.ceil(w.start / 10) * 10 + 140;
    expect(await createClassSessions({ courtId: court, name: "One paddle", instructor: "Ali", date, start: free, end: free + 30, capacity: 1, price: 30 })).toMatchObject({ ok: true });
  });

  it("removes entries one at a time or by dates, and a venue cannot remove another's", async () => {
    const one = (await listTide(venueId, station, day(11)))[0];
    expect(await deleteTide(otherVenue, { id: one.id })).toMatchObject({ ok: false });
    expect(await deleteTide(venueId, { id: one.id })).toMatchObject({ ok: true, removed: 1 });
    expect(await deleteTide(venueId, { station, from: day(10), until: day(10) })).toMatchObject({ ok: true, removed: 4 });
    expect(await deleteTide(venueId, { station, from: day(12), until: day(10) })).toMatchObject({ ok: false });
    expect(await tideStations(venueId)).toEqual([]);
    // With the table gone, the rule closes every date: never open.
    expect(await book(court, day(10), at(10), at(11))).toMatchObject({ ok: false, code: "TIDE_NO_DATA" });
  });
});

describe("moving a booking", () => {
  it("is held to the window: a customer's move outside it is refused, inside it goes ahead, a manager's too", async () => {
    const court = await make();
    const made = await book(court, day(5), at(8), at(9));
    if (!made.ok) throw new Error(made.error);
    await rule(court);
    const code = made.booking.code;
    expect(await rescheduleBooking(code, { date: day(5), start: at(12), courtId: court }, "customer")).toMatchObject({ ok: false, code: "LAUNCH_WINDOW" });
    expect(await rescheduleBooking(code, { date: day(5), start: at(12), courtId: court, override: true }, "staff")).toMatchObject({ ok: false, code: "LAUNCH_WINDOW" });
    expect(await rescheduleBooking(code, { date: day(5), start: at(9), courtId: court }, "customer")).toMatchObject({ ok: true });
  });
});

describe("moving a weekly series, and its preview", () => {
  it("names each week the window refuses and moves none of them, then moves them all to a time inside it", async () => {
    const court = await make();
    const made = await createBookingSeries({ courtId: court, date: day(10), start: at(12), end: at(13), weeks: 3, name: "Weekly crew", phone: phone() });
    if (!made.ok || !made.seriesCode) throw new Error("series");
    await rule(court);
    const outside = await previewSeriesMove(made.seriesCode, { start: at(14), courtId: court });
    expect(outside.ok && outside.weeks.map((w) => [w.movable, w.refusal?.code])).toEqual([[false, "LAUNCH_WINDOW"], [false, "LAUNCH_WINDOW"], [false, "LAUNCH_WINDOW"]]);
    const inside = await previewSeriesMove(made.seriesCode, { start: at(8), courtId: court });
    expect(inside.ok && inside.weeks.every((w) => w.movable)).toBe(true);
    // The manager's override does not go past the window.
    const forced = await previewSeriesMove(made.seriesCode, { start: at(14), courtId: court, override: true });
    expect(forced.ok && forced.weeks.every((w) => !w.movable && w.refusal?.code === "LAUNCH_WINDOW")).toBe(true);
    const refused = await moveSeries({ id: 0, name: "Mina", role: "manager" }, made.seriesCode, { start: at(14), courtId: court, override: true });
    expect(refused.ok && refused.moved).toEqual([]);
    expect(refused.ok && refused.left.map((l) => l.errorCode)).toEqual(["LAUNCH_WINDOW", "LAUNCH_WINDOW", "LAUNCH_WINDOW"]);
    const moved = await moveSeries({ id: 0, name: "Mina", role: "manager" }, made.seriesCode, { start: at(8), courtId: court });
    expect(moved.ok && moved.moved.length).toBe(3);
    // And no week of it is outside the window now.
    expect((await strandedByLaunch(venueId)).stranded.filter((s) => s.courtId === court)).toEqual([]);
  });
});

describe("composition with what else closes time", () => {
  it("is narrower than the opening hours where they are, and a manager's block, a rained-off stretch and a closed day all still hold", async () => {
    const court = await make();
    // 05:00 to 12:00 asked of a venue that opens at 06:00: the opening hours decide where they are narrower.
    await rule(court, {}, at(5), at(12));
    const date = day(6);
    expect(await book(court, date, at(5), at(6))).toMatchObject({ ok: false, code: "HOURS_OUTSIDE_OPENING" });
    expect((await board(court, date)).launch!.windows).toEqual([{ start: at(6), end: at(12) }]);
    expect(await book(court, date, at(11), at(12, 30))).toMatchObject({ ok: false, code: "LAUNCH_WINDOW" });
    // A block inside the window closes its hour without the window's reason.
    await blockSlots(court, date, { start: at(8), end: at(9) }, "Repair");
    expect(await book(court, date, at(8), at(9))).toMatchObject({ ok: false });
    const cell = (await board(court, date)).slots.find((s) => s.minute === at(8))!;
    expect(cell.available).toBe(false);
    expect(cell.launchReason).toBeUndefined();
    expect(await book(court, date, at(9), at(10))).toMatchObject({ ok: true });
    // Rained off 10:00 to 11:00: the hour stays blocked and the rest of the window is as it was.
    const rain = await rainOut({ venueId, courtIds: [court], date, fromMin: at(10), untilMin: at(11), reason: "Storm" });
    expect(rain).toMatchObject({ ok: true });
    expect(await book(court, date, at(10), at(11))).toMatchObject({ ok: false });
    expect(await book(court, date, at(11), at(12))).toMatchObject({ ok: true });
    // A closed day is closed.
    await closeVenueDay(venueId, day(7), "Holiday");
    expect(await book(court, day(7), at(8), at(9))).toMatchObject({ ok: false, code: "VENUE_CLOSED" });
  });

  it("does not narrow a court with no rule, nor another venue's", async () => {
    const plain = await make();
    expect(await book(plain, day(3), at(15), at(16))).toMatchObject({ ok: true });
    expect((await board(plain, day(3))).launch).toBeUndefined();
    expect(await book(otherCourt, day(3), at(15), at(16))).toMatchObject({ ok: true });
  });
});

describe("what a change leaves outside the window", () => {
  it("lists the bookings and classes it strands and cancels none; keeping one holds until the window changes again", async () => {
    const court = await make();
    const date = day(8);
    const inside = await book(court, date, at(8), at(9));
    const outside = await book(court, date, at(12), at(13));
    const second = await book(court, day(9), at(14), at(15));
    const cancelled = await book(court, day(9), at(16), at(17));
    const cls = await createClassSessions({ courtId: court, name: "Afternoon paddle", instructor: "Ali", date: day(9), start: at(17), end: at(18), capacity: 1, price: 20 });
    if (!inside.ok || !outside.ok || !second.ok || !cancelled.ok || !cls.ok) throw new Error("setup");
    expect((await adminCancelBooking(cancelled.booking.code)).ok).toBe(true);
    expect((await strandedByLaunch(venueId)).stranded.filter((s) => s.courtId === court)).toEqual([]);

    // The rule that strands them.
    const saved = await saveRule(venueId, { courtId: court, source: "weekly", weekly: week(at(7, 10), at(10, 40)) }, null);
    expect(saved.ok).toBe(true);
    const list = (await strandedByLaunch(venueId)).stranded.filter((s) => s.courtId === court);
    expect(list.map((s) => [s.kind, s.date, s.startMin, s.why])).toEqual([
      ["booking", date, at(12), "LAUNCH_WINDOW"],
      ["booking", day(9), at(14), "LAUNCH_WINDOW"],
      ["class", day(9), at(17), "LAUNCH_WINDOW"],
    ]);
    expect(list[0]).toMatchObject({ ref: outside.booking.code, phone: outside.booking.phone, windows: [{ start: at(7, 10), end: at(10, 40) }] });
    // Nothing was cancelled, and the booking inside the window is not listed.
    for (const b of [inside, outside, second]) expect((await findBookingByCode(b.ok ? b.booking.code : ""))!.status).toBe("confirmed");
    expect((await getDb().prepare("SELECT status FROM classes WHERE id = ?").get(cls.classes[0].id)) as { status: string }).toMatchObject({ status: "scheduled" });

    // Keeping one as booked takes it off the list, not off the record.
    expect(await keepStranded(venueId, outside.booking.code, null)).toMatchObject({ ok: true });
    let now = await strandedByLaunch(venueId);
    expect(now.stranded.filter((s) => s.courtId === court).map((s) => s.ref)).not.toContain(outside.booking.code);
    expect(now.kept.map((s) => s.ref)).toContain(outside.booking.code);
    // A booking that is not outside is not kept, nor one at another venue.
    expect(await keepStranded(venueId, inside.booking.code, null)).toMatchObject({ ok: false });
    expect(await keepStranded(otherVenue, second.booking.code, null)).toMatchObject({ ok: false });

    // The window changes again: it is listed again.
    await saveRule(venueId, { courtId: court, source: "weekly", weekly: week(at(7, 10), at(10, 30)) }, null);
    now = await strandedByLaunch(venueId);
    expect(now.stranded.map((s) => s.ref)).toContain(outside.booking.code);
    expect(now.kept.map((s) => s.ref)).not.toContain(outside.booking.code);

    // Moving it through the existing path takes it off.
    expect(await rescheduleBooking(outside.booking.code, { date, start: at(9), courtId: court }, "staff")).toMatchObject({ ok: true });
    now = await strandedByLaunch(venueId);
    expect(now.stranded.map((s) => s.ref)).not.toContain(outside.booking.code);
    // Moving the window to take them in clears the rest, and removing the rule clears everything.
    await saveRule(venueId, { courtId: court, source: "weekly", weekly: week(at(7), at(19)) }, null);
    expect((await strandedByLaunch(venueId)).stranded.filter((s) => s.courtId === court)).toEqual([]);
  });

  it("is listed for the venue's own rules only, and lists a table corrected under a booking", async () => {
    const court = await make();
    const date = day(12);
    const station = "Correction Bay";
    const csv = (high: number) => `date,time,type,height_m\n${date},04:00,low,0.5\n${date},10:00,high,${high}\n${date},17:00,low,0.5`;
    expect(await importTide(venueId, { station, csv: csv(3.0) }, null)).toMatchObject({ ok: true });
    expect(await saveRule(venueId, { courtId: court, source: "tide", station, tide: { rule: "height", minHeight: 2 } }, null)).toMatchObject({ ok: true });
    const made = await book(court, date, at(9, 30), at(10, 30));
    expect(made).toMatchObject({ ok: true });
    expect((await strandedByLaunch(venueId)).stranded.filter((s) => s.courtId === court)).toEqual([]);
    // The venue corrects the table: that high tide was only 1.5 m. The booking stays, and is listed.
    expect(await importTide(venueId, { station, csv: csv(1.5) }, null)).toMatchObject({ ok: true, changed: 1 });
    const stranded = (await strandedByLaunch(venueId)).stranded.filter((s) => s.courtId === court);
    expect(stranded).toHaveLength(1);
    expect(stranded[0]).toMatchObject({ ref: made.ok ? made.booking.code : "", why: "LAUNCH_CLOSED" });
    expect((await findBookingByCode(stranded[0].ref))!.status).toBe("confirmed");
    // A rule at another venue never shows here.
    expect((await strandedByLaunch(otherVenue)).stranded).toEqual([]);
  });

  it("removing a rule never touches a booking, and the resource is narrowed by its hours alone again", async () => {
    const court = await make();
    const r = await rule(court);
    const date = day(3);
    expect(await book(court, date, at(12), at(13))).toMatchObject({ ok: false });
    expect(await deleteRule(otherVenue, r.id)).toBeNull();
    expect(await deleteRule(venueId, r.id)).toMatchObject({ id: r.id });
    expect(await book(court, date, at(12), at(13))).toMatchObject({ ok: true });
  });

  it("tells customers the window on the venue page: today's and tomorrow's, per resource, or why there is none", async () => {
    const court = await make();
    const r = await rule(court);
    const lines = (await publishedWindows(venueId)).filter((l) => l.courtId === court);
    expect(lines.map((l) => l.date)).toEqual([todayISO(ZONE), addDays(todayISO(ZONE), 1)]);
    expect(lines.every((l) => l.windows.length === 1 && l.windows[0].start === at(7, 10) && l.windows[0].end === at(10, 40))).toBe(true);
    await deleteRule(venueId, r.id);
    expect((await publishedWindows(venueId)).filter((l) => l.courtId === court)).toEqual([]);
  });
});

describe("the staff routes", () => {
  type Handler = (req: NextRequest, ctx?: unknown) => Response | Promise<Response>;
  const routes = import.meta.glob("../src/app/api/admin/**/route.ts");
  const call = async (path: "launch-windows" | "tides", method: string, cookie: string, body?: unknown, query = "") => {
    const mod = (await routes[`../src/app/api/admin/${path}/route.ts`]()) as Record<string, Handler>;
    return mod[method](new NextRequest(`http://localhost/api/admin/${path}${query}`, { method, headers: { cookie, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  };

  it("is a manager's to change and the desk's to read, and each venue's own", async () => {
    const court = await make();
    const body = { venueId, courtId: court, source: "weekly", weekly: week(at(8), at(9)) };
    expect((await call("launch-windows", "POST", deskCookie, body)).status).toBe(403);
    expect((await call("tides", "POST", deskCookie, { venueId, action: "import", station: "S", csv: "x" })).status).toBe(403);
    const saved = await call("launch-windows", "POST", managerCookie, body);
    expect(saved.status).toBe(201);
    const read = await call("launch-windows", "GET", deskCookie, undefined, `?venueId=${venueId}`);
    expect(read.status).toBe(200);
    expect(((await read.json()) as { rules: { courtId: number }[] }).rules.some((r) => r.courtId === court)).toBe(true);
    // Another venue's identifiers are refused, in the body and in the query.
    expect((await call("launch-windows", "POST", managerCookie, { ...body, venueId: otherVenue })).status).toBe(403);
    expect((await call("launch-windows", "GET", managerCookie, undefined, `?venueId=${otherVenue}`)).status).toBe(403);
    expect((await call("tides", "POST", managerCookie, { venueId: otherVenue, action: "add", station: "S", date: day(1), time: "10:00", kind: "high", heightM: 3 })).status).toBe(403);
    // A rule of the other venue's resource, named from this venue.
    expect((await call("launch-windows", "POST", managerCookie, { ...body, courtId: otherCourt })).status).toBe(400);
  });

  it("answers an import row by row, a preview without storing, and the worklist after a change", async () => {
    const court = await make();
    const station = "Route Bay";
    const date = day(13);
    const csv = `date,time,type,height_m\n${date},04:00,low,0.5\n${date},10:00,high,3.0\n${date},16:30,low,0.5`;
    const bad = await call("tides", "POST", managerCookie, { venueId, action: "import", station, csv: `${csv}\n${date},zz,low,1` });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { errors: { line: number; code: string }[] }).errors).toEqual([{ line: 5, code: "time", vars: { value: "zz" } }]);
    const preview = await call("tides", "POST", managerCookie, { venueId, action: "import", station, csv, preview: true });
    expect(preview.status).toBe(200);
    expect(await tideStations(venueId).then((s) => s.some((x) => x.station === station))).toBe(false);
    const done = await call("tides", "POST", managerCookie, { venueId, action: "import", station, csv });
    expect(done.status).toBe(200);
    expect(((await done.json()) as { added: number; stranded: unknown[] }).added).toBe(3);
    // A rule over that table strands what is already booked at 15:00.
    const booked = await book(court, date, at(15), at(16));
    expect(booked).toMatchObject({ ok: true });
    const rule = await call("launch-windows", "POST", managerCookie, { venueId, courtId: court, source: "tide", station, tide: { rule: "event", eventKind: "high", eventMinutes: 60 } });
    expect(rule.status).toBe(201);
    const out = (await rule.json()) as { stranded: { ref: string }[] };
    expect(out.stranded.map((s) => s.ref)).toContain(booked.ok ? booked.booking.code : "");
    const kept = await call("launch-windows", "POST", managerCookie, { venueId, keep: booked.ok ? booked.booking.code : "" });
    expect(kept.status).toBe(200);
    const preview2 = await call("launch-windows", "GET", managerCookie, undefined, `?venueId=${venueId}&preview=${(await listRules(venueId)).find((r) => r.courtId === court)!.id}&month=${date.slice(0, 7)}`);
    expect(preview2.status).toBe(200);
    const m = (await preview2.json()) as { days: { date: string; windows: { start: number; end: number }[] }[] };
    expect(m.days.find((d) => d.date === date)!.windows).toEqual([{ start: at(9), end: at(11) }]);
    expect((await call("launch-windows", "GET", managerCookie, undefined, `?venueId=${venueId}&preview=999999&month=2030-01`)).status).toBe(400);
  });
});
