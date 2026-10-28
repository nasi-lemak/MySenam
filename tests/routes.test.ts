/// <reference types="vite/client" />
import { beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { NextRequest } from "next/server";
import {
  ADMIN_SESSION_COOKIE,
  createAdmin,
  createAdminSession,
  ensureBootstrapAdmin,
  listAdmins,
} from "../src/lib/admin-auth";
import { SESSION_COOKIE, createSession, registerUser } from "../src/lib/auth";
import { createVenue, listVenues } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { MAX_HOURS_PER_BOOKING } from "../src/lib/types";

/**
 * The authorisation surface, exercised rather than trusted.
 *
 * Everything below was previously verified by hand with curl against a running
 * server — which proved it worked that afternoon and nothing since. These are
 * the checks that stop a later change quietly reopening a door, and the sweep
 * at the top covers routes that do not exist yet: a new admin endpoint added
 * without `requireAdmin` fails here without anybody remembering to add a test.
 */

type Handler = (req: NextRequest, ctx?: unknown) => Response | Promise<Response>;
type RouteModule = () => Promise<unknown>;
type Routish = Record<string, unknown>;

let ownerToken: string;
let deskToken: string;
let ownVenue: number;
let otherVenue: number;
let userToken: string;

function req(path: string, opts: { cookie?: string; method?: string; body?: unknown } = {}) {
  const method = opts.method ?? "GET";
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.cookie) headers.cookie = opts.cookie;
  // A GET may not carry a body, so the sweep sends one only where it can.
  const body = method === "GET" || opts.body === undefined ? {} : { body: JSON.stringify(opts.body) };
  return new NextRequest(`http://localhost${path}`, { method, headers, ...body });
}

const asOwner = (c = ownerToken) => `${ADMIN_SESSION_COOKIE}=${c}`;
const asDesk = () => `${ADMIN_SESSION_COOKIE}=${deskToken}`;
const asCustomer = () => `${SESSION_COOKIE}=${userToken}`;

beforeAll(async () => {
  await ensureBootstrapAdmin();
  const owner = (await listAdmins()).find((a) => a.venueId === null)!;
  ownerToken = (await createAdminSession(owner.id)).token;

  ownVenue = (await listVenues())[0].id;
  const second = await createVenue({
    name: "Somebody Else's Courts",
    area: "Klang",
    address: "1 Jalan Lain",
    phone: "+60 3-9999 9999",
  });
  otherVenue = second.ok ? second.venue.id : (await listVenues())[1].id;

  const desk = await createAdmin({
    name: "Front Desk",
    email: "desk-routes@example.com",
    password: "desk-password",
    venueId: ownVenue,
  });
  if (!desk.ok) throw new Error(desk.error);
  deskToken = (await createAdminSession(desk.admin.id)).token;

  const user = await registerUser({
    name: "Route Customer",
    email: "routes@example.com",
    phone: "0191111111",
    password: "correct horse battery",
  });
  if (!user.ok) throw new Error(user.error);
  userToken = (await createSession(user.user.id)).token;
});

/* ---------------- The sweep ---------------- */

const adminRoutes = import.meta.glob("../src/app/api/admin/**/route.ts");
const customerRoutes = import.meta.glob("../src/app/api/my/**/route.ts");

/** A URL with the query parameters the busier routes expect, so a 400 for a
 *  missing parameter never masks a missing authorisation check. */
function urlFor(file: string): string {
  const path = file.replace("../src/app/api", "").replace("/route.ts", "");
  const params = new URLSearchParams({
    venueId: "1",
    date: todayISO(),
    from: todayISO(),
    to: todayISO(),
    start: todayISO(),
    code: "MS-ABC123",
    q: "someone",
  });
  return `/api${path.replace(/\[[^\]]+\]/g, "1")}?${params}`;
}

describe("every admin route refuses a stranger", () => {
  it("has routes to check", () => {
    expect(Object.keys(adminRoutes).length).toBeGreaterThan(20);
  });

  for (const [file, load] of Object.entries(adminRoutes) as [string, RouteModule][]) {
    // Signing in is the one admin route that must answer an unauthenticated
    // caller; it has its own rate-limit and password checks.
    if (file.includes("/auth/")) continue;

    it(`${file.replace("../src/app/api", "")} is closed to nobody in particular`, async () => {
      const mod = (await load()) as Routish;
      const methods = ["GET", "POST", "PUT", "PATCH", "DELETE"].filter((m) => typeof mod[m] === "function");
      expect(methods.length).toBeGreaterThan(0);

      for (const method of methods) {
        const res = await (mod[method] as Handler)(req(urlFor(file), { method, body: {} }), {
          params: Promise.resolve({ id: "1" }),
        });
        // Never a 2xx, and never a redirect to somewhere useful either.
        expect(
          res.status,
          `${method} ${file} answered ${res.status} to an anonymous caller`
        ).toBeGreaterThanOrEqual(400);
        expect(res.status).toBe(401);
      }
    });
  }
});

describe("every my/ route refuses a stranger", () => {
  for (const [file, load] of Object.entries(customerRoutes) as [string, RouteModule][]) {
    it(`${file.replace("../src/app/api", "")} needs a session`, async () => {
      const mod = (await load()) as Routish;
      for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
        if (typeof mod[method] !== "function") continue;
        const res = await (mod[method] as Handler)(req(urlFor(file), { method, body: {} }), {
          params: Promise.resolve({ id: "1" }),
        });
        expect(res.status, `${method} ${file}`).toBe(401);
      }
    });
  }
});

/* ---------------- The venue boundary ---------------- */

describe("a venue operator cannot reach another venue", () => {
  const venueScoped: [string, () => Promise<Routish>][] = [
    ["reports", () => import("../src/app/api/admin/reports/route")],
    ["occupancy", () => import("../src/app/api/admin/occupancy/route")],
    ["slots", () => import("../src/app/api/admin/slots/route")],
    ["access", () => import("../src/app/api/admin/access/route")],
    ["inductions", () => import("../src/app/api/admin/inductions/route")],
    ["hire", () => import("../src/app/api/admin/hire/route")],
    ["passes", () => import("../src/app/api/admin/passes/route")],
    ["promos", () => import("../src/app/api/admin/promos/route")],
    ["memberships", () => import("../src/app/api/admin/memberships/route")],
    ["classes", () => import("../src/app/api/admin/classes/route")],
    ["messages", () => import("../src/app/api/admin/messages/route")],
    ["online-payments", () => import("../src/app/api/admin/online-payments/route")],
  ];

  for (const [name, load] of venueScoped) {
    it(`${name}: its own venue yes, the other one no`, async () => {
      const mod = await load();
      const query = (venueId: number) =>
        `/api/admin/${name}?venueId=${venueId}&date=${todayISO()}&from=${todayISO()}&to=${todayISO()}&start=${todayISO()}`;

      const GET = mod.GET as Handler;
      const mine = await GET(req(query(ownVenue), { cookie: asDesk() }));
      expect(mine.status, `${name} refused its own venue`).toBe(200);

      const theirs = await GET(req(query(otherVenue), { cookie: asDesk() }));
      expect(theirs.status, `${name} leaked another venue`).toBe(403);

      // The platform owner sees both.
      expect((await GET(req(query(otherVenue), { cookie: asOwner() }))).status).toBe(200);
    });
  }
});

describe("a venue operator cannot resend another venue's message", () => {
  it("refuses a message id belonging to the other venue", async () => {
    const { enqueue } = await import("../src/lib/outbox");
    const theirs = await enqueue({
      venueId: otherVenue,
      kind: "booking_confirmed",
      channel: "whatsapp",
      recipient: "0123456789",
      body: "msg.confirmed",
      vars: {},
    });
    const mod = await import("../src/app/api/admin/messages/route");
    const res = await mod.POST(
      req("/api/admin/messages", {
        method: "POST",
        cookie: asDesk(),
        body: { id: theirs.id },
      })
    );
    expect(res.status, "a venue operator resent another venue's message").toBe(403);
  });
});

/* ---------------- Owner-only ---------------- */

describe("whole-platform routes are the owner's alone", () => {
  const ownerOnly: [string, () => Promise<Routish>][] = [
    ["backup", () => import("../src/app/api/admin/backup/route")],
    ["retention", () => import("../src/app/api/admin/retention/route")],
    ["demo", () => import("../src/app/api/admin/demo/route")],
  ];

  // A branch manager looks after their own branch's front desk (audit R8 X1-14; tests/staff-accounts.test.ts): they
  // see that branch's staff and nobody else's, the platform owner included.
  it("admins shows a branch manager their own branch's staff only", async () => {
    const { GET } = await import("../src/app/api/admin/admins/route");
    const mine = await GET(req("/api/admin/admins", { cookie: asDesk() }));
    expect(mine.status).toBe(200);
    const { admins } = (await mine.json()) as { admins: { venueId: number | null }[] };
    expect(admins.length).toBeGreaterThan(0);
    expect(admins.every((a) => a.venueId === ownVenue)).toBe(true);
    expect((await GET(req("/api/admin/admins", { cookie: asOwner() }))).status).toBe(200);
  });

  for (const [name, load] of ownerOnly) {
    it(`${name} is refused to a venue operator`, async () => {
      const mod = await load();
      const GET = mod.GET as Handler;
      const denied = await GET(req(`/api/admin/${name}`, { cookie: asDesk() }));
      expect(denied.status, `${name} let a venue operator in`).toBe(403);
      expect((await GET(req(`/api/admin/${name}`, { cookie: asOwner() }))).status).toBe(200);
    });
  }

  it("does not let a venue operator seed demo data over a real venue", async () => {
    const mod = await import("../src/app/api/admin/demo/route");
    expect((await mod.POST(req("/api/admin/demo", { method: "POST" }))).status).toBe(401);
    expect(
      (await mod.POST(req("/api/admin/demo", { method: "POST", cookie: asDesk() }))).status
    ).toBe(403);
  });
});

/* ---------------- One customer's data is their own ---------------- */

describe("a customer reaches their own data and no further", () => {
  it("exports for the session holder, and refuses without one", async () => {
    const mod = await import("../src/app/api/my/data/route");
    expect((await mod.GET(req("/api/my/data"))).status).toBe(401);

    const mine = await mod.GET(req("/api/my/data", { cookie: asCustomer() }));
    expect(mine.status).toBe(200);
    const body = await mine.json();
    expect(body.account.email).toBe("routes@example.com");
    // A stale or invented token is nobody.
    expect(
      (await mod.GET(req("/api/my/data", { cookie: `${SESSION_COOKIE}=not-a-real-token` }))).status
    ).toBe(401);
  });

  it("will not close an account on a typo", async () => {
    const mod = await import("../src/app/api/my/erase/route");
    const res = await mod.POST(
      req("/api/my/erase", { method: "POST", cookie: asCustomer(), body: { confirm: "yes" } })
    );
    expect(res.status).toBe(400);
  });
});

/* ---------------- The door ---------------- */

describe("the public door-code route", () => {
  it("never answers without both a code and the phone that booked it", async () => {
    const mod = await import("../src/app/api/access/route");
    for (const body of [{}, { code: "MS-ABC123" }, { phone: "0191111111" }]) {
      const res = await mod.POST(req("/api/access", { method: "POST", body }));
      expect(res.status).toBe(400);
    }
    // A well-formed guess for a booking that is not theirs is a flat 404,
    // with nothing in it to tell them which half was wrong.
    const guess = await mod.POST(
      req("/api/access", { method: "POST", body: { code: "MS-ZZZZZZ", phone: "0190000000" } })
    );
    expect(guess.status).toBe(404);
    expect((await guess.json()).error).not.toContain("phone number is");
  });
});

/* ---------------- Refusals carry their name ---------------- */

describe("a refused request says which refusal it was", () => {
  it("names the refusal and what it quotes, so the page can say it in Malay", async () => {
    const mod = await import("../src/app/api/bookings/route");
    const court = (await listVenues())[0].courts.find((c) => c.capacity === 1)!;
    const res = await mod.POST(
      req("/api/bookings", {
        method: "POST",
        body: {
          courtId: court.id,
          date: addDays(todayISO(), 2),
          // More hours than any booking may hold.
          hours: [9, 10, 11, 12, 13, 14, 15],
          name: "Nurul Hana",
          phone: "0161234567",
        },
      })
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("MAX_HOURS");
    expect(body.vars).toEqual({ max: MAX_HOURS_PER_BOOKING });
    // The English sentence still goes out, so anything reading it keeps working.
    expect(body.error).toBe(`Maximum ${MAX_HOURS_PER_BOOKING} hours per booking.`);
  });

  it("names a refusal that quotes nothing, and sends no empty vars", async () => {
    const mod = await import("../src/app/api/bookings/cancel/route");
    const res = await mod.POST(
      req("/api/bookings/cancel", {
        method: "POST",
        body: { code: "MS-NOPE00", phone: "0123456789" },
      })
    );
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.code).toBe("BOOKING_NOT_FOUND_CODE");
    expect(body.vars).toBeUndefined();
  });
});
