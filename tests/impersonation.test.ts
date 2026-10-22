import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { NextRequest } from "next/server";
import { SESSION_COOKIE, createSession, registerUser } from "../src/lib/auth";
import { authenticateAdmin, ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { issuePass, listVenues, sellMembership } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * A phone number is not identity.
 *
 * Nothing verifies the number somebody types when they register (a phone
 * check is a separate, later step) — the docs say so, the privacy notice says so, and the PDPA export path was already
 * fixed for exactly this. Anything a signed-in customer is shown about
 * themselves therefore has to be found by who they are, not by what they
 * typed. A pass code is bearer money: whoever reads it can spend it, because
 * paying with a pass asks for the code and the booking's phone number, both of
 * which a stranger would then have.
 */

const VICTIM_PHONE = "0191112222";
let venueId: number;
let adminId: number;
let attackerCookie: string;
let ownerCookie: string;

const req = (path: string, cookie: string) =>
  new NextRequest(`http://localhost${path}`, { headers: { cookie } });

beforeAll(async () => {
  await ensureBootstrapAdmin();
  adminId = (await authenticateAdmin("admin@mysenam.my", "mysenam-admin"))!.id;
  venueId = (await listVenues())[0].id;

  // Sold at the counter, to somebody standing there, against their number.
  expect(
    (await issuePass({
      venueId,
      name: "20-entry gym pass",
      sport: null,
      entries: 20,
      price: 300,
      holderName: "Nurul Hana",
      holderPhone: VICTIM_PHONE,
      expiresOn: addDays(todayISO(), 180),
      adminId,
    })).ok
  ).toBe(true);

  expect(
    (await sellMembership({
      venueId,
      holderName: "Nurul Hana",
      holderPhone: VICTIM_PHONE,
      startsOn: todayISO(),
      expiresOn: addDays(todayISO(), 180),
      price: 300,
      adminId,
    })).ok
  ).toBe(true);

  // Anybody may register with anybody's number. That is the premise.
  const attacker = await registerUser({
    name: "Not Nurul",
    email: "not-nurul@example.com",
    phone: VICTIM_PHONE,
    password: "a-password",
  });
  if (!attacker.ok) throw new Error(attacker.error);
  attackerCookie = `${SESSION_COOKIE}=${(await createSession(attacker.user.id)).token}`;

  const owner = await registerUser({
    name: "Real Owner",
    email: "real-owner@example.com",
    phone: "0197778888",
    password: "a-password",
  });
  if (!owner.ok) throw new Error(owner.error);
  ownerCookie = `${SESSION_COOKIE}=${(await createSession(owner.user.id)).token}`;
  expect(
    (await issuePass({
      venueId,
      name: "10-hour badminton pass",
      sport: "badminton",
      entries: 10,
      price: 150,
      holderName: "Real Owner",
      holderPhone: "0197778888",
      userId: owner.user.id,
      expiresOn: addDays(todayISO(), 180),
      adminId,
    })).ok
  ).toBe(true);
});

describe("registering with somebody else's phone number", () => {
  it("does not hand over the pass codes bought against it", async () => {
    const mod = await import("../src/app/api/my/passes/route");
    const body = await (await mod.GET(req("/api/my/passes", attackerCookie))).json();
    expect(body.passes, "a stranger was handed somebody else's pass code").toEqual([]);
  });

  it("does not hand over the memberships bought against it", async () => {
    const mod = await import("../src/app/api/my/membership/route");
    const body = await (await mod.GET(req("/api/my/membership", attackerCookie))).json();
    expect(body.memberships).toEqual([]);
  });

  /**
   * Not a leak, and deliberately left alone — but worth pinning so that
   * changing it is a decision rather than an accident.
   *
   * A membership is held against a phone number on purpose: the docs say a
   * member who books as a guest, without signing in, still gets their price.
   * That means anyone who types a member's number gets the member rate, signed
   * in or not, and this test only shows the same thing through the account
   * page. The cost is the difference between two rates, the benefit is that a
   * member never has to remember a login — a trade the venue made, not a hole
   * in the software. Pass codes are different, which is why those moved.
   */
  it("does get the member rate, because a membership is held against the number", async () => {
    const mod = await import("../src/app/api/availability/route");
    const path = `/api/availability?venueId=${venueId}&date=${addDays(todayISO(), 2)}&sport=badminton`;
    const body = await (await mod.GET(req(path, attackerCookie))).json();
    expect(body.memberRates).toBe(true);
  });
});

describe("a customer's own account", () => {
  it("still shows what is filed against it", async () => {
    const mod = await import("../src/app/api/my/passes/route");
    const body = await (await mod.GET(req("/api/my/passes", ownerCookie))).json();
    expect(body.passes).toHaveLength(1);
    expect(body.passes[0].name).toBe("10-hour badminton pass");
  });
});

describe("the counter linking a sale to an account", () => {
  it("puts the pass on that account's page", async () => {
    const mod = await import("../src/app/api/admin/passes/route");
    const { ADMIN_SESSION_COOKIE, createAdminSession } = await import("../src/lib/admin-auth");
    const cookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(adminId)).token}`;

    const sold = await mod.POST(
      new NextRequest("http://localhost/api/admin/passes", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          venueId,
          name: "Linked at the counter",
          entries: 5,
          price: 75,
          holderName: "Real Owner",
          holderPhone: "0197778888",
          expiresOn: addDays(todayISO(), 90),
          accountEmail: "real-owner@example.com",
        }),
      })
    );
    expect(sold.status).toBe(201);

    const mine = await import("../src/app/api/my/passes/route");
    const body = await (await mine.GET(req("/api/my/passes", ownerCookie))).json();
    expect(body.passes.map((p: { name: string }) => p.name)).toContain("Linked at the counter");
  });

  it("refuses an email no account holds, rather than selling it unlinked", async () => {
    const mod = await import("../src/app/api/admin/passes/route");
    const { ADMIN_SESSION_COOKIE, createAdminSession } = await import("../src/lib/admin-auth");
    const cookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(adminId)).token}`;

    const res = await mod.POST(
      new NextRequest("http://localhost/api/admin/passes", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({
          venueId,
          name: "Typo pass",
          entries: 5,
          price: 75,
          holderName: "Somebody",
          holderPhone: "0191230000",
          expiresOn: addDays(todayISO(), 90),
          accountEmail: "typo@example.com",
        }),
      })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("No account has that email");
  });
});
