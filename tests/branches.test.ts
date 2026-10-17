import { afterEach, beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_MARKETPLACE = "on";

import { NextRequest } from "next/server";
import {
  ADMIN_SESSION_COOKIE,
  authenticateAdmin,
  createAdmin,
  createAdminSession,
  ensureBootstrapAdmin,
  getAdminByToken,
  listAdmins,
} from "../src/lib/admin-auth";
import type { Admin } from "../src/lib/admin-auth";
import { approveApplication, requestBranch, submitApplication } from "../src/lib/applications";
import { registerUser } from "../src/lib/auth";
import { groupIntoBusiness, listBusinesses } from "../src/lib/branches";
import { venueCreditLiability } from "../src/lib/reports";
import {
  createBooking,
  createCourt,
  createVenue,
  getWalletBalance,
  issuePass,
  payBookingFromWallet,
  payBookingWithPass,
  topUpWallet,
  walletBalances,
} from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * A business with several branches: one sign-in for all of them, credit and
 * passes that work at any of them, and nothing of anybody else's.
 */

let ownerId: number;
let manager: Admin;
let branchA: number;
let branchB: number;
let elsewhere: number;
let n = 0;

const cookieFor = async (adminId: number) =>
  `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(adminId)).token}`;

/** The admin as a fresh request would see them, branches and all. */
async function reload(admin: Admin): Promise<Admin> {
  return (await getAdminByToken((await createAdminSession(admin.id)).token))!;
}

async function court(venueId: number, sport = "badminton") {
  const c = await createCourt({ venueId, name: `Court ${++n}`, sport: sport as "badminton", offPeakRate: 10, peakRate: 10 });
  if (!c.ok) throw new Error("court");
  return c.court.id;
}

beforeAll(async () => {
  await ensureBootstrapAdmin();
  ownerId = (await listAdmins())[0].id;
  const applied = await submitApplication({
    businessName: "Smash Chain Kelana",
    area: "Kelana Jaya",
    address: "1 Jalan SS7, Kelana Jaya",
    venuePhone: "0378000001",
    contactName: "Lim",
    email: "lim@smashchain.my",
    password: "a long enough password",
  });
  if (!applied.ok) throw new Error(applied.error);
  const approved = await approveApplication(applied.application.id, ownerId);
  if (!approved.ok) throw new Error(approved.error);
  branchA = approved.application.venueId!;
  manager = (await authenticateAdmin("lim@smashchain.my", "a long enough password"))!;
  const other = await createVenue({ name: "Someone Else Hall", area: "Klang", address: "Jalan Lain", phone: "0330000009" });
  if (!other.ok) throw new Error("venue");
  elsewhere = other.venue.id;
});

afterEach(() => {
  delete process.env.MYSENAM_AUTO_APPROVE_BRANCHES;
});

describe("a business's branches", () => {
  it("start with the business the first application made", () => {
    expect(manager.businessName).toBe("Smash Chain Kelana");
    expect(manager.venueIds).toEqual([branchA]);
  });

  it("grow by request, approved by the platform owner", async () => {
    const asked = await requestBranch(manager, {
      name: "Smash Chain Subang",
      area: "Subang Jaya",
      address: "2 Jalan SS15, Subang",
      phone: "0378000002",
    });
    if (!asked.ok) throw new Error(asked.error);
    expect(asked.application.status).toBe("pending");
    expect(asked.application.forBusiness).toBe("Smash Chain Kelana");

    const approved = await approveApplication(asked.application.id, ownerId);
    if (!approved.ok) throw new Error(approved.error);
    branchB = approved.application.venueId!;
    manager = await reload(manager);
    expect(manager.venueIds).toEqual([branchA, branchB]);
  });

  it("can be approved on their own where the install says so", async () => {
    process.env.MYSENAM_AUTO_APPROVE_BRANCHES = "on";
    const asked = await requestBranch(manager, {
      name: "Smash Chain Puchong",
      area: "Puchong",
      address: "3 Jalan Puchong",
      phone: "0378000003",
    });
    expect(asked.ok && asked.approved).toBe(true);
    expect((await reload(manager)).venueIds).toHaveLength(3);
  });

  it("are asked for only by a manager", async () => {
    const staff = await createAdmin({ name: "Desk", email: "desk-a@smashchain.my", password: "desk-password", venueId: branchA });
    if (!staff.ok) throw new Error(staff.error);
    const asked = await requestBranch(staff.admin, { name: "Nope", area: "Nowhere", address: "Jalan Nope", phone: "0300000000" });
    expect(asked.ok).toBe(false);
  });
});

describe("one sign-in for every branch", () => {
  it("shows the day across the business's branches, and nobody else's", async () => {
    const date = addDays(todayISO(), 2);
    for (const venue of [branchA, branchB, elsewhere])
      expect((await createBooking({ courtId: await court(venue), date, hours: [10], name: "Day", phone: `01200000${venue}` })).ok).toBe(true);
    const { GET } = await import("../src/app/api/admin/bookings/route");
    const day = async (adminId: number) =>
      (await (
        await GET(new NextRequest(`http://localhost/api/admin/bookings?date=${date}`, { headers: { cookie: await cookieFor(adminId) } }))
      ).json()).bookings as { venueId: number }[];
    const managers = new Set((await day(manager.id)).map((b) => b.venueId));
    expect([...managers].sort()).toEqual([branchA, branchB].sort());
    const desk = (await listAdmins()).find((a) => a.email === "desk-a@smashchain.my")!;
    expect(new Set((await day(desk.id)).map((b) => b.venueId))).toEqual(new Set([branchA]));
  });

  it("lets a manager add staff to their branches, and only theirs", async () => {
    const { POST } = await import("../src/app/api/admin/admins/route");
    const add = async (body: object, adminId = manager.id) =>
      POST(
        new NextRequest("http://localhost/api/admin/admins", {
          method: "POST",
          headers: { "content-type": "application/json", cookie: await cookieFor(adminId) },
          body: JSON.stringify({ name: "New", password: "password-1234", ...body }),
        })
      );
    expect((await add({ email: "desk-b@smashchain.my", venueId: branchB })).status).toBe(201);
    expect((await add({ email: "co-manager@smashchain.my", businessId: manager.businessId })).status).toBe(201);
    expect((await add({ email: "sneaky@smashchain.my", venueId: elsewhere })).status).toBe(403);
    expect((await add({ email: "owner2@smashchain.my" })).status).toBe(403);
    // Branch staff manage nobody.
    const desk = (await listAdmins()).find((a) => a.email === "desk-a@smashchain.my")!;
    expect((await add({ email: "x@smashchain.my", venueId: branchA }, desk.id)).status).toBe(403);
  });

  it("never leaves a business without a manager", async () => {
    const { DELETE } = await import("../src/app/api/admin/admins/[id]/route");
    const remove = async (id: number, by: number) =>
      DELETE(new NextRequest(`http://localhost/api/admin/admins/${id}`, { method: "DELETE", headers: { cookie: await cookieFor(by) } }), {
        params: Promise.resolve({ id: String(id) }),
      });
    const co = (await listAdmins()).find((a) => a.email === "co-manager@smashchain.my")!;
    expect((await remove(co.id, manager.id)).status).toBe(200);
    // Now the only one: the owner cannot remove them either.
    expect((await remove(manager.id, ownerId)).status).toBe(409);
    // And a manager cannot reach the platform owner.
    expect((await remove(ownerId, manager.id)).status).toBe(403);
  });
});

describe("credit and passes", () => {
  it("bought at one branch, spend at another, and nowhere else", async () => {
    const made = await registerUser({ name: "Aina", email: "aina-branches@example.com", phone: "0191230000", password: "correct horse battery" });
    if (!made.ok) throw new Error(made.error);
    const user = made.user;
    expect((await topUpWallet({ userId: user.id, amount: 50, adminId: manager.id, venueId: branchA })).ok).toBe(true);

    expect(await getWalletBalance(user.id, branchB)).toBe(50);
    expect(await getWalletBalance(user.id, elsewhere)).toBe(0);

    const at = async (venueId: number) => {
      const b = await createBooking({ courtId: await court(venueId), date: addDays(todayISO(), 3), hours: [11], name: "Aina", phone: user.phone, userId: user.id });
      if (!b.ok) throw new Error(b.error);
      return b.booking;
    };
    expect((await payBookingFromWallet((await at(branchB)).id)).ok).toBe(true);
    expect((await payBookingFromWallet((await at(elsewhere)).id)).ok).toBe(false);

    // One pot, named for the business, and owed by it whichever branch asks.
    const pots = await walletBalances(user.id);
    expect(pots).toHaveLength(1);
    expect(pots[0]).toMatchObject({ venueName: "Smash Chain Kelana", balance: 40 });
    expect((await venueCreditLiability(branchA)).balance).toBe((await venueCreditLiability(branchB)).balance);
  });

  it("a pass sold at one branch is good at the others", async () => {
    const sold = await issuePass({
      venueId: branchA,
      sport: "badminton",
      name: "10 hours",
      entries: 10,
      price: 100,
      holderName: "Ravi",
      holderPhone: "0194560000",
      expiresOn: addDays(todayISO(), 60),
      adminId: manager.id,
    });
    if (!sold.ok) throw new Error(sold.error);
    const at = async (venueId: number) => {
      const b = await createBooking({ courtId: await court(venueId), date: addDays(todayISO(), 4), hours: [12], name: "Ravi", phone: "0194560000" });
      if (!b.ok) throw new Error(b.error);
      return b.booking.id;
    };
    expect((await payBookingWithPass(await at(branchB), sold.pass.code)).ok).toBe(true);
    expect((await payBookingWithPass(await at(elsewhere), sold.pass.code)).ok).toBe(false);
  });
});

describe("venues that joined one by one", () => {
  it("can be put together as one business, their operator made its manager", async () => {
    const x = await createVenue({ name: "Old Hall One", area: "Ipoh", address: "Jalan Ipoh 1", phone: "0500000001" });
    const y = await createVenue({ name: "Old Hall Two", area: "Ipoh", address: "Jalan Ipoh 2", phone: "0500000002" });
    if (!x.ok || !y.ok) throw new Error("venue");
    const op = await createAdmin({ name: "Old Op", email: "op@oldhall.my", password: "op-password-1", venueId: x.venue.id });
    if (!op.ok) throw new Error(op.error);

    const grouped = await groupIntoBusiness({ name: "Old Hall Group", venueIds: [x.venue.id, y.venue.id], managerIds: [op.admin.id] });
    expect(grouped.ok).toBe(true);
    const now = await reload(op.admin);
    expect(now.businessName).toBe("Old Hall Group");
    expect(now.venueIds).toEqual([x.venue.id, y.venue.id]);

    // A venue already in another business stays where it is, and the refusal
    // leaves no half-made business behind.
    expect((await groupIntoBusiness({ name: "Grab", venueIds: [branchA] })).ok).toBe(false);
    expect((await listBusinesses()).some((b) => b.name === "Grab")).toBe(false);
  });
});
