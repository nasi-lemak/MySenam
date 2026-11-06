import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { listActivity } from "../src/lib/activity";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { createBooking, createClassSessions, createCourt, enrolInClass, listVenues } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import * as closures from "../src/app/api/admin/venues/[id]/closures/route";
import * as classRoute from "../src/app/api/admin/classes/[id]/route";
import * as classes from "../src/app/api/admin/classes/route";
import * as blocks from "../src/app/api/admin/blocks/route";
import * as hire from "../src/app/api/admin/hire/route";
import * as addons from "../src/app/api/admin/addons/route";
import * as notices from "../src/app/api/admin/notices/route";
import * as inductions from "../src/app/api/admin/inductions/route";
import * as tournaments from "../src/app/api/admin/tournaments/route";

/**
 * The staff writes the activity log missed (X1-4), now in it with who did
 * them: closing a day and cancelling a class (one entry with counts, and a
 * `booking.cancelled` under each booking's code, as the single cancellation
 * writes), scheduling classes, blocks, kit handed out and money kept from a
 * deposit, extras, notices, inductions and new tournaments. That every write
 * route logs is read from the source in tests/staff-log-coverage.test.ts.
 */

type Handler = (req: NextRequest, ctx?: unknown) => Promise<Response>;

let venueId: number;
let managerCookie: string;
let deskCookie: string;
let seq = 0;

beforeAll(async () => {
  venueId = (await listVenues())[0].id;
  const manager = await createAdmin({ name: "Maya Manager", email: "maya-log@venue.my", password: "manager-pass-1", venueId });
  const desk = await createAdmin({ name: "Dina Desk", email: "dina-log@venue.my", password: "desk-password-1", venueId, role: "desk" });
  if (!manager.ok || !desk.ok) throw new Error("staff");
  managerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(manager.admin.id)).token}`;
  deskCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.admin.id)).token}`;
});

afterEach(() => vi.useRealTimers());

const call = (handler: Handler, url: string, method: string, body: unknown, cookie = managerCookie, params: Record<string, string> = {}) =>
  handler(
    new NextRequest(`http://localhost${url}`, { method, headers: { cookie, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    { params: Promise.resolve(params) }
  );

async function studio(capacity = 10, deposit?: number, sport = "gym") {
  seq++;
  const made = await createCourt({ venueId, name: `Log Room ${seq}`, sport, offPeakRate: 10, peakRate: 12, capacity, ...(deposit ? { deposit } : {}) });
  if (!made.ok) throw new Error(made.error);
  return made.court;
}

async function classWithTwo(date: string) {
  const court = await studio();
  const made = await createClassSessions({ courtId: court.id, name: `Zumba ${seq}`, instructor: "Lina", date, startHour: 9, endHour: 10, capacity: 5, price: 15 });
  if (!made.ok) throw new Error(made.error);
  const session = made.classes[0];
  const enrolments = [];
  for (const i of [1, 2]) {
    const e = await enrolInClass({ classId: session.id, name: `Dancer ${seq}-${i}`, phone: `01622${seq}000${i}` });
    if (!e.ok) throw new Error(e.error);
    enrolments.push(e.booking);
  }
  return { session, enrolments };
}

const logFor = async (code: string) => (await listActivity([venueId], { bookingCode: code })).map((a) => [a.action, a.adminName]);

describe("the activity log", () => {
  it("has closing a day: the closure with its counts, each class, and every booking and enrolment under its own code", async () => {
    const date = addDays(todayISO(), 8);
    const court = (await listVenues())[0].courts.find((c) => c.capacity === 1)!;
    const booking = await createBooking({ courtId: court.id, date, hours: [11], name: "Closed Out", phone: "0162220001" });
    if (!booking.ok) throw new Error(booking.error);
    const { session, enrolments } = await classWithTwo(date);

    const res = await call(closures.POST as Handler, `/api/admin/venues/${venueId}/closures`, "POST", { date, reason: "Flooding", cancelAffected: true }, managerCookie, { id: String(venueId) });
    expect(res.status).toBe(201);
    const log = await listActivity([venueId]);
    const closed = log.find((a) => a.action === "day.closed")!;
    expect(closed).toMatchObject({ adminName: "Maya Manager" });
    expect(closed.detail).toBe(`${date} (Flooding): 1 booking(s) and 1 class(es) with 2 enrolment(s) cancelled`);
    expect(log.find((a) => a.action === "class.cancelled")?.detail).toContain(`${session.name}, ${date} 9:00 AM: 2 enrolment(s) cancelled`);
    // "Who cancelled my booking?" by its code, for each customer of the day.
    for (const code of [booking.booking.code, ...enrolments.map((e) => e.code)]) expect(await logFor(code)).toEqual([["booking.cancelled", "Maya Manager"]]);
    expect((await listActivity([venueId], { bookingCode: booking.booking.code }))[0].detail).toContain(`the venue closed for ${date} (Flooding)`);

    const reopened = await call(closures.DELETE as Handler, `/api/admin/venues/${venueId}/closures?date=${date}`, "DELETE", undefined, managerCookie, { id: String(venueId) });
    expect(reopened.status).toBe(200);
    expect((await listActivity([venueId])).find((a) => a.action === "day.reopened")?.detail).toBe(date);
  });

  it("has cancelling a class, with each enrolment it released", async () => {
    const { session, enrolments } = await classWithTwo(addDays(todayISO(), 9));
    const res = await call(classRoute.DELETE as Handler, `/api/admin/classes/${session.id}`, "DELETE", undefined, managerCookie, { id: String(session.id) });
    expect((await res.json()).released).toBe(2);
    for (const e of enrolments) expect(await logFor(e.code)).toEqual([["booking.cancelled", "Maya Manager"]]);
    expect((await listActivity([venueId], { bookingCode: enrolments[0].code }))[0].detail).toContain(`class ${session.name} cancelled`);
  });

  it("has scheduling a class, blocking and unblocking a court", async () => {
    const court = await studio();
    const date = addDays(todayISO(), 10);
    const made = await call(classes.POST as Handler, "/api/admin/classes", "POST", { courtId: court.id, name: "Morning Stretch", instructor: "Ivy", date, start: "08:00", end: "09:00", capacity: 6, price: 12, weeks: 2 });
    expect(made.status, JSON.stringify(await made.clone().json())).toBe(201);
    expect((await listActivity([venueId])).find((a) => a.action === "class.scheduled")?.detail).toMatch(/^Morning Stretch with Ivy, Log Room \d+, .* 8:00 AM–9:00 AM, 6 places at RM ?12(\.00)?, weekly for 2 weeks \(CL-/);

    const blocked = await call(blocks.POST as Handler, "/api/admin/blocks", "POST", { courtId: court.id, date, start: "12:00", end: "13:00", reason: "Deep clean" }, deskCookie);
    expect(blocked.status).toBe(200);
    const unblocked = await call(blocks.DELETE as Handler, "/api/admin/blocks", "DELETE", { courtId: court.id, date, start: "12:00", end: "13:00" }, deskCookie);
    expect(unblocked.status).toBe(200);
    const log = await listActivity([venueId]);
    expect(log.find((a) => a.action === "block.added")).toMatchObject({ adminName: "Dina Desk", detail: `${court.name}, ${date} 12:00 PM–1:00 PM: Deep clean` });
    expect(log.find((a) => a.action === "block.removed")).toMatchObject({ adminName: "Dina Desk" });
  });

  it("has kit handed out and the money the desk kept from its deposit, by whom", async () => {
    const fleet = await studio(4, 50, "kayak");
    const date = todayISO();
    vi.useFakeTimers();
    vi.setSystemTime(new Date(`${date}T11:30:00+08:00`));
    const booking = await createBooking({ courtId: fleet.id, date, hours: [12], name: "Paddler Log", phone: "0162220099" });
    vi.setSystemTime(new Date(`${date}T12:15:00+08:00`));
    if (!booking.ok) throw new Error(booking.error);
    const out = await call(hire.POST as Handler, "/api/admin/hire", "POST", { code: booking.booking.code, action: "take", via: "cash" }, deskCookie);
    expect(out.status, JSON.stringify(await out.clone().json())).toBe(200);
    const back = await call(hire.POST as Handler, "/api/admin/hire", "POST", { code: booking.booking.code, action: "return", condition: "damaged", withheld: 20, note: "Cracked paddle", via: "cash" }, deskCookie);
    expect(back.status, JSON.stringify(await back.clone().json())).toBe(200);
    const log = await listActivity([venueId], { bookingCode: booking.booking.code });
    expect(log.map((a) => [a.action, a.adminName])).toEqual([
      ["hire.returned", "Dina Desk"],
      ["hire.taken", "Dina Desk"],
    ]);
    expect(log[0].detail).toMatch(/20(\.00)? of RM ?50(\.00)? kept \(cash\): Cracked paddle$/);
  });

  it("has extras, notices, inductions and new tournaments", async () => {
    expect((await call(addons.POST as Handler, "/api/admin/addons", "POST", { venueId, name: "Racket hire", kind: "rental", price: 5, stock: 10 })).status).toBe(201);
    const on = addDays(todayISO(), 11);
    expect((await call(notices.POST as Handler, "/api/admin/notices", "POST", { venueId, text: "Car park closed this week", startsOn: todayISO(), endsOn: on })).status).toBe(201);
    expect((await call(inductions.POST as Handler, "/api/admin/inductions", "POST", { venueId, phone: "0162220123", name: "Night Owl" }, deskCookie)).status).toBe(201);
    const courts = (await listVenues())[0].courts.filter((c) => c.sport === "badminton").slice(0, 1).map((c) => c.id);
    const t = await call(tournaments.POST as Handler, "/api/admin/tournaments", "POST", {
      venueId, name: "Logged Open", sport: "badminton", format: "knockout", teamSize: 1, entryFee: 10, maxEntries: 8, startsOn: on, endsOn: on, startHour: 9, endHour: 12, courtIds: courts,
    });
    expect(t.status, JSON.stringify(await t.clone().json())).toBe(201);
    const log = await listActivity([venueId]);
    expect(log.find((a) => a.action === "addon.created")?.detail).toMatch(/^Racket hire \(rental\), RM ?5(\.00)?, 10 in stock$/);
    expect(log.find((a) => a.action === "notice.posted")?.detail).toContain("Car park closed this week");
    expect(log.find((a) => a.action === "induction.recorded")).toMatchObject({ adminName: "Dina Desk", detail: "Night Owl shown round" });
    expect(log.find((a) => a.action === "tournament.created")?.detail).toMatch(/^Logged Open: .*up to 8 entries, fee RM ?10/);
  });
});
