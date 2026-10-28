import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { addAccess, setAccessSettings } from "../src/lib/access";
import { listActivity } from "../src/lib/activity";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { createApiKey } from "../src/lib/api-keys";
import { setCancelPolicy } from "../src/lib/cancel-policy";
import { getDb } from "../src/lib/db";
import { setHouseRules } from "../src/lib/house-rules";
import { translator } from "../src/lib/i18n";
import { blockPhone, GUEST_SURGE_PER_HOUR, policyCheck } from "../src/lib/limits";
import { OVERRIDABLE, venueOverrides } from "../src/lib/policy-overrides";
import { createResources } from "../src/lib/resources";
import { staffTranslator } from "../src/lib/staff-i18n";
import {
  cancelBooking,
  claimWaitlistOffer,
  createBookingSeries,
  createClassSessions,
  createVenue,
  enrolPeople,
  listBookingsForDate,
  sellMembership,
  voidMembership,
} from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { setWaiver, waiverSigned } from "../src/lib/waivers";
import * as adminWaitlist from "../src/app/api/admin/waitlist/route";
import * as apiBookings from "../src/app/api/v1/bookings/route";
import * as apiWaitlist from "../src/app/api/v1/waitlist/route";
import * as blockedRoute from "../src/app/api/admin/venues/[id]/blocked-phones/route";
import * as bookingsRoute from "../src/app/api/bookings/route";
import * as claimRoute from "../src/app/api/waitlist/claim/route";
import * as enrolRoute from "../src/app/api/classes/enrol/route";
import * as overridesRoute from "../src/app/api/admin/policy-overrides/route";
import * as waitlistRoute from "../src/app/api/waitlist/route";

/**
 * Rule 9 as the owner decided it on 28 October 2026 (ADR 0026;
 * docs/features/booking.md#the-same-policies-on-every-path): customer,
 * counter and API bookings are held to the same venue policies by default
 * (lib/limits.ts `policyCheck`), each refusal said for its path; the counter
 * takes payment as it books where online would hold the booking until paid;
 * a manager, and only a manager, may override the policies the venue lets
 * them for one booking, with a reason, kept with the booking in its
 * transaction and in the activity log; front desk and API keys never; a
 * refused number, the unpaid-bookings limit, eligibility, the waiver,
 * capacity and the booking window never. Waiting lists ask what the booking
 * would: the waiver at the claim, the members' window again at the claim, and
 * a class's queue what enrolling asks.
 */

const ZONE = "Asia/Kuala_Lumpur";
const day = (k: number) => addDays(todayISO(ZONE), k);
const at = (h: number) => h * 60;
let n = 0;
const phone = () => `0177${String(++n).padStart(6, "0")}`;

type Staff = { id: number; name: string; cookie: string };

let plain: number; // a public venue: house rules (a booking a day), strikes after one
let plainHall: number;
let plainHall2: number;
let plainStudio: number;
let surge: number; // flooded with unpaid guest bookings
let surgeHall: number;
let club: number; // members only
let clubHall: number;
let condo: number; // private
let condoHall: number;
let waivered: number; // asks a waiver
let waiveredHall: number;
let early: number; // members book further ahead
let earlyHall: number;
let manager: Staff;
let desk: Staff;
let surgeManager: Staff;
let clubManager: Staff;
let condoDesk: Staff;
let waiverManager: Staff;
let earlyManager: Staff;
let plainKey: string;
let surgeKey: string;
let clubKey: string;
let condoKey: string;
let waiverKey: string;

async function staffMember(venueId: number, name: string, role: "manager" | "desk" = "manager"): Promise<Staff> {
  const made = await createAdmin({ name, email: `${name.toLowerCase().replace(/\W/g, "")}${++n}@r9.test`, password: "a long enough password", venueId, role });
  if (!made.ok) throw new Error(made.error);
  return { id: made.admin.id, name, cookie: `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(made.admin.id)).token}` };
}

const req = (url: string, method: string, cookie: string | null, body?: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(url, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": `10.79.${++n % 250}.${n % 200}`, ...(cookie ? { cookie } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

type Answer = { status: number; body: Record<string, unknown> & { code?: string; booking?: { id: number; code: string; paymentStatus: string; paidVia?: string | null; holdUntil?: string | null } } };
/** The booking form (no staff session), or the counter (a staff session: the same route). */
const form = async (cookie: string | null, body: Record<string, unknown>): Promise<Answer> => {
  const res = await bookingsRoute.POST(req("http://localhost/api/bookings", "POST", cookie, body));
  return { status: res.status, body: await res.json() };
};
const api = async (writeKey: string, body: Record<string, unknown>): Promise<Answer> => {
  const res = await apiBookings.POST(req("http://localhost/api/v1/bookings", "POST", null, body, { authorization: `Bearer ${writeKey}` }));
  return { status: res.status, body: await res.json() };
};
const enrol = async (cookie: string | null, body: Record<string, unknown>): Promise<Answer> => {
  const res = await enrolRoute.POST(req("http://localhost/api/classes/enrol", "POST", cookie, body));
  return { status: res.status, body: await res.json() };
};
const permit = async (staff: Staff, venueId: number, policies: string[]) => {
  const res = await overridesRoute.POST(req("http://localhost/api/admin/policy-overrides", "POST", staff.cookie, { venueId, policies }));
  return { status: res.status, body: (await res.json()) as { policies?: string[]; code?: string } };
};
const slot = (courtId: number, date: string, h: number, extra: Record<string, unknown> = {}) => ({
  courtId,
  date,
  start: at(h),
  end: at(h + 1),
  name: "Test Customer",
  ...extra,
});
const booked = async (courtId: number, date: string, h: number, ph: string) => {
  const made = await createBookingSeries({ courtId, date, start: at(h), end: at(h + 1), weeks: 1, name: "Already", phone: ph, by: "staff" });
  if (!made.ok) throw new Error(made.error);
  return made.bookings[0];
};
// Each no-show on a time of its own, a day past the others' bookings.
let missedSlot = 0;
const noShow = async (venueHall: number, ph: string) => {
  missedSlot++;
  const missed = await booked(venueHall, day(30 + Math.floor(missedSlot / 14)), 7 + (missedSlot % 14), ph);
  await getDb().prepare("UPDATE bookings SET no_show = 1 WHERE id = ?").run(missed.id);
};
const overridesOf = async (bookingCode: string) =>
  (await getDb()
    .prepare(
      `SELECT o.venue_id, o.policy, o.refusal_code, o.reason, o.admin_id, o.admin_name FROM booking_policy_overrides o JOIN bookings b ON b.id = o.booking_id WHERE b.code = ? ORDER BY o.id`
    )
    .all(bookingCode)) as { venue_id: number; policy: string; refusal_code: string; reason: string; admin_id: number; admin_name: string }[];
const allOverrides = async () => ((await getDb().prepare("SELECT COUNT(*)::int AS n FROM booking_policy_overrides").get()) as { n: number }).n;

beforeAll(async () => {
  const make = async (name: string, ph: string) => {
    const v = await createVenue({ name, area: "Ampang", address: "x", phone: ph, openMin: at(7), closeMin: at(23) });
    if (!v.ok) throw new Error("venue");
    expect((await setHouseRules(v.venue.id, { aheadDays: 45 })).ok).toBe(true);
    return v.venue.id;
  };
  const resource = async (venueId: number, sport: string, name: string, capacity = 1) => {
    const r = await createResources({ venueId, sport, name, offPeakRate: 20, peakRate: 20, capacity, ...(capacity > 1 ? { maxPlayers: capacity } : {}) });
    if (!r.ok) throw new Error(r.error);
    return r.courts[0].id;
  };
  plain = await make("Plain Courts", "0312979001");
  surge = await make("Surge Courts", "0312979002");
  club = await make("Members Club", "0312979003");
  condo = await make("Condo Courts", "0312979004");
  waivered = await make("Waiver Walls", "0312979005");
  early = await make("Early Courts", "0312979006");
  plainHall = await resource(plain, "badminton", "Court 1");
  plainHall2 = await resource(plain, "badminton", "Court 2");
  plainStudio = await resource(plain, "gym", "Studio", 6);
  surgeHall = await resource(surge, "badminton", "Court 1");
  clubHall = await resource(club, "tennis", "Court 1");
  condoHall = await resource(condo, "tennis", "Court 1");
  waiveredHall = await resource(waivered, "squash", "Glass court", 1);
  earlyHall = await resource(early, "badminton", "Court 1");
  expect((await setHouseRules(plain, { aheadDays: 45, perDay: 1 })).ok).toBe(true);
  expect((await setCancelPolicy(plain, { strikeLimit: 1 })).ok).toBe(true);
  expect((await setCancelPolicy(surge, { strikeLimit: 1 })).ok).toBe(true);
  expect((await setAccessSettings(club, { access: "members" })).ok).toBe(true);
  expect((await setAccessSettings(condo, { access: "private" })).ok).toBe(true);
  expect((await setWaiver(waivered, "I climb at my own risk and follow the wall staff's instructions at all times.")).ok).toBe(true);
  expect((await setHouseRules(early, { aheadDays: 7, memberAheadDays: 21 })).ok).toBe(true);
  manager = await staffMember(plain, "Mira Manager");
  desk = await staffMember(plain, "Dina Desk", "desk");
  surgeManager = await staffMember(surge, "Sam Manager");
  clubManager = await staffMember(club, "Cara Manager");
  condoDesk = await staffMember(condo, "Cody Desk", "desk");
  waiverManager = await staffMember(waivered, "Wan Manager");
  earlyManager = await staffMember(early, "Eli Manager");
  const keyFor = async (venueId: number, by: number) => {
    const made = await createApiKey(venueId, { name: "Venue system", scope: "write" }, by);
    if (!made.ok) throw new Error("key");
    return made.key;
  };
  plainKey = await keyFor(plain, manager.id);
  surgeKey = await keyFor(surge, surgeManager.id);
  clubKey = await keyFor(club, clubManager.id);
  condoKey = await keyFor(condo, clubManager.id);
  waiverKey = await keyFor(waivered, waiverManager.id);
  // A flood of unpaid bookings without an account at the surge venue, in the last hour.
  for (let i = 0; i < GUEST_SURGE_PER_HOUR; i++) {
    const made = await createBookingSeries({
      courtId: surgeHall,
      date: day(1 + Math.floor(i / 14)),
      start: at(8 + (i % 14)),
      end: at(9 + (i % 14)),
      weeks: 1,
      name: `Guest ${i}`,
      phone: `0199${String(i).padStart(6, "0")}`,
    });
    if (!made.ok) throw new Error(made.error);
  }
});

describe("every path is held to the same policies", () => {
  it("the house rules: refused online, at the counter and through the API, each said for its path", async () => {
    const ph = phone();
    await booked(plainHall2, day(3), 9, ph);
    const online = await form(null, slot(plainHall, day(3), 12, { phone: ph }));
    const counter = await form(manager.cookie, slot(plainHall, day(3), 12, { phone: ph }));
    const viaApi = await api(plainKey, slot(plainHall, day(3), 12, { phone: ph }));
    expect([online.status, counter.status, viaApi.status]).toEqual([409, 409, 409]);
    expect(online.body.code).toBe("LIMIT_DAY");
    expect(counter.body).toMatchObject({ code: "R9_DESK_LIMIT_DAY", policy: "house_rules", overridable: false, askManager: false });
    expect(viaApi.body.code).toBe("LIMIT_DAY");
    // Staff are told in their language what they can do about it.
    expect(staffTranslator("ms").err(counter.body as { error: string; code: string; vars: Record<string, number> })).toMatch(/^Peraturan pusat membenarkan 1 tempahan sehari/);
  });

  it("no-show strikes: online refused where nothing is taken online, at the counter paid as it is booked, through the API refused", async () => {
    const ph = phone();
    await noShow(plainHall2, ph);
    const online = await form(null, slot(plainHall, day(4), 10, { phone: ph }));
    expect(online.body.code).toBe("STRIKES_COUNTER");
    const viaApi = await api(plainKey, slot(plainHall, day(4), 10, { phone: ph }));
    expect(viaApi.status).toBe(409);
    expect(viaApi.body.code).toBe("STRIKES_COUNTER");
    expect(viaApi.body.error).toMatch(/counter/);
    const counter = await form(desk.cookie, slot(plainHall, day(4), 10, { phone: ph }));
    expect(counter.body).toMatchObject({ code: "R9_DESK_STRIKES", payNow: true, policy: "strikes" });
    // The counter's "pay to hold": paid then and there, by the method staff say; never held.
    const paid = await form(desk.cookie, slot(plainHall, day(4), 10, { phone: ph, paidAtCounter: "cash" }));
    expect(paid.status).toBe(201);
    expect(paid.body.booking).toMatchObject({ paymentStatus: "paid", paidVia: "cash" });
    expect(paid.body.holdUntil ?? null).toBeNull();
    const log = await listActivity([plain], { bookingCode: paid.body.booking!.code });
    expect(log.some((e) => e.action === "payment.paid" && e.adminName === "Dina Desk")).toBe(true);
    // Paying at the counter is the counter's: a customer saying so is refused.
    expect((await form(null, slot(plainHall, day(5), 10, { phone: phone(), paidAtCounter: "cash" }))).body.code).toBe("R9_PAY_NOW_STAFF");
  });

  it("the guest limit: refused online without online payment, at the counter unless paid now, through the API", async () => {
    const ph = phone();
    expect((await form(null, slot(surgeHall, day(6), 12, { phone: ph }))).body.code).toBe("GUEST_SURGE");
    expect((await form(surgeManager.cookie, slot(surgeHall, day(6), 12, { phone: ph }))).body).toMatchObject({ code: "R9_DESK_GUEST_SURGE", payNow: true });
    expect((await api(surgeKey, slot(surgeHall, day(6), 12, { phone: ph }))).body.code).toBe("GUEST_SURGE");
    expect((await form(surgeManager.cookie, slot(surgeHall, day(6), 12, { phone: ph, paidAtCounter: "qr" }))).status).toBe(201);
  });

  it("a refused number and the unpaid-bookings limit, on every path", async () => {
    const refused = phone();
    await blockPhone({ venueId: plain, phone: refused, reason: "Abusive", adminId: manager.id });
    expect((await form(null, slot(plainHall, day(7), 9, { phone: refused }))).body.code).toBe("PHONE_BLOCKED");
    expect((await form(manager.cookie, slot(plainHall, day(7), 9, { phone: refused }))).body.code).toBe("R9_DESK_PHONE_BLOCKED");
    expect((await api(plainKey, slot(plainHall, day(7), 9, { phone: refused }))).body.code).toBe("PHONE_BLOCKED");
    const owing = phone();
    for (const k of [8, 9, 10]) await booked(plainHall2, day(k), 9, owing);
    expect((await form(null, slot(plainHall, day(11), 9, { phone: owing }))).body.code).toBe("PHONE_LIMIT_VENUE");
    const atCounter = await form(manager.cookie, slot(plainHall, day(11), 9, { phone: owing }));
    expect(atCounter.body.code).toBe("R9_DESK_UNPAID_VENUE");
    expect(atCounter.body.policy).toBeUndefined();
    expect((await api(plainKey, slot(plainHall, day(11), 9, { phone: owing }))).body.code).toBe("PHONE_LIMIT_VENUE");
    // Not even paid as it is booked: resolving the debt is the way.
    expect((await form(manager.cookie, slot(plainHall, day(11), 9, { phone: owing, paidAtCounter: "cash" }))).body.code).toBe("R9_DESK_UNPAID_VENUE");
  });

  it("a members-only venue: at the counter and through the API the number booked must be a member, never staff signed in as one (B20)", async () => {
    const stranger = phone();
    expect((await form(null, slot(clubHall, day(3), 9, { phone: stranger }))).body.code).toBe("MEMBERS_SIGN_IN");
    expect((await form(clubManager.cookie, slot(clubHall, day(3), 9, { phone: stranger }))).body.code).toBe("R9_DESK_NOT_MEMBER");
    expect((await api(clubKey, slot(clubHall, day(3), 9, { phone: stranger }))).body.code).toBe("R9_NOT_MEMBER");
    const member = phone();
    const sold = await sellMembership({ venueId: club, holderName: "Mei Member", holderPhone: member, startsOn: todayISO(ZONE), expiresOn: day(60), price: 100, adminId: clubManager.id });
    expect(sold.ok).toBe(true);
    expect((await form(clubManager.cookie, slot(clubHall, day(3), 9, { phone: member }))).status).toBe(201);
    expect((await api(clubKey, slot(clubHall, day(3), 11, { phone: member }))).status).toBe(201);
    // A member's membership ending before the date booked does not let it through.
    const lapsing = phone();
    expect((await sellMembership({ venueId: club, holderName: "Lapsing", holderPhone: lapsing, startsOn: todayISO(ZONE), expiresOn: day(2), price: 100, adminId: clubManager.id })).ok).toBe(true);
    expect((await form(clubManager.cookie, slot(clubHall, day(5), 9, { phone: lapsing }))).body.code).toBe("R9_DESK_NOT_MEMBER");
  });

  it("a private venue: the number on its list, at the counter and through the API", async () => {
    const outsider = phone();
    expect((await form(condoDesk.cookie, slot(condoHall, day(3), 9, { phone: outsider }))).body.code).toBe("R9_DESK_NOT_LISTED");
    expect((await api(condoKey, slot(condoHall, day(3), 9, { phone: outsider }))).body.code).toBe("R9_NOT_LISTED");
    const resident = phone();
    expect((await addAccess(condo, [{ phone: resident, name: "Rina", label: "A-1-1" }], null)).ok).toBe(true);
    expect((await form(condoDesk.cookie, slot(condoHall, day(3), 9, { phone: resident }))).status).toBe(201);
  });

  it("the waiver: ticked online or at the counter; through the API, already on record", async () => {
    const ph = phone();
    expect((await form(null, slot(waiveredHall, day(3), 9, { phone: ph }))).body.code).toBe("WAIVER_NEEDED");
    expect((await form(waiverManager.cookie, slot(waiveredHall, day(3), 9, { phone: ph }))).body.code).toBe("WAIVER_NEEDED");
    expect((await api(waiverKey, slot(waiveredHall, day(3), 9, { phone: ph }))).body.code).toBe("WAIVER_NEEDED");
    expect((await form(waiverManager.cookie, slot(waiveredHall, day(3), 9, { phone: ph, agreeWaiver: true }))).status).toBe(201);
    expect(await waiverSigned(waivered, ph)).toBe(true);
    expect((await api(waiverKey, slot(waiveredHall, day(3), 11, { phone: ph }))).status).toBe(201);
  });

  it("a weekly booking needs the customer's own account, at the counter too", async () => {
    const counter = await form(manager.cookie, slot(plainHall, day(12), 15, { phone: phone(), weeks: 3 }));
    expect(counter.body).toMatchObject({ code: "R9_DESK_SERIES", policy: "assisted" });
  });

  it("enrolling in a class asks the same: the house rules, strikes, and at the counter payment taken as it is enrolled", async () => {
    const made = await createClassSessions({ courtId: plainStudio, name: "Circuit", instructor: "Coach", date: day(13), start: at(18), end: at(19), capacity: 6, price: 15 });
    if (!made.ok) throw new Error(made.error);
    const cls = made.classes[0];
    const busy = phone();
    await booked(plainHall, day(13), 9, busy);
    expect((await enrol(null, { classId: cls.id, name: "Busy Bee", phone: busy })).body.code).toBe("LIMIT_DAY");
    expect((await enrol(manager.cookie, { classId: cls.id, name: "Busy Bee", phone: busy })).body.code).toBe("R9_DESK_LIMIT_DAY");
    const struck = phone();
    await noShow(plainHall2, struck);
    expect((await enrol(null, { classId: cls.id, name: "Struck", phone: struck })).body.code).toBe("STRIKES_COUNTER");
    expect((await enrol(desk.cookie, { classId: cls.id, name: "Struck", phone: struck })).body).toMatchObject({ code: "R9_DESK_STRIKES", payNow: true });
    const paid = await enrol(desk.cookie, { classId: cls.id, name: "Struck", phone: struck, paidAtCounter: "card" });
    expect(paid.status).toBe(201);
    expect(paid.body.booking).toMatchObject({ paymentStatus: "paid" });
  });

  it("the one check answers the same for the same request on every path (lib/limits.ts policyCheck)", async () => {
    const ph = phone();
    await noShow(plainHall2, ph);
    for (const path of ["customer", "staff", "api"] as const)
      expect((await policyCheck(path, { venueId: plain, phone: ph, dates: [day(14)], canPayOnline: false })).refusal?.code).toBe("STRIKES_COUNTER");
    expect((await policyCheck("staff", { venueId: plain, phone: ph, dates: [day(14)], paidNow: true })).refusal).toBeNull();
    // An override answers only for what its policy covers.
    const answer = await policyCheck("staff", { venueId: plain, phone: ph, dates: [day(14)], overrides: ["house_rules"] });
    expect(answer.refusal?.code).toBe("STRIKES_COUNTER");
    expect(answer.overridden).toEqual([]);
  });
});

describe("a manager's override, where the venue permits it", () => {
  it("is off until a manager turns it on; the desk cannot change it", async () => {
    expect(await venueOverrides(plain)).toEqual([]);
    const byDesk = await permit(desk, plain, ["strikes"]);
    expect(byDesk.status).toBe(403);
    expect(byDesk.body.code).toBe("MANAGER_ONLY");
    const ph = phone();
    await noShow(plainHall2, ph);
    const notPermitted = await form(manager.cookie, slot(plainHall, day(15), 9, { phone: ph, overridePolicies: ["strikes"], overrideReason: "Regular, phone was lost" }));
    expect(notPermitted.status).toBe(403);
    expect(notPermitted.body.code).toBe("R9_OVERRIDE_NOT_PERMITTED");
    expect((await permit(manager, plain, [...OVERRIDABLE])).body.policies?.sort()).toEqual([...OVERRIDABLE].sort());
    const log = await listActivity([plain]);
    expect(log.some((e) => e.action === "settings.changed" && /Manager overrides/.test(e.detail ?? ""))).toBe(true);
  });

  it("no-show strikes: booked, and the override written with the booking and in the activity log", async () => {
    const ph = phone();
    await noShow(plainHall2, ph);
    const refused = await form(manager.cookie, slot(plainHall, day(16), 9, { phone: ph }));
    expect(refused.body).toMatchObject({ code: "R9_DESK_STRIKES", policy: "strikes", overridable: true });
    const asDesk = await form(desk.cookie, slot(plainHall, day(16), 9, { phone: ph }));
    expect(asDesk.body).toMatchObject({ overridable: false, askManager: true });
    const over = await form(manager.cookie, slot(plainHall, day(16), 9, { phone: ph, overridePolicies: ["strikes"], overrideReason: "Long-standing regular; the no-show was our booking error" }));
    expect(over.status).toBe(201);
    // Not held, not paid: booked as the counter books.
    expect(over.body.booking).toMatchObject({ paymentStatus: "unpaid" });
    expect(over.body.holdUntil ?? null).toBeNull();
    expect(await overridesOf(over.body.booking!.code)).toEqual([
      { venue_id: plain, policy: "strikes", refusal_code: "STRIKES_COUNTER", reason: "Long-standing regular; the no-show was our booking error", admin_id: manager.id, admin_name: "Mira Manager" },
    ]);
    const log = await listActivity([plain], { bookingCode: over.body.booking!.code });
    expect(log.some((e) => e.action === "booking.policy_overridden" && e.adminName === "Mira Manager" && /no-show strikes/.test(e.detail ?? "") && /booking error/.test(e.detail ?? ""))).toBe(true);
    // Shown on the booking in the staff dashboard.
    const row = (await listBookingsForDate(day(16), plain)).find((b) => b.code === over.body.booking!.code)!;
    expect(row.policyOverrides).toMatchObject([{ policy: "strikes", adminName: "Mira Manager", code: "STRIKES_COUNTER" }]);
  });

  it("the house rules' limits, the guest limit and an assisted weekly booking, each recorded", async () => {
    const busy = phone();
    await booked(plainHall2, day(17), 9, busy);
    const rules = await form(manager.cookie, slot(plainHall, day(17), 12, { phone: busy, overridePolicies: ["house_rules"], overrideReason: "Team training, agreed with the club" }));
    expect(rules.status).toBe(201);
    expect((await overridesOf(rules.body.booking!.code)).map((o) => [o.policy, o.refusal_code])).toEqual([["house_rules", "LIMIT_DAY"]]);
    expect((await permit(surgeManager, surge, ["guest_surge"])).status).toBe(200);
    const guest = await form(surgeManager.cookie, slot(surgeHall, day(7), 12, { phone: phone(), overridePolicies: ["guest_surge"], overrideReason: "Walk-in, known to us" }));
    expect(guest.status).toBe(201);
    expect((await overridesOf(guest.body.booking!.code)).map((o) => o.policy)).toEqual(["guest_surge"]);
    const weekly = await form(manager.cookie, slot(plainHall, day(18), 20, { phone: phone(), weeks: 3, overridePolicies: ["assisted"], overrideReason: "Elderly customer, no smartphone" }));
    expect(weekly.status).toBe(201);
    const series = weekly.body.bookings as { code: string }[];
    expect(series).toHaveLength(3);
    // Every week its own record: each booking carries what let it through.
    for (const b of series) expect((await overridesOf(b.code)).map((o) => o.policy)).toEqual(["assisted"]);
  });

  it("several at once, only what was refused is recorded; asked for but not needed, nothing is", async () => {
    const ph = phone();
    await noShow(plainHall2, ph);
    await booked(plainHall2, day(19), 9, ph);
    const both = await form(manager.cookie, slot(plainHall, day(19), 13, { phone: ph, overridePolicies: ["strikes", "house_rules", "guest_surge"], overrideReason: "Agreed with the owner" }));
    expect(both.status).toBe(201);
    expect((await overridesOf(both.body.booking!.code)).map((o) => o.policy).sort()).toEqual(["house_rules", "strikes"]);
    const unneeded = await form(manager.cookie, slot(plainHall, day(20), 13, { phone: phone(), overridePolicies: ["strikes"], overrideReason: "Just in case" }));
    expect(unneeded.status).toBe(201);
    expect(await overridesOf(unneeded.body.booking!.code)).toEqual([]);
  });

  it("is refused for front desk, without a reason, for a customer, and through the API key", async () => {
    const ph = phone();
    await noShow(plainHall2, ph);
    const before = await allOverrides();
    const asDesk = await form(desk.cookie, slot(plainHall, day(21), 9, { phone: ph, overridePolicies: ["strikes"], overrideReason: "The manager said so" }));
    expect(asDesk.status).toBe(403);
    expect(asDesk.body.code).toBe("R9_OVERRIDE_MANAGERS");
    const noReason = await form(manager.cookie, slot(plainHall, day(21), 9, { phone: ph, overridePolicies: ["strikes"] }));
    expect(noReason.status).toBe(400);
    expect(noReason.body.code).toBe("R9_OVERRIDE_REASON");
    expect((await form(manager.cookie, slot(plainHall, day(21), 9, { phone: ph, overridePolicies: ["strikes"], overrideReason: "ok" }))).body.code).toBe("R9_OVERRIDE_REASON");
    expect((await form(manager.cookie, slot(plainHall, day(21), 9, { phone: ph, overridePolicies: ["strikes"], overrideReason: "x".repeat(301) }))).body.code).toBe("R9_OVERRIDE_REASON");
    const customer = await form(null, slot(plainHall, day(21), 9, { phone: ph, overridePolicies: ["strikes"], overrideReason: "I am a regular here" }));
    expect(customer.status).toBe(403);
    expect(customer.body.code).toBe("R9_OVERRIDE_MANAGERS");
    for (const extra of [{ overridePolicies: ["strikes"], overrideReason: "Venue system knows best" }, { overrideReason: "Venue system" }, { paidAtCounter: "cash" }, { override: true }]) {
      const viaApi = await api(plainKey, slot(plainHall, day(21), 9, { phone: ph, ...extra }));
      expect(viaApi.status).toBe(400);
      expect(viaApi.body.code).toBe("R9_API_NO_OVERRIDE");
    }
    const queued = await apiWaitlist.POST(
      req("http://localhost/api/v1/waitlist", "POST", null, { ...slot(plainHall, day(21), 9, { phone: ph }), overridePolicies: ["strikes"], overrideReason: "Venue system" }, { authorization: `Bearer ${plainKey}` })
    );
    expect(queued.status).toBe(400);
    expect(await allOverrides()).toBe(before);
  });

  it("never goes past a refused number, the unpaid limit, eligibility, the waiver, the booking window or capacity", async () => {
    expect((await permit(clubManager, club, [...OVERRIDABLE])).status).toBe(200);
    expect((await permit(waiverManager, waivered, [...OVERRIDABLE])).status).toBe(200);
    const all = { overridePolicies: [...OVERRIDABLE], overrideReason: "Trying every override there is" };
    const before = await allOverrides();
    // Not overridable at all: refused before anything is asked.
    for (const policy of ["refused_number", "unpaid_limit", "eligibility", "capacity", "waiver", "payment"]) {
      const asked = await form(manager.cookie, slot(plainHall, day(22), 9, { phone: phone(), overridePolicies: [policy], overrideReason: "Trying it anyway" }));
      expect(asked.status).toBe(400);
      expect(asked.body.code).toBe("R9_OVERRIDE_NOT_OVERRIDABLE");
    }
    const refused = phone();
    await blockPhone({ venueId: plain, phone: refused, adminId: manager.id });
    expect((await form(manager.cookie, slot(plainHall, day(22), 9, { phone: refused, ...all }))).body.code).toBe("R9_DESK_PHONE_BLOCKED");
    const owing = phone();
    for (const k of [23, 24, 25]) await booked(plainHall2, day(k), 9, owing);
    expect((await form(manager.cookie, slot(plainHall, day(26), 9, { phone: owing, ...all }))).body.code).toBe("R9_DESK_UNPAID_VENUE");
    expect((await form(clubManager.cookie, slot(clubHall, day(6), 9, { phone: phone(), ...all }))).body.code).toBe("R9_DESK_NOT_MEMBER");
    expect((await form(waiverManager.cookie, slot(waiveredHall, day(6), 9, { phone: phone(), ...all }))).body.code).toBe("WAIVER_NEEDED");
    expect((await form(manager.cookie, slot(plainHall, day(60), 9, { phone: phone(), ...all }))).body.code).toBe("LIMIT_AHEAD");
    // The time taken: the database refuses it, and nothing of an override is kept.
    const taken = await booked(plainHall, day(27), 9, phone());
    expect(taken.id).toBeGreaterThan(0);
    const struck = phone();
    await noShow(plainHall2, struck);
    const clash = await form(manager.cookie, slot(plainHall, day(27), 9, { phone: struck, ...all }));
    expect(clash.status).toBe(409);
    expect(await allOverrides()).toBe(before);
  });
});

describe("waiting lists ask what the booking would", () => {
  it("the waiver at the claim, where the booking is made: the offer stands until it is agreed", async () => {
    const date = day(8);
    const taken = await booked(waiveredHall, date, 14, phone());
    const ph = phone();
    const joined = await waitlistRoute.POST(req("http://localhost/api/waitlist", "POST", null, { courtId: waiveredHall, date, start: at(14), end: at(15), name: "Wall Wira", phone: ph }));
    expect(joined.status).toBe(201);
    const entryId = ((await joined.json()) as { entry: { id: number } }).entry.id;
    expect((await cancelBooking(taken.code, taken.phone)).ok).toBe(true);
    const row = (await getDb().prepare("SELECT status, offer_token FROM waitlist WHERE id = ?").get(entryId)) as { status: string; offer_token: string };
    expect(row.status).toBe("offered");
    const unsigned = await claimRoute.POST(req("http://localhost/api/waitlist/claim", "POST", null, { token: row.offer_token }));
    expect(unsigned.status).toBe(409);
    expect(await unsigned.json()).toMatchObject({ code: "WAIVER_NEEDED", vars: { venueId: waivered, venue: "Waiver Walls" } });
    // Still offered, its hold kept: tick the box and claim again.
    expect(((await getDb().prepare("SELECT status FROM waitlist WHERE id = ?").get(entryId)) as { status: string }).status).toBe("offered");
    const agreed = await claimRoute.POST(req("http://localhost/api/waitlist/claim", "POST", null, { token: row.offer_token, agreeWaiver: true }));
    expect(agreed.status).toBe(200);
    expect(await waiverSigned(waivered, ph)).toBe(true);
  });

  it("the members' longer window again at the claim: a membership ended since leaves it refused", async () => {
    const date = day(15);
    const member = phone();
    const sold = await sellMembership({ venueId: early, holderName: "Early Member", holderPhone: member, startsOn: todayISO(ZONE), expiresOn: day(60), price: 50, adminId: earlyManager.id });
    if (!sold.ok) throw new Error(sold.error);
    const taken = await booked(earlyHall, date, 10, phone());
    const joined = await adminWaitlist.POST(req("http://localhost/api/admin/waitlist", "POST", earlyManager.cookie, { venueId: early, courtId: earlyHall, date, start: at(10), end: at(11), name: "Early Member", phone: member }));
    expect(joined.status).toBe(201);
    const entryId = ((await joined.json()) as { entry: { id: number } }).entry.id;
    expect((await cancelBooking(taken.code, taken.phone)).ok).toBe(true);
    const offer = (await getDb().prepare("SELECT status, offer_token FROM waitlist WHERE id = ?").get(entryId)) as { status: string; offer_token: string };
    expect(offer.status).toBe("offered");
    expect((await voidMembership(sold.membership.id)).ok).toBe(true);
    expect(await claimWaitlistOffer(offer.offer_token)).toMatchObject({ ok: false, code: "LIMIT_AHEAD_MEMBERS" });
    expect(((await getDb().prepare("SELECT status FROM waitlist WHERE id = ?").get(entryId)) as { status: string }).status).toBe("waiting");
  });

  it("a class's queue asks what enrolling asks: the house rules, and strikes refused online as an enrolment is", async () => {
    const made = await createClassSessions({ courtId: plainStudio, name: "Spin", instructor: "Coach", date: day(28), start: at(19), end: at(20), capacity: 1, price: 12 });
    if (!made.ok) throw new Error(made.error);
    const cls = made.classes[0];
    const filled = await enrolPeople({ classId: cls.id, name: "Filler", phone: phone(), people: [null] });
    if (!filled.ok) throw new Error(filled.error);
    const join = async (ph: string) => {
      const res = await waitlistRoute.POST(req("http://localhost/api/waitlist", "POST", null, { classId: cls.id, name: "Queue", phone: ph }));
      return { status: res.status, body: (await res.json()) as { code?: string } };
    };
    const busy = phone();
    await booked(plainHall, day(28), 9, busy);
    expect((await enrol(null, { classId: cls.id, name: "Queue", phone: busy })).body.code).toBe("LIMIT_DAY");
    expect((await join(busy)).body.code).toBe("LIMIT_DAY");
    const struck = phone();
    await noShow(plainHall2, struck);
    expect((await enrol(null, { classId: cls.id, name: "Queue", phone: struck })).body.code).toBe("STRIKES_COUNTER");
    expect((await join(struck)).body.code).toBe("STRIKES_COUNTER");
  });

  it("at the counter, who is queued at a members-only venue: the number, as a counter booking asks", async () => {
    const res = await adminWaitlist.POST(
      req("http://localhost/api/admin/waitlist", "POST", clubManager.cookie, { venueId: club, courtId: clubHall, date: day(9), start: at(9), end: at(10), name: "Not A Member", phone: phone() })
    );
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("R9_DESK_NOT_MEMBER");
  });
});

describe("taking a number off the venue's refused list", () => {
  it("says why, kept in the activity log with who did it; blocking is logged too", async () => {
    const ph = phone();
    const call = async (method: "POST" | "DELETE", body: Record<string, unknown>) =>
      blockedRoute[method](req(`http://localhost/api/admin/venues/${plain}/blocked-phones`, method, manager.cookie, body), { params: Promise.resolve({ id: String(plain) }) });
    expect((await call("POST", { phone: ph, reason: "Abusive on the phone" })).status).toBe(200);
    const noWhy = await call("DELETE", { phone: ph });
    expect(noWhy.status).toBe(400);
    expect(((await noWhy.json()) as { code: string }).code).toBe("R9_UNBLOCK_REASON");
    expect((await form(manager.cookie, slot(plainHall, day(29), 9, { phone: ph }))).body.code).toBe("R9_DESK_PHONE_BLOCKED");
    expect((await call("DELETE", { phone: ph, reason: "Apologised and paid what was owed" })).status).toBe(200);
    const log = await listActivity([plain]);
    expect(log.some((e) => e.action === "phone.blocked" && e.adminName === "Mira Manager" && (e.detail ?? "").includes("Abusive"))).toBe(true);
    expect(log.some((e) => e.action === "phone.unblocked" && e.adminName === "Mira Manager" && (e.detail ?? "").includes("Apologised and paid what was owed"))).toBe(true);
    expect((await form(manager.cookie, slot(plainHall, day(29), 9, { phone: ph }))).status).toBe(201);
  });
});

describe("the words", () => {
  it("every refusal said at the counter has its words in every customer language and the staff ones", () => {
    for (const code of ["R9_DESK_STRIKES", "R9_DESK_UNPAID_VENUE", "R9_DESK_PHONE_BLOCKED", "R9_OVERRIDE_NOT_PERMITTED", "R9_NOT_MEMBER"]) {
      for (const locale of ["en", "ms", "zh", "ta"] as const) expect(translator(locale)(`err.${code}` as never)).not.toBe(`err.${code}`);
      expect(staffTranslator("zh").err({ error: "x", code, vars: { n: 2 } })).not.toBe("x");
    }
  });
});
