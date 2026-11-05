import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { createAdmin, ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { listActivity } from "../src/lib/activity";
import { updatePolicy } from "../src/lib/booking-policy";
import { getDb } from "../src/lib/db";
import { saveRule } from "../src/lib/launch-windows";
import { moveSeries, previewSeriesMove } from "../src/lib/series-moves";
import { createOutage } from "../src/lib/outages";
import { rainOut } from "../src/lib/rain-outs";
import { region } from "../src/lib/region";
import {
  QUALIFICATION_LEVELS,
  RESTRICTIONS,
  STRENGTHS,
  WINDOW_CODES,
  levelBlocks,
  managerMayGoPast,
  strengthOfCode,
  strengthOfLevel,
} from "../src/lib/restriction-strength";
import {
  readWindowOverride,
  saveWindowSettings,
  windowOverrideAlert,
  windowOverrideAuth,
  windowOverridesFor,
  windowOverridesReport,
  windowSettings,
  type WindowOverrideRecord,
} from "../src/lib/window-overrides";
import {
  blockSlots,
  closeVenueDay,
  createBooking,
  createBookingSeries,
  createClassSessions,
  createCourt,
  createVenue,
  listBookingsForDate,
  listVenueClosures,
  moveBooking,
  rescheduleBooking,
} from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { setVenueZone } from "../src/lib/zones";

/**
 * A manager's override of an advisory launch or tide window, with a reason (ADR 0046, which supersedes ADR 0037's F1): the
 * strength of each restriction; the override on every path that refuses a window (a booking, a weekly series, a move, a series
 * moved, a class term); what it never reaches (a hard window, the clocks changing, a closure); the record, the log, the report and the alert.
 */

const ZONE = "Asia/Kuala_Lumpur";
const day = (n: number) => addDays(todayISO(ZONE), n);
const at = (h: number, m = 0) => h * 60 + m;
const week = (from: number, to: number) => Array.from({ length: 7 }, () => ({ from, to }));
const REASON = "Guests asked for the late tide";
let n = 0;
const phone = () => `0188880${String(++n).padStart(3, "0")}`;

let venueId: number;
let managerId: number;
let deskId: number;
let courtN = 0;
let record: WindowOverrideRecord;

const make = async (capacity = 1) => {
  const c = await createCourt({ venueId, name: `Craft ${++courtN}`, sport: "kayak", offPeakRate: 20, peakRate: 20, capacity });
  if (!c.ok) throw new Error(c.error);
  return c.court.id;
};
const rule = async (courtId: number, extra: Record<string, unknown> = {}, from = at(7, 10), to = at(10, 40)) => {
  const r = await saveRule(venueId, { courtId, source: "weekly", weekly: week(from, to), ...extra }, null);
  if (!r.ok) throw new Error(r.error);
  return r.rule;
};
const book = (courtId: number, date: string, start: number, end: number, extra: Record<string, unknown> = {}) =>
  createBooking({ courtId, date, start, end, name: "Paddler", phone: phone(), by: "staff", ...extra });
const ok = <T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> => {
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r as Extract<T, { ok: true }>;
};
const rows = async (courtId?: number) =>
  (await getDb()
    .prepare("SELECT * FROM booking_window_overrides WHERE venue_id = ?" + (courtId ? " AND court_id = ?" : "") + " ORDER BY id")
    .all(...(courtId ? [venueId, courtId] : [venueId]))) as { refusal_code: string; action: string; window_text: string; reason: string; booking_id: number | null; class_id: number | null; admin_name: string; rule_id: number | null }[];

beforeAll(async () => {
  await ensureBootstrapAdmin();
  const v = await createVenue({ name: "Window Bay", area: "Langkawi", address: "1 Jalan Pantai", phone: "0495553333", openMin: at(6), closeMin: at(20) });
  if (!v.ok) throw new Error("venue");
  venueId = v.venue.id;
  expect(await updatePolicy({ venue: venueId }, { startEvery: 10, lengthStep: 10, minLength: 30, maxLength: 240, noticeMinutes: 0 })).toMatchObject({ ok: true });
  const manager = await createAdmin({ name: "Mina Manager", email: "mina@window.my", password: "manager-pass-1", venueId });
  const desk = await createAdmin({ name: "Dan Desk", email: "dan@window.my", password: "desk-password-1", venueId, role: "desk" });
  if (!manager.ok || !desk.ok) throw new Error("staff");
  managerId = manager.admin.id;
  deskId = desk.admin.id;
  const auth = await windowOverrideAuth({ id: managerId, name: "Mina Manager", role: "manager" }, venueId, REASON);
  if (!auth.ok) throw new Error("auth");
  record = auth.record;
});

describe("how firmly a restriction holds", () => {
  it("is one vocabulary: advisory is the only strength a manager goes past", () => {
    expect(STRENGTHS).toEqual(["advisory", "venue_required", "hard"]);
    expect(STRENGTHS.filter(managerMayGoPast)).toEqual(["advisory"]);
    expect(QUALIFICATION_LEVELS.map((l) => [l, strengthOfLevel(l), levelBlocks(l)])).toEqual([
      ["recommended", "advisory", false],
      ["venue_required", "venue_required", true],
      ["legally_required", "hard", true],
    ]);
  });

  it("classifies a refusal by the rule that made it, and the table says which are overridable", () => {
    for (const code of WINDOW_CODES) {
      expect(strengthOfCode(code)).toBe("advisory");
      expect(strengthOfCode(code, "advisory")).toBe("advisory");
      expect(strengthOfCode(code, "hard")).toBe("hard");
    }
    expect(strengthOfCode("CLOCK_CHANGE")).toBe("hard");
    expect(strengthOfCode("SV1_NO_SUPERVISOR")).toBe("venue_required");
    expect(strengthOfCode("SV1_NO_SUPERVISOR_ON")).toBe("venue_required");
    expect(strengthOfCode("R9_DESK_STRIKES")).toBeNull();
    expect(strengthOfCode(undefined)).toBeNull();
    // Only the advisory window is overridden with a reason; every other restriction in the table is never gone past by this override.
    for (const r of RESTRICTIONS) expect(r.override === "reason").toBe(r.strength === "advisory");
    const windowRows = RESTRICTIONS.filter((r) => r.key.startsWith("launch_window"));
    for (const r of windowRows) expect([...r.codes].sort()).toEqual([...WINDOW_CODES].sort());
    expect(RESTRICTIONS.find((r) => r.key === "clock_change")).toMatchObject({ strength: "hard", override: "never" });
    expect(RESTRICTIONS.find((r) => r.key === "safety_closure")).toMatchObject({ strength: "hard", override: "never" });
    expect(RESTRICTIONS.find((r) => r.key === "supervision_required")).toMatchObject({ override: "never" });
  });

  it("keeps existing rules advisory, and a venue may mark one hard (and back)", async () => {
    const court = await make();
    expect((await rule(court)).strength).toBe("advisory");
    expect((await rule(court, { strength: "hard" })).strength).toBe("hard");
    // Left out when it is saved again, a rule keeps its own.
    expect((await rule(court, {}, at(8), at(11))).strength).toBe("hard");
    expect((await rule(court, { strength: "advisory" })).strength).toBe("advisory");
    expect(await saveRule(venueId, { courtId: court, source: "weekly", weekly: week(at(8), at(9)), strength: "soft" }, null)).toMatchObject({ ok: false });
  });
});

describe("asking for the override, and who may", () => {
  it("reads nothing, the reason, or why not", () => {
    expect(readWindowOverride({})).toBeNull();
    expect(readWindowOverride({ overrideWindow: false })).toBeNull();
    expect(readWindowOverride({ overrideWindow: true, windowReason: "  Late tide, guests asked  " })).toEqual({ reason: "Late tide, guests asked" });
    for (const body of [{ overrideWindow: true }, { overrideWindow: true, windowReason: "   " }, { windowReason: "why" }, { overrideWindow: "yes", windowReason: "why" }, { overrideWindow: true, windowReason: "x".repeat(301) }])
      expect(readWindowOverride(body)).toMatchObject({ ok: false, code: "SAFE1_WINDOW_REASON" });
  });

  it("is a manager of the venue's, with a reason of the length the venue asks, unless the venue turned it off", async () => {
    const manager = { id: managerId, name: "Mina Manager", role: "manager" as const };
    expect(await windowSettings(venueId)).toMatchObject({ enabled: true, reasonMin: 15, weeklyAlert: 5 });
    expect(await windowOverrideAuth({ id: deskId, name: "Dan Desk", role: "desk" }, venueId, REASON)).toMatchObject({ ok: false, status: 403, refusal: { code: "SAFE1_WINDOW_MANAGERS" } });
    expect(await windowOverrideAuth(null, venueId, REASON)).toMatchObject({ ok: false, status: 403, refusal: { code: "SAFE1_WINDOW_MANAGERS" } });
    // The platform owner's emergency override is not built: the owner account is no venue's manager here.
    expect(await windowOverrideAuth({ ...manager, owner: true }, venueId, REASON)).toMatchObject({ ok: false, status: 403, refusal: { code: "SAFE1_WINDOW_MANAGERS" } });
    expect(await windowOverrideAuth(manager, venueId, "too short")).toMatchObject({ ok: false, status: 400, refusal: { code: "SAFE1_WINDOW_REASON", vars: { min: 15 } } });
    expect(await windowOverrideAuth(manager, venueId, "x".repeat(301))).toMatchObject({ ok: false, status: 400 });
    expect(await windowOverrideAuth(manager, venueId, REASON)).toMatchObject({ ok: true });
    // A venue turns it off: nobody overrides there, and it comes back on.
    expect(ok(await saveWindowSettings(venueId, { enabled: false }, managerId)).settings.enabled).toBe(false);
    expect(await windowOverrideAuth(manager, venueId, REASON)).toMatchObject({ ok: false, status: 403, refusal: { code: "SAFE1_WINDOW_OFF" } });
    ok(await saveWindowSettings(venueId, { enabled: true }, managerId));
    expect(await windowOverrideAuth(manager, venueId, REASON)).toMatchObject({ ok: true });
  });

  it("keeps the venue's own figures, and takes them back to the install's", async () => {
    const manager = { id: managerId, name: "Mina Manager", role: "manager" as const };
    const set = ok(await saveWindowSettings(venueId, { reasonMin: 40, weeklyAlert: 2 }, managerId));
    expect(set.settings).toMatchObject({ reasonMin: 40, weeklyAlert: 2, own: { reasonMin: true, weeklyAlert: true } });
    expect(await windowOverrideAuth(manager, venueId, REASON)).toMatchObject({ ok: false, refusal: { code: "SAFE1_WINDOW_REASON", vars: { min: 40 } } });
    expect(await saveWindowSettings(venueId, { reasonMin: 2 }, managerId)).toMatchObject({ ok: false });
    expect(await saveWindowSettings(venueId, { reasonMin: 301 }, managerId)).toMatchObject({ ok: false });
    expect(await saveWindowSettings(venueId, { weeklyAlert: -1 }, managerId)).toMatchObject({ ok: false });
    expect(await saveWindowSettings(venueId, { enabled: "no" }, managerId)).toMatchObject({ ok: false });
    expect(await windowSettings(venueId)).toMatchObject({ reasonMin: 40, weeklyAlert: 2 });
    const reset = ok(await saveWindowSettings(venueId, { reasonMin: null, weeklyAlert: "" }, managerId));
    expect(reset.settings).toMatchObject({ reasonMin: 15, weeklyAlert: 5, own: { reasonMin: false, weeklyAlert: false } });
  });
});

describe("booking outside an advisory window", () => {
  it("is refused as ever without the override, saying how firmly the rule holds; a court's own override goes past none of it", async () => {
    const court = await make();
    await rule(court);
    const refused = await book(court, day(3), at(12), at(13));
    expect(refused).toMatchObject({ ok: false, code: "LAUNCH_WINDOW", strength: "advisory", vars: { window: "7:10 AM–10:40 AM" } });
    expect(await book(court, day(3), at(12), at(13), { staff: { override: true } })).toMatchObject({ ok: false, code: "LAUNCH_WINDOW" });
    expect(await rows(court)).toEqual([]);
  });

  it("goes ahead for a manager with a reason: a normal booking, with the override, the window and the reason kept, and in the log", async () => {
    const court = await make();
    const r = await rule(court);
    const made = ok(await book(court, day(3), at(12), at(13), { windowOverride: record }));
    expect(made.booking).toMatchObject({ status: "confirmed", startMin: at(12), endMin: at(13) });
    expect((await rows(court))[0]).toMatchObject({
      refusal_code: "LAUNCH_WINDOW",
      action: "booked",
      window_text: "7:10 AM–10:40 AM",
      reason: REASON,
      admin_name: "Mina Manager",
      rule_id: r.id,
      booking_id: made.booking.id,
    });
    const shown = (await listBookingsForDate(day(3), venueId)).find((b) => b.code === made.booking.code)!;
    expect(shown.windowOverrides).toEqual([expect.objectContaining({ code: "LAUNCH_WINDOW", reason: REASON, adminName: "Mina Manager", window: "7:10 AM–10:40 AM" })]);
    expect(shown.policyOverride).toBe(false);
    const log = (await listActivity([venueId])).filter((a) => a.action === "booking.window_overridden");
    expect(log.some((a) => a.bookingCode === made.booking.code && a.adminName === "Mina Manager" && a.detail?.includes(REASON) && a.detail.includes("LAUNCH_WINDOW"))).toBe(true);
    expect((await windowOverridesFor([made.booking.id])).get(made.booking.id)).toHaveLength(1);
  });

  it("records the refusal it went past: back after the last return, a closed day, and a tide table with nothing in it", async () => {
    const back = await make();
    await rule(back, { returnBufferMin: 30 });
    ok(await book(back, day(4), at(10), at(10, 30), { windowOverride: record }));
    const closedDay = await make();
    await rule(closedDay, {}, at(7), at(10));
    // A weekday with no window at all.
    expect((await saveRule(venueId, { courtId: closedDay, source: "weekly", weekly: Array.from({ length: 7 }, (_, i) => (i === 3 ? { from: at(8), to: at(9) } : null)) }, null)).ok).toBe(true);
    let date = day(5);
    while (new Date(`${date}T00:00:00Z`).getUTCDay() === 3) date = addDays(date, 1);
    expect(await book(closedDay, date, at(8), at(9))).toMatchObject({ ok: false, code: "LAUNCH_CLOSED" });
    ok(await book(closedDay, date, at(8), at(9), { windowOverride: record }));
    const tide = await make();
    expect((await saveRule(venueId, { courtId: tide, source: "tide", station: "Kuah", tide: { rule: "height", minHeight: 2 } }, null)).ok).toBe(true);
    expect(await book(tide, day(6), at(8), at(9))).toMatchObject({ ok: false, code: "TIDE_NO_DATA" });
    ok(await book(tide, day(6), at(8), at(9), { windowOverride: record }));
    expect((await rows(back))[0].refusal_code).toBe("LAUNCH_RETURN");
    expect((await rows(closedDay))[0]).toMatchObject({ refusal_code: "LAUNCH_CLOSED", window_text: "closed" });
    expect((await rows(tide))[0].refusal_code).toBe("TIDE_NO_DATA");
  });

  it("writes nothing for a booking that needed none, and nothing for one that fails", async () => {
    const court = await make();
    await rule(court);
    ok(await book(court, day(3), at(8), at(9), { windowOverride: record }));
    expect(await rows(court)).toEqual([]);
    ok(await book(court, day(3), at(12), at(13), { windowOverride: record }));
    // The same time again is taken: the claim refuses it and the second record goes with it.
    expect(await book(court, day(3), at(12), at(13), { windowOverride: record })).toMatchObject({ ok: false });
    expect(await rows(court)).toHaveLength(1);
  });

  it("never goes past a hard window: it says there is no override, and books nothing", async () => {
    const court = await make();
    await rule(court, { strength: "hard" });
    expect(await book(court, day(3), at(12), at(13))).toMatchObject({ ok: false, code: "LAUNCH_WINDOW", strength: "hard" });
    expect(await book(court, day(3), at(12), at(13), { windowOverride: record })).toMatchObject({ ok: false, code: "SAFE1_WINDOW_HARD" });
    expect(await book(court, day(3), at(12), at(13), { windowOverride: record, staff: { override: true } })).toMatchObject({ ok: false, code: "SAFE1_WINDOW_HARD" });
    expect(await rows(court)).toEqual([]);
    // Inside a hard window nothing changes.
    expect(ok(await book(court, day(3), at(8), at(9))).booking.status).toBe("confirmed");
  });

  it("goes past no closure, block or full day: the court's time is held by the database", async () => {
    const court = await make();
    await rule(court);
    expect(ok(await blockSlots(court, day(7), { start: at(12), end: at(14) }, "Hull repair", undefined, { safety: true })).ok).toBe(true);
    expect(await book(court, day(7), at(12), at(13), { windowOverride: record })).toMatchObject({ ok: false });
    const closed = day(8);
    ok(await closeVenueDay(venueId, closed, "Public holiday"));
    expect(await book(court, closed, at(12), at(13), { windowOverride: record })).toMatchObject({ ok: false, code: "VENUE_CLOSED" });
    expect(await rows(court)).toEqual([]);
  });

  it("goes past no supervision requirement: that refusal is not a window's", async () => {
    const court = await make();
    await rule(court);
    const { listRoles, setRule: setSupervision } = await import("../src/lib/rosters");
    const guard = (await listRoles(venueId)).find((r) => r.key === "lifeguard")!;
    ok(await setSupervision(venueId, { courtId: court, roleId: guard.id, needed: 1 }));
    expect(await book(court, day(3), at(12), at(13), { windowOverride: record })).toMatchObject({ ok: false, code: "SV1_NO_SUPERVISOR" });
    expect(await rows(court)).toEqual([]);
  });
});

describe("moving a booking to another resource (B76)", () => {
  it("asks the other resource's launch window: a booking is not moved to a craft whose window it falls outside", async () => {
    const from = await make();
    const to = await make();
    // The first craft has no rule; the second launches 07:10 to 10:40 only.
    await rule(to);
    const date = day(3);
    const booked = ok(await book(from, date, at(12), at(13)));
    const refused = await moveBooking(booked.booking.code, to);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.code).toMatch(/LAUNCH_/);
    // Inside the window it moves.
    const inside = ok(await book(from, date, at(8), at(9)));
    expect((await moveBooking(inside.booking.code, to)).ok).toBe(true);
  });
});

describe("safety closures", () => {
  it("marks a block, a rain-out, a closed day and an outage as a safety closure when the venue says so, and none otherwise", async () => {
    const court = await make();
    const blockSafety = async (date: string) =>
      ((await getDb().prepare("SELECT safety FROM blocks WHERE court_id = ? AND date = ?").all(court, date)) as { safety: boolean }[]).map((r) => r.safety);
    ok(await blockSlots(court, day(11), { start: at(12), end: at(13) }, "Hull repair"));
    ok(await blockSlots(court, day(12), { start: at(12), end: at(13) }, "Red flag", undefined, { safety: true }));
    expect(await blockSafety(day(11))).toEqual([false]);
    expect(await blockSafety(day(12))).toEqual([true]);
    const rained = await rainOut({ venueId, courtIds: [court], date: day(13), fromMin: at(9), untilMin: at(11), safety: true });
    expect(rained).toMatchObject({ ok: true });
    expect(await blockSafety(day(13))).toEqual([true]);
    ok(await closeVenueDay(venueId, day(30), "Storm", { safety: true }));
    ok(await closeVenueDay(venueId, day(31), "Holiday"));
    const closures = await listVenueClosures(venueId, day(30));
    expect(closures.find((c) => c.date === day(30))).toMatchObject({ safety: true });
    expect(closures.find((c) => c.date === day(31))?.safety).toBeUndefined();
    const out = ok(await createOutage({ courtId: court, startsOn: day(40), endsOn: day(41), reason: "Algae bloom", adminId: managerId, safety: true }));
    expect(out.outage.safety).toBe(true);
    const plain = ok(await createOutage({ courtId: await make(), startsOn: day(40), endsOn: day(41), reason: "Resurfacing", adminId: managerId }));
    expect(plain.outage.safety).toBe(false);
    // Marked or not, nothing overrides the closed time: it is held by the database.
    await rule(court);
    expect(await book(court, day(12), at(12), at(13), { windowOverride: record })).toMatchObject({ ok: false });
    expect(await book(court, day(40), at(8), at(9), { windowOverride: record })).toMatchObject({ ok: false });
  });
});

describe("two managers overriding for the same time", () => {
  it("lets one booking stand: the claim decides, and the loser leaves no record and no log entry", async () => {
    const court = await make();
    await rule(court);
    const results = await Promise.all(Array.from({ length: 4 }, () => book(court, day(9), at(12), at(13), { windowOverride: record })));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const winner = results.find((r) => r.ok)!;
    const kept = await rows(court);
    expect(kept).toHaveLength(1);
    expect(kept[0].booking_id).toBe(ok(winner).booking.id);
    const code = ok(winner).booking.code;
    expect((await listActivity([venueId])).filter((a) => a.action === "booking.window_overridden" && a.bookingCode === code)).toHaveLength(1);
  });
});

describe("a weekly series and a move", () => {
  it("overrides each week outside its window, and records each", async () => {
    const court = await make();
    await rule(court);
    expect(await createBookingSeries({ courtId: court, date: day(10), start: at(12), end: at(13), weeks: 3, name: "Weekly crew", phone: phone(), by: "staff" })).toMatchObject({ ok: false, code: "LAUNCH_WINDOW" });
    const made = ok(await createBookingSeries({ courtId: court, date: day(10), start: at(12), end: at(13), weeks: 3, name: "Weekly crew", phone: phone(), by: "staff", windowOverride: record }));
    expect(made.bookings).toHaveLength(3);
    const kept = await rows(court);
    expect(kept.map((r) => r.action)).toEqual(["booked", "booked", "booked"]);
    expect(new Set(kept.map((r) => r.booking_id))).toEqual(new Set(made.bookings.map((b) => b.id)));
  });

  it("holds a week whose own window is hard: that week is skipped, or the series refused", async () => {
    const court = await make();
    await rule(court, { strength: "hard" });
    expect(await createBookingSeries({ courtId: court, date: day(10), start: at(12), end: at(13), weeks: 2, name: "Weekly crew", phone: phone(), by: "staff", windowOverride: record })).toMatchObject({ ok: false, code: "SAFE1_WINDOW_HARD" });
    expect(await rows(court)).toEqual([]);
  });

  it("moves a booking outside its window for a manager only, with the reason; a customer's move, a hard window and a preview leave nothing", async () => {
    const court = await make();
    const made = ok(await book(court, day(5), at(8), at(9)));
    await rule(court);
    const code = made.booking.code;
    expect(await rescheduleBooking(code, { date: day(5), start: at(12), courtId: court }, "staff")).toMatchObject({ ok: false, code: "LAUNCH_WINDOW", strength: "advisory" });
    // A customer is never offered it, even with the record in hand.
    expect(await rescheduleBooking(code, { date: day(5), start: at(12), courtId: court, windowOverride: record }, "customer")).toMatchObject({ ok: false, code: "LAUNCH_WINDOW" });
    // A preview shows it would go ahead, and keeps nothing.
    expect(await rescheduleBooking(code, { date: day(5), start: at(12), courtId: court, windowOverride: record, preview: true }, "staff")).toMatchObject({ ok: true, preview: true });
    expect(await rows(court)).toEqual([]);
    const moved = ok(await rescheduleBooking(code, { date: day(5), start: at(12), courtId: court, windowOverride: record }, "staff"));
    expect(moved.booking).toMatchObject({ startMin: at(12) });
    expect(await rows(court)).toEqual([expect.objectContaining({ action: "moved", refusal_code: "LAUNCH_WINDOW", reason: REASON, booking_id: made.booking.id })]);
    // A hard window refuses the move and says so.
    const hard = await make();
    const there = ok(await book(hard, day(5), at(8), at(9)));
    await rule(hard, { strength: "hard" });
    expect(await rescheduleBooking(there.booking.code, { date: day(5), start: at(12), courtId: hard, windowOverride: record }, "staff")).toMatchObject({ ok: false, code: "SAFE1_WINDOW_HARD" });
  });

  it("moves the weeks of a series with the override, week by week", async () => {
    const court = await make();
    const made = ok(await createBookingSeries({ courtId: court, date: day(10), start: at(12), end: at(13), weeks: 3, name: "Weekly crew", phone: phone(), by: "staff" }));
    await rule(court);
    const code = made.seriesCode!;
    const manager = { id: managerId, name: "Mina Manager", role: "manager" };
    // Without the override none moves (as before), with a court's override none either.
    const plain = await moveSeries(manager, code, { start: at(14), courtId: court, override: true });
    expect(plain.ok && plain.moved).toEqual([]);
    const preview = await previewSeriesMove(code, { start: at(14), courtId: court, windowOverride: record });
    expect(preview.ok && preview.weeks.every((w) => w.movable)).toBe(true);
    expect(await rows(court)).toEqual([]);
    const moved = await moveSeries(manager, code, { start: at(14), courtId: court, windowOverride: record });
    expect(moved.ok && moved.moved).toHaveLength(3);
    expect((await rows(court)).map((r) => r.action)).toEqual(["moved", "moved", "moved"]);
  });
});

describe("a class term outside the window", () => {
  it("is refused as ever, and goes ahead for a manager: each session recorded, the later weeks as LAUNCH_WEEK", async () => {
    const court = await make(4);
    await rule(court);
    const input = { courtId: court, name: "Dusk paddle", instructor: "Ali", date: day(12), start: at(16), end: at(17), capacity: 2, price: 30, weeks: 3 };
    expect(await createClassSessions(input)).toMatchObject({ ok: false, code: "LAUNCH_WINDOW", strength: "advisory" });
    const made = ok(await createClassSessions({ ...input, windowOverride: record }));
    expect(made.classes).toHaveLength(3);
    const kept = await rows(court);
    expect(kept.map((r) => [r.action, r.refusal_code])).toEqual([["class", "LAUNCH_WINDOW"], ["class", "LAUNCH_WEEK"], ["class", "LAUNCH_WEEK"]]);
    expect(kept.map((r) => r.class_id)).toEqual(made.classes.map((c) => c.id));
    expect(kept.every((r) => r.booking_id === null)).toBe(true);
  });

  it("is refused under a hard window, saying there is no override", async () => {
    const court = await make(4);
    await rule(court, { strength: "hard" });
    expect(await createClassSessions({ courtId: court, name: "Dusk paddle", instructor: "Ali", date: day(12), start: at(16), end: at(17), capacity: 2, price: 30, windowOverride: record })).toMatchObject({ ok: false, code: "SAFE1_WINDOW_HARD" });
    expect(await rows(court)).toEqual([]);
  });
});

describe("the clocks changing", () => {
  const zones = region().timeZones;
  let london: number;
  let skiff: number;
  beforeAll(async () => {
    zones.push("Europe/London");
    const made = await createVenue({ name: "Thames Window", area: "x", address: "x", phone: "0312377779", openMin: at(0), closeMin: at(24) });
    if (!made.ok) throw new Error("venue");
    london = made.venue.id;
    expect(await setVenueZone(london, "Europe/London")).toMatchObject({ ok: true });
    const court = await createCourt({ venueId: london, name: "Skiff", sport: "kayak", offPeakRate: 20, peakRate: 20 });
    if (!court.ok) throw new Error(court.error);
    skiff = court.court.id;
    expect(await updatePolicy({ venue: london }, { startEvery: 15, lengthStep: 15, minLength: 30, maxLength: 240, noticeMinutes: 0 })).toMatchObject({ ok: true });
    expect((await saveRule(london, { courtId: skiff, source: "weekly", weekly: week(at(6), at(22)) }, null)).ok).toBe(true);
  });
  afterEach(() => vi.useRealTimers());
  afterAll(() => {
    zones.splice(zones.indexOf("Europe/London"), 1);
  });

  it("is no window and no manager waives it: a booking across the change is refused whatever the override", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-20T12:00:00Z"));
    const asked = { courtId: skiff, date: "2026-03-29", start: at(0, 30), end: at(2), name: "Night paddler", phone: phone(), by: "staff" as const };
    expect(await createBooking(asked)).toMatchObject({ ok: false, code: "CLOCK_CHANGE" });
    const auth = await windowOverrideAuth({ id: managerId, name: "Mina Manager", role: "manager" }, london, REASON);
    if (!auth.ok) throw new Error("auth");
    expect(await createBooking({ ...asked, windowOverride: auth.record })).toMatchObject({ ok: false, code: "CLOCK_CHANGE" });
    expect(await createBooking({ ...asked, windowOverride: auth.record, staff: { override: true } })).toMatchObject({ ok: false, code: "CLOCK_CHANGE" });
  });
});

describe("the report and the alert", () => {
  it("lists a venue's overrides newest first, and raises a line past the venue's limit in 7 days", async () => {
    const court = await make(8);
    await rule(court);
    const before = (await windowOverridesReport(venueId, 30)).length;
    for (let i = 0; i < 3; i++) ok(await book(court, day(3), at(12), at(13), { windowOverride: record }));
    const report = await windowOverridesReport(venueId, 30);
    expect(report.length).toBe(before + 3);
    expect(report[0]).toMatchObject({ adminName: "Mina Manager", reason: REASON, code: "LAUNCH_WINDOW", action: "booked", window: "7:10 AM–10:40 AM", courtName: expect.stringContaining("Craft") });
    expect(report[0].bookingCode).toMatch(/\S/);
    expect(new Date(report[0].createdAt).getTime()).toBeGreaterThanOrEqual(new Date(report[report.length - 1].createdAt).getTime());
    // Past the limit (5 by default): an alert; a higher limit or none turns it off.
    const total = (await windowOverridesReport(venueId, 7)).length;
    ok(await saveWindowSettings(venueId, { weeklyAlert: total - 1 }, managerId));
    expect(await windowOverrideAlert(venueId)).toEqual({ venueId, count: total, limit: total - 1, days: 7 });
    ok(await saveWindowSettings(venueId, { weeklyAlert: total }, managerId));
    expect(await windowOverrideAlert(venueId)).toBeNull();
    ok(await saveWindowSettings(venueId, { weeklyAlert: 0 }, managerId));
    expect(await windowOverrideAlert(venueId)).toBeNull();
    ok(await saveWindowSettings(venueId, { weeklyAlert: null }, managerId));
  });

  it("does not show another venue's overrides", async () => {
    const other = await createVenue({ name: "Other Bay Window", area: "Penang", address: "2 Jalan Pantai", phone: "0495554444", openMin: at(6), closeMin: at(20) });
    if (!other.ok) throw new Error("venue");
    expect(await windowOverridesReport(other.venue.id, 30)).toEqual([]);
    expect(await windowOverrideAlert(other.venue.id)).toBeNull();
  });
});
