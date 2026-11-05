import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { listActivity } from "../src/lib/activity";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { updatePolicy } from "../src/lib/booking-policy";
import { getDb } from "../src/lib/db";
import { saveRule } from "../src/lib/launch-windows";
import { createBooking, createCourt, createVenue } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import * as attentionRoute from "../src/app/api/admin/attention/route";
import * as bookingsRoute from "../src/app/api/bookings/route";
import * as classesRoute from "../src/app/api/admin/classes/route";
import * as moveSeriesRoute from "../src/app/api/admin/bookings/move-series/route";
import * as rescheduleRoute from "../src/app/api/admin/bookings/reschedule/route";
import * as windowRoute from "../src/app/api/admin/window-overrides/route";

/**
 * The counter's side of ADR 0046: a manager of the venue, and only a manager, goes past an advisory launch or tide window with a reason,
 * on the booking form, a reschedule, a series moved and a class term; front desk, customers, another venue's manager and the platform owner
 * never; a hard window never; the venue's settings, the report and the needs-attention line are a manager's.
 */

const ZONE = "Asia/Kuala_Lumpur";
const day = (n: number) => addDays(todayISO(ZONE), n);
const at = (h: number, m = 0) => h * 60 + m;
const week = (from: number, to: number) => Array.from({ length: 7 }, () => ({ from, to }));
const REASON = "Guests asked for the late tide";
let n = 0;
const phone = () => `0199990${String(++n).padStart(3, "0")}`;

let venueId: number;
let advisory: number;
let hard: number;
let classCourt: number;
let managerCookie: string;
let deskCookie: string;
let strangerCookie: string;
let ownerCookie: string;
let courtN = 0;

const req = (url: string, method: string, cookie: string | null, body?: unknown) =>
  new NextRequest(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": `10.88.${++n % 250}.${n % 200}`, ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
type Answer = { status: number; body: Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
const call = async (handler: (r: NextRequest) => Promise<Response>, url: string, method: string, cookie: string | null, body?: unknown): Promise<Answer> => {
  const res = await handler(req(url, method, cookie, body));
  return { status: res.status, body: (await res.json()) as Record<string, any> }; // eslint-disable-line @typescript-eslint/no-explicit-any
};
const counter = (cookie: string | null, courtId: number, date: string, h: number, extra: Record<string, unknown> = {}) =>
  call(bookingsRoute.POST, "/api/bookings", "POST", cookie, { courtId, date, start: at(h), end: at(h + 1), name: "Paddler Pat", phone: phone(), ...extra });
const make = async (sport: "kayak" = "kayak", capacity = 1) => {
  const c = await createCourt({ venueId, name: `Craft ${++courtN}`, sport, offPeakRate: 20, peakRate: 20, capacity });
  if (!c.ok) throw new Error(c.error);
  return c.court.id;
};
const rule = async (courtId: number, extra: Record<string, unknown> = {}) => {
  const r = await saveRule(venueId, { courtId, source: "weekly", weekly: week(at(7, 10), at(10, 40)), ...extra }, null);
  if (!r.ok) throw new Error(r.error);
};
const overrideRows = async () => (await getDb().prepare("SELECT * FROM booking_window_overrides WHERE venue_id = ? ORDER BY id").all(venueId)) as { action: string; reason: string }[];

beforeAll(async () => {
  await ensureBootstrapAdmin();
  const v = await createVenue({ name: "Route Bay", area: "Langkawi", address: "1 Jalan Pantai", phone: "0495556666", openMin: at(6), closeMin: at(20) });
  const other = await createVenue({ name: "Other Route Bay", area: "Penang", address: "2 Jalan Pantai", phone: "0495557777", openMin: at(6), closeMin: at(20) });
  if (!v.ok || !other.ok) throw new Error("venue");
  venueId = v.venue.id;
  await getDb().prepare("UPDATE venues SET published_at = datetime('now'), book_ahead_days = 60 WHERE id IN (?, ?)").run(venueId, other.venue.id);
  expect(await updatePolicy({ venue: venueId }, { startEvery: 10, lengthStep: 10, minLength: 30, maxLength: 240, noticeMinutes: 0 })).toMatchObject({ ok: true });
  advisory = await make();
  hard = await make();
  classCourt = await make("kayak", 4);
  await rule(advisory);
  await rule(hard, { strength: "hard" });
  await rule(classCourt);
  const mk = async (name: string, venue: number | null, role: "manager" | "desk" = "manager") => {
    const made = await createAdmin({ name, email: `${name.toLowerCase().replace(/\W/g, "")}@routes-window.my`, password: "a long enough password", venueId: venue, role });
    if (!made.ok) throw new Error(made.error);
    return `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(made.admin.id)).token}`;
  };
  managerCookie = await mk("Mina Manager", venueId);
  deskCookie = await mk("Dan Desk", venueId, "desk");
  strangerCookie = await mk("Sam Stranger", other.venue.id);
  ownerCookie = await mk("Olive Owner", null);
});

describe("the counter's refusal says what can be done", () => {
  it("tells a manager an override is available and what it needs, and front desk to ask a manager", async () => {
    const asManager = await counter(managerCookie, advisory, day(3), 12);
    expect(asManager.status).toBe(409);
    expect(asManager.body).toMatchObject({ code: "LAUNCH_WINDOW", policy: "launch_window", overridable: true, askManager: false, hard: false, reasonMin: 15 });
    expect(asManager.body.error).toMatch(/A manager can book it anyway with a reason of at least 15 characters/);
    const asDesk = await counter(deskCookie, advisory, day(3), 12);
    expect(asDesk.body).toMatchObject({ code: "LAUNCH_WINDOW", policy: "launch_window", overridable: false, askManager: true });
  });

  it("tells a customer only what the window is: no strength, no offer", async () => {
    const asCustomer = await counter(null, advisory, day(3), 12);
    expect(asCustomer.status).toBe(409);
    expect(asCustomer.body.code).toBe("LAUNCH_WINDOW");
    expect(asCustomer.body.policy).toBeUndefined();
    expect(asCustomer.body.overridable).toBeUndefined();
    expect(asCustomer.body.strength).toBeUndefined();
  });

  it("says there is no override for a hard window, and why", async () => {
    const asManager = await counter(managerCookie, hard, day(3), 12);
    expect(asManager.body).toMatchObject({ code: "LAUNCH_WINDOW", policy: "launch_window", overridable: false, askManager: false, hard: true });
    expect(asManager.body.error).toMatch(/marked hard by the venue: nothing overrides it/);
  });
});

describe("booking outside an advisory window at the counter", () => {
  it("is a manager's alone: front desk, a customer, another venue's manager and the platform owner are refused", async () => {
    const ask = { overrideWindow: true, windowReason: REASON };
    expect((await counter(deskCookie, advisory, day(4), 12, ask)).body).toMatchObject({ code: "SAFE1_WINDOW_MANAGERS" });
    expect((await counter(deskCookie, advisory, day(4), 12, ask)).status).toBe(403);
    expect((await counter(null, advisory, day(4), 12, ask)).status).toBe(403);
    expect((await counter(strangerCookie, advisory, day(4), 12, ask)).body).toMatchObject({ code: "SAFE1_WINDOW_MANAGERS" });
    expect((await counter(ownerCookie, advisory, day(4), 12, ask)).body).toMatchObject({ code: "SAFE1_WINDOW_MANAGERS" });
    expect(await overrideRows()).toEqual([]);
  });

  it("needs a reason of the venue's length, then goes ahead as a normal booking with the override kept and in the log", async () => {
    expect(await counter(managerCookie, advisory, day(4), 12, { overrideWindow: true })).toMatchObject({ status: 400, body: { code: "SAFE1_WINDOW_REASON" } });
    expect(await counter(managerCookie, advisory, day(4), 12, { overrideWindow: true, windowReason: "too short" })).toMatchObject({ status: 400, body: { code: "SAFE1_WINDOW_REASON", vars: { min: 15 } } });
    const made = await counter(managerCookie, advisory, day(4), 12, { overrideWindow: true, windowReason: REASON });
    expect(made.status).toBe(201);
    expect(made.body.booking).toMatchObject({ status: "confirmed", startMin: at(12), endMin: at(13) });
    expect(await overrideRows()).toEqual([expect.objectContaining({ action: "booked", reason: REASON })]);
    const log = (await listActivity([venueId])).filter((a) => a.action === "booking.window_overridden");
    expect(log).toEqual([expect.objectContaining({ adminName: "Mina Manager", bookingCode: made.body.booking.code })]);
    // The customer-facing booking is an ordinary one.
    expect(made.body.booking.policyOverride).toBeFalsy();
  });

  it("is refused for a hard window, whoever asks", async () => {
    const refused = await counter(managerCookie, hard, day(4), 12, { overrideWindow: true, windowReason: REASON });
    expect(refused).toMatchObject({ status: 409, body: { code: "SAFE1_WINDOW_HARD" } });
    expect(await overrideRows()).toHaveLength(1);
  });

  it("asks nothing where the booking is inside its window: the override is not recorded", async () => {
    const inside = await counter(managerCookie, advisory, day(5), 8, { overrideWindow: true, windowReason: REASON });
    expect(inside.status).toBe(201);
    expect(await overrideRows()).toHaveLength(1);
  });
});

describe("a move, a series moved and a class term", () => {
  it("reschedules a booking outside its window with the override, and refuses it without", async () => {
    const court = await make();
    const made = await createBooking({ courtId: court, date: day(6), start: at(8), end: at(9), name: "Paddler", phone: phone(), by: "staff" });
    if (!made.ok) throw new Error(made.error);
    await rule(court);
    const body = { code: made.booking.code, date: day(6), start: at(13), courtId: court };
    const without = await call(rescheduleRoute.POST, "/api/admin/bookings/reschedule", "POST", managerCookie, body);
    expect(without).toMatchObject({ status: 409, body: { code: "LAUNCH_WINDOW", policy: "launch_window", overridable: true } });
    expect((await call(rescheduleRoute.POST, "/api/admin/bookings/reschedule", "POST", deskCookie, { ...body, overrideWindow: true, windowReason: REASON })).body).toMatchObject({ code: "SAFE1_WINDOW_MANAGERS" });
    const preview = await call(rescheduleRoute.POST, "/api/admin/bookings/reschedule", "POST", managerCookie, { ...body, preview: true, overrideWindow: true, windowReason: REASON });
    expect(preview.status).toBe(200);
    const before = (await overrideRows()).length;
    const moved = await call(rescheduleRoute.POST, "/api/admin/bookings/reschedule", "POST", managerCookie, { ...body, overrideWindow: true, windowReason: REASON });
    expect(moved.status).toBe(200);
    expect(moved.body.booking).toMatchObject({ startMin: at(13) });
    expect((await overrideRows()).length).toBe(before + 1);
    expect((await overrideRows()).pop()).toMatchObject({ action: "moved", reason: REASON });
  });

  it("moves a weekly series with the override, week by week", async () => {
    const court = await make();
    const { createBookingSeries } = await import("../src/lib/store");
    const made = await createBookingSeries({ courtId: court, date: day(10), start: at(12), end: at(13), weeks: 2, name: "Weekly crew", phone: phone(), by: "staff" });
    if (!made.ok || !made.seriesCode) throw new Error("series");
    await rule(court);
    const body = { seriesCode: made.seriesCode, start: at(14), courtId: court };
    expect((await call(moveSeriesRoute.POST, "/api/admin/bookings/move-series", "POST", managerCookie, body)).body.moved).toEqual([]);
    expect((await call(moveSeriesRoute.POST, "/api/admin/bookings/move-series", "POST", deskCookie, { ...body, overrideWindow: true, windowReason: REASON })).body).toMatchObject({ code: "SAFE1_WINDOW_MANAGERS" });
    const moved = await call(moveSeriesRoute.POST, "/api/admin/bookings/move-series", "POST", managerCookie, { ...body, overrideWindow: true, windowReason: REASON });
    expect(moved.body.moved).toHaveLength(2);
  });

  it("schedules a class term outside the window with the override, and refuses it for a hard one", async () => {
    const term = { courtId: classCourt, name: "Dusk paddle", instructor: "Ali", date: day(12), start: at(16), end: at(17), capacity: 2, price: 30, weeks: 2 };
    expect(await call(classesRoute.POST, "/api/admin/classes", "POST", managerCookie, term)).toMatchObject({ status: 409, body: { code: "LAUNCH_WINDOW", policy: "launch_window", overridable: true } });
    const made = await call(classesRoute.POST, "/api/admin/classes", "POST", managerCookie, { ...term, overrideWindow: true, windowReason: REASON });
    expect(made.status).toBe(201);
    expect((await overrideRows()).filter((r) => r.action === "class")).toHaveLength(2);
    const strict = await make("kayak", 4);
    await rule(strict, { strength: "hard" });
    expect(await call(classesRoute.POST, "/api/admin/classes", "POST", managerCookie, { ...term, courtId: strict, overrideWindow: true, windowReason: REASON })).toMatchObject({
      status: 409,
      body: { code: "SAFE1_WINDOW_HARD" },
    });
  });
});

describe("the venue's settings, the report and the alert", () => {
  it("is a manager's: the desk is turned away, another venue's manager too", async () => {
    expect((await call(windowRoute.GET, `/api/admin/window-overrides?venueId=${venueId}`, "GET", deskCookie)).status).toBe(403);
    expect((await call(windowRoute.POST, "/api/admin/window-overrides", "POST", deskCookie, { venueId, enabled: false })).status).toBe(403);
    expect((await call(windowRoute.GET, `/api/admin/window-overrides?venueId=${venueId}`, "GET", strangerCookie)).status).toBe(403);
    expect((await call(windowRoute.GET, "/api/admin/window-overrides", "GET", managerCookie)).status).toBe(400);
  });

  it("shows a manager the overrides with who, when, why and the window, and the venue's settings", async () => {
    const report = await call(windowRoute.GET, `/api/admin/window-overrides?venueId=${venueId}`, "GET", managerCookie);
    expect(report.status).toBe(200);
    expect(report.body.settings).toMatchObject({ enabled: true, reasonMin: 15, weeklyAlert: 5 });
    expect(report.body.overrides.length).toBeGreaterThanOrEqual(4);
    expect(report.body.overrides[0]).toMatchObject({ adminName: "Mina Manager", reason: REASON, window: expect.stringContaining("7:10 AM") });
  });

  it("raises a needs-attention line past the venue's limit for a manager, never for the desk, and turns off at the venue's word", async () => {
    const total = (await overrideRows()).length;
    const set = await call(windowRoute.POST, "/api/admin/window-overrides", "POST", managerCookie, { venueId, weeklyAlert: total - 1, reasonMin: 40 });
    expect(set).toMatchObject({ status: 200, body: { settings: { weeklyAlert: total - 1, reasonMin: 40 } } });
    expect((await listActivity([venueId])).some((a) => a.action === "settings.changed" && a.detail?.includes("Window overrides"))).toBe(true);
    const mgr = await call(attentionRoute.GET, "/api/admin/attention", "GET", managerCookie);
    expect(mgr.body.windowOverrideAlerts).toEqual([{ venueId, count: total, limit: total - 1, days: 7 }]);
    expect((await call(attentionRoute.GET, "/api/admin/attention", "GET", deskCookie)).body.windowOverrideAlerts).toEqual([]);
    // The venue's longer reason applies at the counter now.
    expect(await counter(managerCookie, advisory, day(6), 12, { overrideWindow: true, windowReason: REASON })).toMatchObject({ status: 400, body: { code: "SAFE1_WINDOW_REASON", vars: { min: 40 } } });
    // Turned off at the venue's word: nobody overrides, and the counter stops offering it.
    expect((await call(windowRoute.POST, "/api/admin/window-overrides", "POST", managerCookie, { venueId, enabled: false, reasonMin: null, weeklyAlert: 0 })).status).toBe(200);
    expect((await counter(managerCookie, advisory, day(6), 12)).body).toMatchObject({ policy: "launch_window", overridable: false, askManager: false });
    expect((await counter(managerCookie, advisory, day(6), 12, { overrideWindow: true, windowReason: REASON })).body).toMatchObject({ code: "SAFE1_WINDOW_OFF" });
    expect((await call(attentionRoute.GET, "/api/admin/attention", "GET", managerCookie)).body.windowOverrideAlerts).toEqual([]);
    expect((await call(windowRoute.POST, "/api/admin/window-overrides", "POST", managerCookie, { venueId, enabled: "no" })).status).toBe(400);
    expect((await call(windowRoute.POST, "/api/admin/window-overrides", "POST", managerCookie, { venueId, enabled: true })).status).toBe(200);
  });
});
