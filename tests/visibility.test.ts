import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

// The booking route reads the customer's language from a cookie.
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import {
  accessList,
  accessRefusal,
  addAccess,
  myPrivateVenues,
  parseAccessLines,
  setAccessSettings,
} from "../src/lib/access";
import { ADMIN_SESSION_COOKIE, authenticateAdmin, createAdmin, createAdminSession, ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { createSession, registerUser, SESSION_COOKIE } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { mayShowVenue } from "../src/lib/listing";
import { createCourt, createVenue, listVenuePage, searchAvailability, sellMembership } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { POST as book } from "../src/app/api/bookings/route";
import { GET as accessGet, POST as accessPost } from "../src/app/api/admin/venue-access/route";
import { GET as myVenues } from "../src/app/api/my/venues/route";
import { GET as availability } from "../src/app/api/availability/route";

/**
 * Who a venue is for: anybody, members, or a private list — a club taking
 * new members, a condominium's courts that only residents should even see.
 */

let ownerId: number;
let ownerCookie: string;
let members: number;
let privateVenue: number;
let privateCourt: number;
const date = addDays(todayISO(), 2);

async function venue(name: string) {
  const made = await createVenue({ name, area: "Cheras", address: "1 Jalan Ujian", phone: "0300000000" });
  if (!made.ok) throw new Error("venue");
  const court = await createCourt({ venueId: made.venue.id, name: "Court A", sport: "badminton", offPeakRate: 10, peakRate: 15 });
  if (!court.ok) throw new Error("court");
  return { id: made.venue.id, courtId: court.court.id };
}

let n = 0;
async function customer(phone: string) {
  const made = await registerUser({ name: `Resident ${++n}`, email: `r${n}@example.com`, phone, password: "password-123" });
  if (!made.ok) throw new Error(made.error);
  return { id: made.user.id, cookie: `${SESSION_COOKIE}=${(await createSession(made.user.id)).token}` };
}

beforeAll(async () => {
  await ensureBootstrapAdmin();
  const owner = (await authenticateAdmin("admin@mysenam.my", "mysenam-admin"))!;
  ownerId = owner.id;
  ownerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(owner.id)).token}`;
  members = (await venue("Kelab Rahsia")).id;
  const p = await venue("Kondo Indah Courts");
  privateVenue = p.id;
  privateCourt = p.courtId;
  await setAccessSettings(members, { access: "members", listed: true, note: "Ask at the counter." });
  await setAccessSettings(privateVenue, { access: "private" });
});

afterEach(() => {
  delete process.env.MYSENAM_PHONE_CHECK;
});

describe("finding a venue", () => {
  it("lists a members-only venue unless it asks not to be, and never a private one", async () => {
    const names = async () => (await listVenuePage({ pageSize: 100 })).venues.map((v) => v.name);
    expect(await names()).toContain("Kelab Rahsia");
    expect(await names()).not.toContain("Kondo Indah Courts");

    await setAccessSettings(members, { access: "members", listed: false });
    expect(await names()).not.toContain("Kelab Rahsia");
    await setAccessSettings(members, { access: "members", listed: true, note: "Ask at the counter." });

    const found = (await searchAvailability({ sport: "badminton", date })).map((r) => r.venue.name);
    expect(found).not.toContain("Kondo Indah Courts");
    expect(found).toContain("Kelab Rahsia");
    // Not on a storefront's own list either.
    const here = await listVenuePage({ venueIds: [members, privateVenue], pageSize: 10 });
    expect(here.venues.map((v) => v.id)).toEqual([members]);
  });

  it("shows a private venue's page to its staff and its list, and asks anybody else to sign in", async () => {
    expect(await mayShowVenue(members, { admin: null, userId: null })).toMatchObject({ show: true });
    expect(await mayShowVenue(privateVenue, { admin: null, userId: null })).toEqual({ show: false, preview: false, signIn: true });

    const stranger = await customer("0170000001");
    expect(await mayShowVenue(privateVenue, { admin: null, userId: stranger.id })).toMatchObject({ show: false, signIn: false });

    const resident = await customer("0170000002");
    await addAccess(privateVenue, [{ phone: "+60 17-000 0002", name: "Aisyah", label: "A-12-3" }], ownerId);
    expect(await mayShowVenue(privateVenue, { admin: null, userId: resident.id })).toMatchObject({ show: true });

    const owner = (await authenticateAdmin("admin@mysenam.my", "mysenam-admin"))!;
    expect(await mayShowVenue(privateVenue, { admin: owner, userId: null })).toMatchObject({ show: true });
    expect(await myPrivateVenues(resident.id)).toEqual([{ id: privateVenue, name: "Kondo Indah Courts", area: "Cheras" }]);
    const res = await myVenues(new NextRequest("http://localhost/api/my/venues", { headers: { cookie: resident.cookie } }));
    expect((await res.json()).venues).toHaveLength(1);

    // Its courts and times too: nobody else can read them off the API.
    const grid = (cookie?: string) =>
      availability(
        new NextRequest(`http://localhost/api/availability?venueId=${privateVenue}&date=${date}`, { headers: cookie ? { cookie } : {} })
      );
    expect((await grid()).status).toBe(404);
    expect((await grid(stranger.cookie)).status).toBe(404);
    expect((await grid(resident.cookie)).status).toBe(200);
  });
});

describe("booking", () => {
  it("at a members-only venue needs an account with a membership, or a place on the list", async () => {
    expect(await accessRefusal(members, null)).toMatchObject({ code: "MEMBERS_SIGN_IN" });
    const walkIn = await customer("0170000010");
    expect(await accessRefusal(members, walkIn.id)).toMatchObject({ code: "MEMBERS_ONLY" });

    const paid = await customer("0170000011");
    const sold = await sellMembership({
      venueId: members,
      holderName: "Paid Member",
      holderPhone: "0170000011",
      startsOn: todayISO(),
      expiresOn: addDays(todayISO(), 30),
      price: 150,
      adminId: ownerId,
      // Linked to the account at the counter: a membership on the number alone is not this account's.
      userId: paid.id,
    });
    expect(sold.ok).toBe(true);
    expect(await accessRefusal(members, paid.id)).toBeNull();
    // Another account that typed the same number in is not a member.
    expect(await accessRefusal(members, (await customer("0170000011")).id)).toMatchObject({ code: "MEMBERS_ONLY" });

    const listed = await customer("0170000012");
    await addAccess(members, [{ phone: "0170000012", kind: "member", label: "M-0042" }], ownerId);
    expect(await accessRefusal(members, listed.id)).toBeNull();
  });

  it("at a private venue: the list only, with guests until their end date", async () => {
    const guest = await customer("0170000020");
    await addAccess(privateVenue, [{ phone: "0170000020", kind: "guest", expiresOn: addDays(todayISO(), -1) }], ownerId);
    expect(await accessRefusal(privateVenue, guest.id)).toMatchObject({ code: "PRIVATE_VENUE" });
    await addAccess(privateVenue, [{ phone: "0170000020", kind: "guest", expiresOn: addDays(todayISO(), 3) }], ownerId);
    expect(await accessRefusal(privateVenue, guest.id)).toBeNull();
  });

  it("counts only a checked number where this site checks numbers", async () => {
    const r = await customer("0170000030");
    await addAccess(privateVenue, [{ phone: "0170000030" }], ownerId);
    process.env.MYSENAM_PHONE_CHECK = "on";
    expect(await accessRefusal(privateVenue, r.id)).toMatchObject({ code: "PRIVATE_VENUE" });
    await getDb().prepare("UPDATE users SET verified_phone = ? WHERE id = ?").run("60170000030", r.id);
    expect(await accessRefusal(privateVenue, r.id)).toBeNull();
  });

  it("is refused through the booking endpoint for anybody not let in", async () => {
    const post = (cookie?: string, phone = "0170000040") =>
      book(
        new NextRequest("http://localhost/api/bookings", {
          method: "POST",
          headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
          body: JSON.stringify({ courtId: privateCourt, date, hours: [10], name: "Somebody", phone }),
        })
      );
    const anonymous = await post();
    expect(anonymous.status).toBe(409);
    expect(await anonymous.json()).toMatchObject({ code: "PRIVATE_SIGN_IN" });

    const resident = await customer("0170000041");
    await addAccess(privateVenue, [{ phone: "0170000041" }], ownerId);
    const ok = await post(resident.cookie, "0170000041");
    expect(ok.status).toBe(201);
  });
});

describe("the list", () => {
  it("updates a number already on it rather than doubling it, and needs an end date for a guest", async () => {
    const before = (await accessList(privateVenue)).length;
    expect(await addAccess(privateVenue, [{ phone: "017-000 0002", name: "Aisyah Rahman" }], ownerId)).toEqual({ ok: true, added: 0, updated: 1 });
    expect((await accessList(privateVenue)).length).toBe(before);
    expect((await accessList(privateVenue)).find((e) => e.label === "A-12-3")).toMatchObject({ name: "Aisyah Rahman", hasAccount: true });
    expect(await addAccess(privateVenue, [{ phone: "0170000099", kind: "guest" }], ownerId)).toMatchObject({ ok: false });
    expect(await addAccess(privateVenue, [{ phone: "12" }], ownerId)).toMatchObject({ ok: false });
  });

  it("reads lines pasted from a spreadsheet, skipping a header", () => {
    expect(parseAccessLines("Phone,Name,Unit\n0123456789, Aisyah, A-1\n0198765432\t Lee\n\n", "resident", null)).toEqual([
      { phone: "0123456789", name: "Aisyah", label: "A-1", kind: "resident", expiresOn: null },
      { phone: "0198765432", name: "Lee", label: null, kind: "resident", expiresOn: null },
    ]);
  });

  it("is kept by the venue's own staff", async () => {
    const desk = await createAdmin({ name: "Desk", email: "vis-desk@venue.my", password: "desk-password-1", venueId: members });
    if (!desk.ok) throw new Error(desk.error);
    const cookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.admin.id)).token}`;
    const post = (body: unknown, as = cookie) =>
      accessPost(new NextRequest("http://localhost/api/admin/venue-access", { method: "POST", headers: { cookie: as }, body: JSON.stringify(body) }));

    expect((await post({ venueId: privateVenue, action: "add", phone: "0123456789" })).status).toBe(403);
    const imported = await post({ venueId: members, action: "import", text: "0123000001, A\n0123000002, B", kind: "member" });
    expect(await imported.json()).toMatchObject({ added: 2, updated: 0 });
    const saved = await post({ venueId: members, action: "settings", access: "members", listed: false, note: "RM150 a year" });
    expect((await saved.json()).settings).toEqual({ access: "members", listed: false, note: "RM150 a year" });
    expect((await post({ venueId: members, action: "settings", access: "secret" })).status).toBe(400);
    const got = await accessGet(new NextRequest(`http://localhost/api/admin/venue-access?venueId=${members}`, { headers: { cookie: ownerCookie } }));
    expect((await got.json()).list.length).toBeGreaterThanOrEqual(3);
    // The door-code log keeps its own address: this list must not take it over.
    const { GET: doorLog } = await import("../src/app/api/admin/access/route");
    const reveals = await doorLog(new NextRequest(`http://localhost/api/admin/access?venueId=${members}`, { headers: { cookie: ownerCookie } }));
    expect(await reveals.json()).toHaveProperty("reveals");
  });
});
