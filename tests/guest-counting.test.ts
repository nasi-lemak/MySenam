import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { accessEntryId, accessList, addAccess, linkAccess, setAccessSettings } from "../src/lib/access";
import { listActivity } from "../src/lib/activity";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { createApiKey } from "../src/lib/api-keys";
import { registerUser } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { inviteGuest, setGuestPolicy } from "../src/lib/guest-invites";
import { setHouseRules } from "../src/lib/house-rules";
import { GUEST_SURGE_PER_HOUR, guestSurge } from "../src/lib/limits";
import { venueReport } from "../src/lib/reports";
import { createResources } from "../src/lib/resources";
import { createBookingSeries, createClassSessions, createVenue, listBookingsForDate } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import * as apiBookings from "../src/app/api/v1/bookings/route";
import * as availabilityRoute from "../src/app/api/availability/route";
import * as bookingsRoute from "../src/app/api/bookings/route";
import * as enrolRoute from "../src/app/api/classes/enrol/route";
import * as overridesRoute from "../src/app/api/admin/policy-overrides/route";

/**
 * Counting actual guests (the owner's decision of 28 October 2026): "Count
 * actual guests, including counter-registered guests, while distinguishing
 * ordinary walk-in customers from guests accompanying members."
 *
 * - The limit on online bookings without an account (`GUEST_SURGE`, a brake
 *   on scripted flooding) counts bookings made online and through the API,
 *   not the counter's own walk-ins (`bookings.made_on`).
 * - A member's or resident's guest booked at the counter or through the API
 *   goes on the venue's list as the host's guest, against the host's guest
 *   allowance as a resident's own invitation online is, refused or (at the
 *   counter, by a manager where the venue permits it) overridden; the
 *   booking keeps whose guest it is (`bookings.guest_of_entry`).
 */

const ZONE = "Asia/Kuala_Lumpur";
const day = (k: number) => addDays(todayISO(ZONE), k);
const at = (h: number) => h * 60;
let n = 0;
const phone = () => `0166${String(++n).padStart(6, "0")}`;

type Staff = { id: number; name: string; cookie: string };
type Answer = { status: number; body: Record<string, unknown> & { code?: string; booking?: { id: number; code: string } } };

const req = (url: string, method: string, cookie: string | null, body?: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(url, {
    method,
    headers: { "content-type": "application/json", "x-forwarded-for": `10.88.${++n % 250}.${n % 200}`, ...(cookie ? { cookie } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const form = async (cookie: string | null, body: Record<string, unknown>): Promise<Answer> => {
  const res = await bookingsRoute.POST(req("http://localhost/api/bookings", "POST", cookie, body));
  return { status: res.status, body: await res.json() };
};
const api = async (key: string, body: Record<string, unknown>): Promise<Answer> => {
  const res = await apiBookings.POST(req("http://localhost/api/v1/bookings", "POST", null, body, { authorization: `Bearer ${key}` }));
  return { status: res.status, body: await res.json() };
};
const slot = (courtId: number, date: string, h: number, extra: Record<string, unknown> = {}) => ({
  courtId,
  date,
  start: at(h),
  end: at(h + 1),
  name: "Test Customer",
  ...extra,
});
const row = async (code: string) =>
  (await getDb().prepare("SELECT made_on, guest_of_entry FROM bookings WHERE code = ?").get(code)) as { made_on: string | null; guest_of_entry: number | null };
const listed = async (venueId: number, ph: string) => (await accessList(venueId)).find((e) => e.phone === ph);

async function staffMember(venueId: number, name: string, role: "manager" | "desk" = "manager"): Promise<Staff> {
  const made = await createAdmin({ name, email: `${name.toLowerCase().replace(/\W/g, "")}${++n}@gc8.test`, password: "a long enough password", venueId, role });
  if (!made.ok) throw new Error(made.error);
  return { id: made.admin.id, name, cookie: `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(made.admin.id)).token}` };
}
async function keyFor(venueId: number, by: number) {
  const made = await createApiKey(venueId, { name: "Venue system", scope: "write", ownership: "venue" }, by);
  if (!made.ok) throw new Error("key");
  return made.key;
}

let counterHall: number; // public: its counter books many walk-ins
let counterCourt: number;
let onlineHall: number; // public: flooded online
let onlineCourt: number;
let condo: number; // private: residents may have one guest at a time, for up to three days
let condoCourt: number;
let condoCourt2: number;
let condoStudio: number;
let club: number; // members only: a booking a day for each household
let clubCourt: number;
let counterDesk: Staff;
let onlineDesk: Staff;
let condoDesk: Staff;
let condoManager: Staff;
let clubDesk: Staff;
let counterKey: string;
let condoKey: string;
const resident = { phone: "0123400001", name: "Hafiz", label: "A-12-3" };
const neighbour = { phone: "0123400002", name: "Mei Ling", label: "B-5-1" };
const owner = { phone: "0123400003", name: "Ravi", label: "C-1-1" };
const member = { phone: "0123400004", name: "Siti", label: "M-007" };

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
  counterHall = await make("Counter Hall", "0312988001");
  onlineHall = await make("Online Hall", "0312988002");
  condo = await make("Condo Courts", "0312988003");
  club = await make("Members Club", "0312988004");
  counterCourt = await resource(counterHall, "badminton", "Court 1");
  onlineCourt = await resource(onlineHall, "badminton", "Court 1");
  condoCourt = await resource(condo, "tennis", "Court 1");
  condoCourt2 = await resource(condo, "tennis", "Court 2");
  condoStudio = await resource(condo, "gym", "Studio", 6);
  clubCourt = await resource(club, "tennis", "Court 1");
  expect((await setAccessSettings(condo, { access: "private" })).ok).toBe(true);
  expect((await setAccessSettings(club, { access: "members" })).ok).toBe(true);
  expect((await setGuestPolicy(condo, { perResident: 1, days: 3 })).ok).toBe(true);
  expect((await setGuestPolicy(club, { perResident: 2, days: 7 })).ok).toBe(true);
  expect((await setHouseRules(club, { aheadDays: 45, perDay: 1 })).ok).toBe(true);
  const added = await addAccess(condo, [resident, neighbour, owner].map((p) => ({ ...p, kind: "resident" as const })), null);
  if (!added.ok) throw new Error(added.error);
  expect((await addAccess(club, [{ ...member, kind: "member" }], null)).ok).toBe(true);
  counterDesk = await staffMember(counterHall, "Cass Desk", "desk");
  onlineDesk = await staffMember(onlineHall, "Olly Desk", "desk");
  condoDesk = await staffMember(condo, "Cody Desk", "desk");
  condoManager = await staffMember(condo, "Cora Manager");
  clubDesk = await staffMember(club, "Clem Desk", "desk");
  counterKey = await keyFor(counterHall, counterDesk.id);
  condoKey = await keyFor(condo, condoManager.id);
});

describe("the limit on online bookings without an account counts what was made online, not the counter's walk-ins", () => {
  it("a busy counter hour of unpaid walk-ins does not trip it; the same number made online does", async () => {
    for (let i = 0; i < GUEST_SURGE_PER_HOUR; i++) {
      const made = await createBookingSeries({
        courtId: counterCourt,
        date: day(1 + Math.floor(i / 14)),
        start: at(8 + (i % 14)),
        end: at(9 + (i % 14)),
        weeks: 1,
        name: `Walk-in ${i}`,
        phone: `0155${String(i).padStart(6, "0")}`,
        by: "staff",
      });
      if (!made.ok) throw new Error(made.error);
    }
    expect(await guestSurge(counterHall)).toBe(false);
    for (let i = 0; i < GUEST_SURGE_PER_HOUR; i++) {
      const made = await createBookingSeries({
        courtId: onlineCourt,
        date: day(1 + Math.floor(i / 14)),
        start: at(8 + (i % 14)),
        end: at(9 + (i % 14)),
        weeks: 1,
        name: `Online ${i}`,
        phone: `0156${String(i).padStart(6, "0")}`,
      });
      if (!made.ok) throw new Error(made.error);
      expect(await guestSurge(onlineHall)).toBe(i + 1 >= GUEST_SURGE_PER_HOUR);
    }
  });

  it("the counter keeps walking customers in: unpaid at the counter, and never held, while the online form is braked elsewhere", async () => {
    const walkIn = await form(counterDesk.cookie, slot(counterCourt, day(5), 9, { phone: phone() }));
    expect(walkIn.status).toBe(201);
    expect(await row(walkIn.body.booking!.code)).toEqual({ made_on: "staff", guest_of_entry: null });
    expect(await guestSurge(counterHall)).toBe(false);
    // Online, at the same hall, is still asked: not flooded online, so booked, and recorded as made online.
    const online = await form(null, slot(counterCourt, day(5), 10, { phone: phone() }));
    expect(online.status).toBe(201);
    expect((await row(online.body.booking!.code)).made_on).toBe("customer");
  });

  it("not weakened online or through the API: the flooded hall refuses online, the API and (same policies) the counter unless paid now", async () => {
    expect((await form(null, slot(onlineCourt, day(6), 12, { phone: phone() }))).body.code).toBe("GUEST_SURGE");
    expect((await form(onlineDesk.cookie, slot(onlineCourt, day(6), 12, { phone: phone() }))).body).toMatchObject({ code: "R9_DESK_GUEST_SURGE", payNow: true });
    const paid = await form(onlineDesk.cookie, slot(onlineCourt, day(6), 12, { phone: phone(), paidAtCounter: "cash" }));
    expect(paid.status).toBe(201);
    expect((await row(paid.body.booking!.code)).made_on).toBe("staff");
  });

  it("bookings through the venue's API key are recorded as such and still counted", async () => {
    const before = ((await getDb().prepare("SELECT COUNT(*)::int AS n FROM bookings b JOIN courts c ON c.id = b.court_id WHERE c.venue_id = ? AND b.made_on = 'api'").get(counterHall)) as { n: number }).n;
    expect(before).toBe(0);
    for (let i = 0; i < GUEST_SURGE_PER_HOUR; i++) {
      const made = await createBookingSeries({
        courtId: counterCourt,
        date: day(10 + Math.floor(i / 14)),
        start: at(8 + (i % 14)),
        end: at(9 + (i % 14)),
        weeks: 1,
        name: `System ${i}`,
        phone: `0157${String(i).padStart(6, "0")}`,
        by: "api",
      });
      if (!made.ok) throw new Error(made.error);
    }
    expect(await guestSurge(counterHall)).toBe(true);
    const viaKey = await api(counterKey, slot(counterCourt, day(20), 9, { phone: phone() }));
    expect(viaKey.body.code).toBe("GUEST_SURGE");
  });

  it("a class place enrolled at the counter is recorded as the counter's", async () => {
    const made = await createClassSessions({ courtId: condoStudio, name: "Circuit", instructor: "Coach", date: day(2), start: at(18), end: at(19), capacity: 6, price: 15 });
    if (!made.ok) throw new Error(made.error);
    const res = await enrolRoute.POST(req("http://localhost/api/classes/enrol", "POST", condoDesk.cookie, { classId: made.classes[0].id, name: "Owner", phone: owner.phone }));
    const body = (await res.json()) as { booking?: { code: string } };
    expect(res.status).toBe(201);
    expect((await row(body.booking!.code)).made_on).toBe("staff");
  });
});

describe("a member's or resident's guest is counted on every path against the host's allowance", () => {
  it("the counter form is offered the choice only at a members-only or private venue", async () => {
    const ask = async (venueId: number, cookie: string) => {
      const res = await availabilityRoute.GET(req(`http://localhost/api/availability?venueId=${venueId}&date=${day(1)}&sport=tennis`, "GET", cookie));
      return ((await res.json()) as { guestsOfMembers?: boolean }).guestsOfMembers;
    };
    expect(await ask(condo, condoDesk.cookie)).toBe(true);
    expect(await ask(counterHall, counterDesk.cookie)).toBe(false);
  });

  it("a walk-in at a private venue is still not let in: only a guest of somebody on the list", async () => {
    const walkIn = await form(condoDesk.cookie, slot(condoCourt, day(1), 9, { phone: phone() }));
    expect(walkIn.body.code).toBe("R9_DESK_NOT_LISTED");
  });

  it("front desk books a resident's guest: on the list as theirs until the day booked, the booking keeping whose guest it is", async () => {
    const guest = phone();
    const made = await form(condoDesk.cookie, slot(condoCourt, day(1), 9, { phone: guest, name: "Ali Guest", guestOf: resident.phone }));
    expect(made.status).toBe(201);
    const hostEntry = await accessEntryId(condo, resident.phone);
    expect(await row(made.body.booking!.code)).toEqual({ made_on: "staff", guest_of_entry: hostEntry });
    const entry = await listed(condo, guest);
    expect(entry).toMatchObject({ kind: "guest", expiresOn: day(1), label: resident.label, invitedBy: resident.name });
    const added = (await getDb().prepare("SELECT added_by, invited_by FROM venue_access_list WHERE id = ?").get(entry!.id)) as { added_by: number; invited_by: number };
    expect(added).toEqual({ added_by: condoDesk.id, invited_by: hostEntry });
    const log = await listActivity([condo], { bookingCode: made.body.booking!.code });
    expect(log.find((e) => e.action === "guest.registered")).toMatchObject({ adminName: "Cody Desk" });
    // Booked again for the same host: the same guest, the visit extended, no extra place taken.
    const again = await form(condoDesk.cookie, slot(condoCourt, day(2), 9, { phone: guest, name: "Ali Guest", guestOf: resident.phone }));
    expect(again.status).toBe(201);
    expect((await listed(condo, guest))?.expiresOn).toBe(day(2));
  });

  it("the guest counts against the resident's allowance online, at the counter and through the API", async () => {
    // The resident, signed in, inviting a second guest themselves: the counter's guest already took the one place.
    const made = await registerUser({ name: "Hafiz", email: "hafiz@gc8.test", phone: resident.phone, password: "rahsia-123" });
    if (!made.ok) throw new Error(made.error);
    expect((await linkAccess(condo, (await accessEntryId(condo, resident.phone))!, "hafiz@gc8.test", null)).ok).toBe(true);
    expect(await inviteGuest(made.user.id, { venueId: condo, phone: phone(), days: 1 })).toMatchObject({ ok: false, code: "GUEST_LIMIT" });
    const counter = await form(condoDesk.cookie, slot(condoCourt2, day(1), 10, { phone: phone(), guestOf: resident.phone }));
    expect(counter.status).toBe(409);
    expect(counter.body).toMatchObject({ code: "GC8_GUEST_ALLOWANCE", vars: { n: 1 }, policy: "guest_allowance", overridable: false, askManager: false });
    const viaKey = await api(condoKey, slot(condoCourt2, day(1), 10, { phone: phone(), guestOf: resident.phone }));
    expect(viaKey.status).toBe(409);
    expect(viaKey.body.code).toBe("GC8_GUEST_ALLOWANCE");
    expect(viaKey.body.error).toMatch(/One must come off the list/);
  });

  it("an online invitation counts at the counter the same way", async () => {
    const made = await registerUser({ name: "Mei", email: "mei@gc8.test", phone: neighbour.phone, password: "rahsia-123" });
    if (!made.ok) throw new Error(made.error);
    expect((await linkAccess(condo, (await accessEntryId(condo, neighbour.phone))!, "mei@gc8.test", null)).ok).toBe(true);
    expect((await inviteGuest(made.user.id, { venueId: condo, phone: phone(), days: 2 })).ok).toBe(true);
    const counter = await form(condoDesk.cookie, slot(condoCourt2, day(1), 11, { phone: phone(), guestOf: neighbour.phone }));
    expect(counter.body.code).toBe("GC8_GUEST_ALLOWANCE");
  });

  it("the venue's API key registers a guest within the allowance, and never goes past it", async () => {
    const guest = phone();
    const made = await api(condoKey, slot(condoCourt2, day(1), 12, { phone: guest, name: "Key Guest", guestOf: owner.phone }));
    expect(made.status).toBe(201);
    expect(await row(made.body.booking!.code)).toEqual({ made_on: "api", guest_of_entry: await accessEntryId(condo, owner.phone) });
    expect((await listed(condo, guest))?.kind).toBe("guest");
    const over = await api(condoKey, slot(condoCourt2, day(1), 13, { phone: phone(), guestOf: owner.phone, overridePolicies: ["guest_allowance"], overrideReason: "Family visiting" }));
    expect(over.body.code).toBe("R9_API_NO_OVERRIDE");
  });

  it("a manager overrides the allowance where the venue permits it, recorded with the booking; front desk is told to ask", async () => {
    const permit = await overridesRoute.POST(req("http://localhost/api/admin/policy-overrides", "POST", condoManager.cookie, { venueId: condo, policies: ["guest_allowance"] }));
    expect(permit.status).toBe(200);
    const guest = phone();
    expect((await form(condoDesk.cookie, slot(condoCourt2, day(1), 14, { phone: guest, guestOf: resident.phone }))).body).toMatchObject({
      code: "GC8_GUEST_ALLOWANCE",
      askManager: true,
      overridable: false,
    });
    expect((await form(condoManager.cookie, slot(condoCourt2, day(1), 14, { phone: guest, guestOf: resident.phone }))).body).toMatchObject({ overridable: true });
    const over = await form(condoManager.cookie, slot(condoCourt2, day(1), 14, { phone: guest, guestOf: resident.phone, overridePolicies: ["guest_allowance"], overrideReason: "Second guest for a family visit" }));
    expect(over.status).toBe(201);
    const rows = (await getDb()
      .prepare("SELECT o.policy, o.refusal_code, o.admin_name FROM booking_policy_overrides o JOIN bookings b ON b.id = o.booking_id WHERE b.code = ?")
      .all(over.body.booking!.code)) as { policy: string; refusal_code: string; admin_name: string }[];
    expect(rows).toEqual([{ policy: "guest_allowance", refusal_code: "GC8_GUEST_ALLOWANCE", admin_name: "Cora Manager" }]);
    expect((await listed(condo, guest))?.kind).toBe("guest");
    // Front desk asking to override is refused, as every override is theirs to ask for, not give.
    expect((await form(condoDesk.cookie, slot(condoCourt2, day(1), 15, { phone: phone(), guestOf: resident.phone, overridePolicies: ["guest_allowance"], overrideReason: "Second guest" }))).body.code).toBe(
      "R9_OVERRIDE_MANAGERS"
    );
  });

  it("how long a visit runs is the allowance's too: past it refused, a manager may override", async () => {
    expect((await addAccess(condo, [{ phone: "0123400006", name: "Lim", label: "E-3-3", kind: "resident" }], null)).ok).toBe(true);
    const guest = phone();
    expect((await form(condoDesk.cookie, slot(condoCourt, day(5), 9, { phone: guest, guestOf: "0123400006" }))).body).toMatchObject({ code: "GC8_GUEST_DAYS", vars: { n: 3 } });
    const over = await form(condoManager.cookie, slot(condoCourt, day(5), 9, { phone: guest, guestOf: "0123400006", overridePolicies: ["guest_allowance"], overrideReason: "Staying the week" }));
    expect(over.status).toBe(201);
    expect((await listed(condo, guest))?.expiresOn).toBe(day(5));
  });

  it("never overridden: the host not on the list, the guest on it in their own right, the host's own number, a public venue, customers", async () => {
    expect((await form(condoManager.cookie, slot(condoCourt, day(1), 16, { phone: phone(), guestOf: "0129999999", overridePolicies: ["guest_allowance"], overrideReason: "Says they live here" }))).body.code).toBe(
      "GC8_HOST_NOT_FOUND"
    );
    expect((await form(condoDesk.cookie, slot(condoCourt, day(1), 16, { phone: neighbour.phone, guestOf: resident.phone }))).body.code).toBe("GC8_GUEST_LISTED");
    expect((await form(condoDesk.cookie, slot(condoCourt, day(1), 16, { phone: resident.phone, guestOf: resident.phone }))).body.code).toBe("GC8_GUEST_IS_HOST");
    const publicVenue = await form(counterDesk.cookie, slot(counterCourt, day(4), 9, { phone: phone(), guestOf: "0123400001" }));
    expect([publicVenue.status, publicVenue.body.code]).toEqual([400, "GC8_GUESTS_NOT_HERE"]);
    const online = await form(null, slot(condoCourt, day(1), 16, { phone: phone(), guestOf: resident.phone }));
    expect([online.status, online.body.code]).toEqual([403, "GC8_GUEST_OF_STAFF"]);
  });

  it("a booking that cannot be made leaves no guest on the list", async () => {
    // Court 1 at 9 on day(1) is the first guest's booking.
    const guest = phone();
    const taken = await form(condoManager.cookie, slot(condoCourt, day(1), 9, { phone: guest, guestOf: owner.phone, overridePolicies: ["guest_allowance"], overrideReason: "Owner's second guest" }));
    expect(taken.status).toBe(409);
    expect(await listed(condo, guest)).toBeUndefined();
  });

  it("the guest shares the host's household under the house rules, even before they are on the list", async () => {
    const own = await form(clubDesk.cookie, slot(clubCourt, day(3), 9, { phone: member.phone, name: member.name }));
    expect(own.status).toBe(201);
    const guest = phone();
    expect((await form(clubDesk.cookie, slot(clubCourt, day(3), 11, { phone: guest, guestOf: member.phone }))).body.code).toBe("R9_DESK_LIMIT_DAY");
    expect(await listed(club, guest)).toBeUndefined();
    const nextDay = await form(clubDesk.cookie, slot(clubCourt, day(4), 11, { phone: guest, guestOf: member.phone }));
    expect(nextDay.status).toBe(201);
    expect((await listed(club, guest))?.label).toBe(member.label);
  });

  it("reporting and occupancy count a guest's booking as any booking", async () => {
    const before = (await venueReport(club, day(5), day(5)))!.bookings.confirmed;
    const made = await form(clubDesk.cookie, slot(clubCourt, day(5), 9, { phone: phone(), guestOf: member.phone }));
    expect(made.status).toBe(201);
    expect((await venueReport(club, day(5), day(5)))!.bookings.confirmed).toBe(before + 1);
    expect((await listBookingsForDate(day(5), club)).some((b) => b.code === made.body.booking!.code)).toBe(true);
  });

  it("two guests registered at once for one host with one place left: one is booked, the other refused", async () => {
    const answers = await Promise.all([
      form(condoDesk.cookie, slot(condoCourt, day(2), 17, { phone: phone(), guestOf: "0123400005" })),
      form(condoDesk.cookie, slot(condoCourt2, day(2), 17, { phone: phone(), guestOf: "0123400005" })),
    ]);
    // The host is new to the list, with no guest yet.
    expect(answers.map((a) => a.body.code ?? a.status).sort()).toEqual(["GC8_HOST_NOT_FOUND", "GC8_HOST_NOT_FOUND"]);
    expect((await addAccess(condo, [{ phone: "0123400005", name: "Tan", label: "D-2-2", kind: "resident" }], null)).ok).toBe(true);
    const race = await Promise.all([
      form(condoDesk.cookie, slot(condoCourt, day(2), 18, { phone: phone(), guestOf: "0123400005" })),
      form(condoDesk.cookie, slot(condoCourt2, day(2), 18, { phone: phone(), guestOf: "0123400005" })),
    ]);
    expect(race.map((a) => a.status).sort()).toEqual([201, 409]);
    expect(race.find((a) => a.status === 409)!.body.code).toBe("GC8_GUEST_ALLOWANCE");
    const hostEntry = await accessEntryId(condo, "0123400005");
    const guests = ((await getDb().prepare("SELECT COUNT(*)::int AS n FROM venue_access_list WHERE invited_by = ?").get(hostEntry)) as { n: number }).n;
    expect(guests).toBe(1);
  });
});
