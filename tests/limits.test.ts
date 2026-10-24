import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

// The booking route reads the customer's language from a cookie.
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

const sent: { to: string; subject: string }[] = [];
// Emails to staff, applicants and account holders are queued (lib/outbox.ts, emailPlain); each one queued is also noted here.
vi.mock("../src/lib/outbox", async (original) => {
  const real = await original<typeof import("../src/lib/outbox")>();
  return {
    ...real,
    emailPlain: async (input: Parameters<typeof real.emailPlain>[0]) => {
      const queued = await real.emailPlain(input);
      sent.push({ to: input.to, subject: input.subject });
      return queued;
    },
  };
});

import { NextRequest } from "next/server";
import {
  ADMIN_SESSION_COOKIE,
  createAdmin,
  createAdminSession,
  ensureBootstrapAdmin,
} from "../src/lib/admin-auth";
import { getDb } from "../src/lib/db";
import { PHONE_LIMITS } from "../src/lib/limits";
import { enqueue, MESSAGES_PER_RECIPIENT_PER_DAY } from "../src/lib/outbox";
import { resetRateLimits } from "../src/lib/rate-limit";
import { createCourt, createVenue, listVenuePage, listVenues, setPaymentStatus } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * What stops somebody holding a venue's courts, or anybody's phone, with a
 * script and a list of made-up names.
 */

let venueA: number;
let courtsA: number[] = [];
let courtsB: number[] = [];
let courtsC: number[] = [];
let operatorCookie: string;
let n = 0;

const json = (path: string, body: object, cookie?: string) =>
  new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: JSON.stringify(body),
  });

/** Book through the public route, as a customer would. */
async function book(courtId: number, phone: string, extra: object = {}) {
  const { POST } = await import("../src/app/api/bookings/route");
  n++;
  const res = await POST(
    json("/api/bookings", {
      courtId,
      date: addDays(todayISO(), 1 + (n % 10)),
      hours: [8 + (n % 12)],
      name: `Customer ${n}`,
      phone,
      ...extra,
    })
  );
  return { status: res.status, body: await res.json() };
}

async function courts(venueId: number, count: number) {
  const ids: number[] = [];
  for (let i = 0; i < count; i++) {
    const c = await createCourt({ venueId, name: `Court ${i + 1}`, sport: "badminton", offPeakRate: 10, peakRate: 10 });
    if (!c.ok) throw new Error("court");
    ids.push(c.court.id);
  }
  return ids;
}

beforeAll(async () => {
  await ensureBootstrapAdmin();
  const a = await createVenue({ name: "Limit Hall A", area: "Klang", address: "Jalan A", phone: "0300000001" });
  const b = await createVenue({ name: "Limit Hall B", area: "Klang", address: "Jalan B", phone: "0300000002" });
  const c = await createVenue({ name: "Limit Hall C", area: "Klang", address: "Jalan C", phone: "0300000004" });
  if (!a.ok || !b.ok || !c.ok) throw new Error("venue");
  venueA = a.venue.id;
  courtsA = await courts(venueA, 4);
  courtsB = await courts(b.venue.id, 4);
  courtsC = await courts(c.venue.id, 1);
  const op = await createAdmin({ name: "Op", email: "op-limits@example.my", password: "op-password-1", venueId: venueA });
  if (!op.ok) throw new Error(op.error);
  operatorCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(op.admin.id)).token}`;
});

// The per-address rate limit is its own test; here it would only get in the way.
beforeEach(() => resetRateLimits());

describe("unpaid bookings on one number", () => {
  it(`stop at ${PHONE_LIMITS.venue} coming up at one venue, however the number is written`, async () => {
    const written = ["0171111111", "017-111 1111", "+60 17-111 1111"];
    for (const [i, phone] of written.entries()) expect((await book(courtsA[i], phone)).status).toBe(201);
    const refused = await book(courtsA[3], "60171111111");
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe("PHONE_LIMIT_VENUE");
  });

  it("free a place when one is paid for", async () => {
    const code = (
      await getDb()
        .prepare("SELECT code FROM bookings WHERE phone_key = '0171111111' ORDER BY id LIMIT 1")
        .get()
    ) as { code: string };
    await setPaymentStatus(code.code, true);
    expect((await book(courtsA[3], "0171111111")).status).toBe(201);
  });

  it(`stop at ${PHONE_LIMITS.platform} across every venue`, async () => {
    const phone = "0172222222";
    for (let i = 0; i < 3; i++) expect((await book(courtsA[i], phone)).status).toBe(201);
    for (let i = 0; i < 3; i++) expect((await book(courtsB[i], phone)).status).toBe(201);
    // A third venue, where this number has nothing yet: the platform-wide limit.
    const refused = await book(courtsC[0], phone);
    expect(refused.body.code).toBe("PHONE_LIMIT_ALL");
  });

  it("take an account to book the same slot every week", async () => {
    const refused = await book(courtsB[0], "0173333333", { weeks: 4 });
    expect(refused.body.code).toBe("SERIES_NEEDS_ACCOUNT");
  });
});

describe("a number a venue has refused", () => {
  const blocks = (method: "POST" | "DELETE", body: object) =>
    import("../src/app/api/admin/venues/[id]/blocked-phones/route").then((r) =>
      r[method](
        new NextRequest(`http://localhost/api/admin/venues/${venueA}/blocked-phones`, {
          method,
          headers: { "content-type": "application/json", cookie: operatorCookie },
          body: JSON.stringify(body),
        }),
        { params: Promise.resolve({ id: String(venueA) }) }
      )
    );

  it("cannot book or queue there online, but can elsewhere", async () => {
    const res = await blocks("POST", { phone: "+60 18-444 4444", reason: "Books every night, never comes" });
    expect(res.status).toBe(200);
    expect((await res.json()).blocked[0].reason).toBe("Books every night, never comes");

    const refused = await book(courtsA[0], "0184444444");
    expect(refused.body.code).toBe("PHONE_BLOCKED");

    const { POST } = await import("../src/app/api/waitlist/route");
    const queued = await POST(
      json("/api/waitlist", {
        courtId: courtsA[0],
        date: addDays(todayISO(), 3),
        startHour: 10,
        endHour: 11,
        name: "Blocked",
        phone: "0184444444",
      })
    );
    expect((await queued.json()).code).toBe("PHONE_BLOCKED");

    expect((await book(courtsB[0], "0184444444")).status).toBe(201);
  });

  it("can be let back in", async () => {
    expect((await blocks("DELETE", { phone: "018-444 4444" })).status).toBe(200);
    expect((await book(courtsA[1], "0184444444")).status).toBe(201);
  });

  it("is only blocked by the venue's own staff", async () => {
    const other = (await listVenues()).find((v) => v.id !== venueA)!;
    const { POST } = await import("../src/app/api/admin/venues/[id]/blocked-phones/route");
    const res = await POST(
      new NextRequest(`http://localhost/api/admin/venues/${other.id}/blocked-phones`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie: operatorCookie },
        body: JSON.stringify({ phone: "0185555555" }),
      }),
      { params: Promise.resolve({ id: String(other.id) }) }
    );
    expect(res.status).toBe(403);
  });
});

describe("messages to one recipient", () => {
  it(`stop after ${MESSAGES_PER_RECIPIENT_PER_DAY} a day, and say why`, async () => {
    const statuses: string[] = [];
    for (let i = 0; i <= MESSAGES_PER_RECIPIENT_PER_DAY; i++) {
      const message = await enqueue({
        venueId: venueA,
        kind: "booking_cancelled",
        channel: "whatsapp",
        // The same stranger's phone, written differently each time.
        recipient: i % 2 ? "+60 19-666 6666" : "0196666666",
        body: "msg.cancelled.body",
        vars: { name: "X", code: `C${i}`, venue: "V", date: "d", time: "t" },
      } as unknown as Parameters<typeof enqueue>[0]);
      statuses.push(message.status);
    }
    expect(statuses.slice(0, MESSAGES_PER_RECIPIENT_PER_DAY).every((s) => s === "queued")).toBe(true);
    expect(statuses.at(-1)).toBe("abandoned");
  });
});

describe("the order venues are listed in", () => {
  it("is not alphabetical, and holds still all day", async () => {
    const first = (await listVenuePage({ pageSize: 100 })).venues.map((v) => v.id);
    const again = (await listVenuePage({ pageSize: 100 })).venues.map((v) => v.id);
    expect(again).toEqual(first);
    // An "AAA" name buys nothing.
    const aaa = await createVenue({ name: "AAA Top Courts", area: "Klang", address: "Jalan C", phone: "0300000003" });
    if (!aaa.ok) throw new Error("venue");
    await courts(aaa.venue.id, 1);
    const names = (await listVenuePage({ pageSize: 100 })).venues.map((v) => v.name);
    expect(names).not.toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });
});

describe("a venue renamed by its operator", () => {
  it("is reported to the platform owner", async () => {
    sent.length = 0;
    const { PATCH } = await import("../src/app/api/admin/venues/[id]/route");
    const res = await PATCH(
      new NextRequest(`http://localhost/api/admin/venues/${venueA}`, {
        method: "PATCH",
        headers: { "content-type": "application/json", cookie: operatorCookie },
        body: JSON.stringify({ name: "AAA Best Courts" }),
      }),
      { params: Promise.resolve({ id: String(venueA) }) }
    );
    expect(res.status).toBe(200);
    expect(sent.some((m) => m.subject === "Limit Hall A is now called AAA Best Courts")).toBe(true);
  });
});

describe("a sign-up form filled in by a script", () => {
  it("makes no account", async () => {
    const { POST } = await import("../src/app/api/auth/register/route");
    const res = await POST(
      json("/api/auth/register", {
        name: "Bot",
        email: "bot@example.com",
        phone: "0197777777",
        password: "bot-password-1",
        website: "http://spam.example",
      })
    );
    expect(res.status).toBe(400);
    expect(await getDb().prepare("SELECT 1 FROM users WHERE email = 'bot@example.com'").get()).toBeUndefined();
  });
});
