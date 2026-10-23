import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { NextRequest } from "next/server";
import {
  gridMinutes,
  lengthAllowed,
  lengthsUpTo,
  PLATFORM_POLICY,
  policyBreaches,
  policyFor,
  resolvePolicy,
  startAllowed,
  startsWithin,
  updatePolicy,
  validateSettings,
  type BookingPolicy,
} from "../src/lib/booking-policy";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { getDb } from "../src/lib/db";
import { createCourt, createVenue, getCourt } from "../src/lib/store";
import { GET, POST } from "../src/app/api/admin/booking-policies/route";

/**
 * Booking policies (ADR 0010): what may be booked on a court — when it may
 * start, how long it may run, what is kept free around it, how soon it may be
 * made, and how its time is priced — set at whatever level an operator
 * wants, everything left unset inherited: a court from its sport at the
 * venue, that from the venue, the venue from its business, and the business
 * from the platform's defaults for the sport.
 */

const base = resolvePolicy([], null);
const policy = (settings: Parameters<typeof resolvePolicy>[0][number]): BookingPolicy => resolvePolicy([settings], null);

describe("the rules themselves", () => {
  it("default to the hour: on the hour, an hour to four, no buffers, priced to the minute", () => {
    expect(base).toMatchObject({ startEvery: 60, startOffset: 0, lengthStep: 60, minLength: 60, maxLength: 240, defaultLength: 60, bufferBefore: 0, bufferAfter: 0 });
    expect(base.pricing).toMatchObject({ rateMode: "split", fixedPrices: null, setupFee: 0, cleanupFee: 0 });
    // Padel's game is 90 minutes, from any half hour.
    expect(resolvePolicy([], "padel")).toMatchObject({ startEvery: 30, lengthStep: 30, defaultLength: 90 });
  });

  it("start every so often from an offset, or only at set times", () => {
    const quarter = policy({ startEvery: 15, startOffset: 5 });
    expect([startAllowed(quarter, 605), startAllowed(quarter, 620), startAllowed(quarter, 610)]).toEqual([true, true, false]);
    expect(startsWithin(quarter, 600, 650)).toEqual([605, 620, 635]);
    const set = policy({ startTimes: [1080, 1170, 1260] });
    expect([startAllowed(set, 1170), startAllowed(set, 1140)]).toEqual([true, false]);
    // Any minute at all.
    const any = policy({ startEvery: 1 });
    expect(startAllowed(any, 18 * 60 + 7)).toBe(true);
  });

  it("run in steps between a shortest and a longest, or only set lengths", () => {
    const padel = policy({ lengthStep: 15, minLength: 60, maxLength: 120 });
    expect([lengthAllowed(padel, 75), lengthAllowed(padel, 70), lengthAllowed(padel, 135)]).toEqual([true, false, false]);
    expect(lengthsUpTo(padel, 100)).toEqual([60, 75, 90]);
    const set = policy({ lengths: [60, 90, 120] });
    expect([lengthAllowed(set, 90), lengthAllowed(set, 75)]).toEqual([true, false]);
    expect(lengthsUpTo(set)).toEqual([60, 90, 120]);
  });

  it("draw the board in columns of a sensible width, whatever the starts", () => {
    expect(gridMinutes(base)).toBe(60);
    expect(gridMinutes(policy({ startEvery: 30 }))).toBe(30);
    expect(gridMinutes(policy({ startEvery: 5 }))).toBe(15);
    expect(gridMinutes(policy({ startEvery: 90 }))).toBe(30);
    expect(gridMinutes(policy({ startTimes: [18 * 60 + 7] }))).toBe(15);
  });

  it("say which of them a request breaks", () => {
    const p = policy({ noticeMinutes: 120 });
    const hours = { openMin: 480, closeMin: 1380, closed: false };
    expect(policyBreaches(p, { start: 600, end: 660 }, hours, 500)).toEqual([]);
    expect(policyBreaches(p, { start: 610, end: 655 }, hours, 500)).toEqual(["START", "LENGTH"]);
    expect(policyBreaches(p, { start: 1320, end: 1440 }, hours, 60)).toEqual(["HOURS", "NOTICE"]);
  });

  it("are checked as they are set", () => {
    expect(validateSettings({ startEvery: 0 })).toMatchObject({ ok: false });
    expect(validateSettings({ minLength: 7.5 })).toMatchObject({ ok: false });
    expect(validateSettings({ minLength: 120, maxLength: 60 })).toMatchObject({ ok: false });
    expect(validateSettings({ bufferAfter: 300 })).toMatchObject({ ok: false });
    expect(validateSettings({ fixedPrices: [{ minutes: 90, price: 120 }, { minutes: 90, price: 100 }] })).toMatchObject({ ok: false });
    expect(validateSettings({ setupFee: 5.555 })).toMatchObject({ ok: false });
    expect(validateSettings({ startTimes: [1080, 1080, 990] })).toEqual({ ok: true, settings: { startTimes: [990, 1080] } });
    expect(PLATFORM_POLICY.startEvery).toBe(60);
  });
});

describe("levels, inherited", () => {
  let business: number;
  let venueId: number;
  let badminton: number;
  let padel: number;

  beforeAll(async () => {
    business = ((await getDb().prepare("INSERT INTO businesses (name) VALUES ('Club Group') RETURNING id").get()) as { id: number }).id;
    const made = await createVenue({ name: "Policy Hall", area: "PJ", address: "x", phone: "0312340099" });
    if (!made.ok) throw new Error("venue");
    venueId = made.venue.id;
    await getDb().prepare("UPDATE venues SET business_id = ? WHERE id = ?").run(business, venueId);
    const court = async (name: string, sport: "badminton" | "padel") => {
      const c = await createCourt({ venueId, name, sport, offPeakRate: 20, peakRate: 30 });
      if (!c.ok) throw new Error(c.error);
      return c.court.id;
    };
    badminton = await court("Court 1", "badminton");
    padel = await court("Padel 1", "padel");
  });

  const of = async (id: number) => policyFor((await getCourt(id))!);

  it("take the most specific setting there is, field by field", async () => {
    expect(await updatePolicy({ business }, { noticeMinutes: 30, bufferAfter: 10 })).toMatchObject({ ok: true });
    expect(await updatePolicy({ venue: venueId }, { noticeMinutes: 60 })).toMatchObject({ ok: true });
    expect(await updatePolicy({ venue: venueId, sport: "padel" }, { defaultLength: 60 })).toMatchObject({ ok: true });
    expect(await updatePolicy({ court: badminton }, { startEvery: 15, lengthStep: 15, minLength: 45 })).toMatchObject({ ok: true });

    // The badminton court: its own starts and lengths, the venue's notice, the business's buffer.
    expect(await of(badminton)).toMatchObject({ startEvery: 15, lengthStep: 15, minLength: 45, maxLength: 240, noticeMinutes: 60, bufferAfter: 10 });
    // Padel: the platform's half hours for padel, the venue's padel length, the venue's notice.
    expect(await of(padel)).toMatchObject({ startEvery: 30, lengthStep: 30, defaultLength: 60, noticeMinutes: 60, bufferAfter: 10 });
  });

  it("go back to inheriting when a setting is cleared", async () => {
    expect(await updatePolicy({ venue: venueId }, { noticeMinutes: null })).toMatchObject({ ok: true });
    expect((await of(badminton)).noticeMinutes).toBe(30);
    // Clearing everything a level holds removes it.
    expect(await updatePolicy({ court: badminton }, { startEvery: null, lengthStep: null, minLength: null })).toMatchObject({ ok: true, settings: {} });
    expect((await of(badminton)).startEvery).toBe(60);
    const left = (await getDb().prepare("SELECT COUNT(*)::int AS n FROM booking_policies WHERE court_id = ?").get(badminton)) as { n: number };
    expect(left.n).toBe(0);
  });

  it("are set by the venue's managers, through their route, and recorded", async () => {
    const manager = await createAdmin({ name: "Mgr", email: "mgr@policy.my", password: "a long enough password", venueId });
    const desk = await createAdmin({ name: "Desk", email: "desk@policy.my", password: "a long enough password", venueId, role: "desk" });
    if (!manager.ok || !desk.ok) throw new Error("admins");
    const cookie = async (id: number) => `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(id)).token}`;
    const req = async (id: number, body: unknown) =>
      new NextRequest("http://localhost/api/admin/booking-policies", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: await cookie(id) },
        body: JSON.stringify(body),
      });
    const set = await POST(await req(manager.admin.id, { venueId, level: "court", courtId: padel, settings: { lengths: [60, 90, 120], bufferBefore: 5 } }));
    expect(set.status).toBe(200);
    expect((await of(padel)).lengths).toEqual([60, 90, 120]);
    // The front desk may not; a branch manager may not set the whole business's.
    expect((await POST(await req(desk.admin.id, { venueId, level: "venue", settings: { noticeMinutes: 5 } }))).status).toBe(403);
    expect((await POST(await req(manager.admin.id, { venueId, level: "business", settings: { noticeMinutes: 5 } }))).status).toBe(403);
    const log = (await getDb().prepare("SELECT action, detail FROM staff_actions WHERE admin_id = ?").all(manager.admin.id)) as { action: string; detail: string }[];
    expect(log.some((l) => l.action === "settings.changed" && l.detail.includes("Padel 1"))).toBe(true);

    const read = await GET(
      new NextRequest(`http://localhost/api/admin/booking-policies?venueId=${venueId}`, { headers: { cookie: await cookie(manager.admin.id) } })
    );
    const body = await read.json();
    expect(body.levels.courts[padel]).toMatchObject({ lengths: [60, 90, 120], bufferBefore: 5 });
    expect(body.effective.courts[padel].summary).toContain("kept free 5 minutes before");
  });
});
