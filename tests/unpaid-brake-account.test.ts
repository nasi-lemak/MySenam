import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { createSession, registerUser, SESSION_COOKIE } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { PHONE_LIMITS } from "../src/lib/limits";
import { resetRateLimits } from "../src/lib/rate-limit";
import { createCourt, createVenue, setPaymentStatus } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * The unpaid-bookings brake counts by the signed-in account as well as by the typed number (ADR 0054): an account
 * cannot hold more unpaid bookings by typing a different number each time, and another account is not held to it.
 */

const courtIds: number[] = [];
let venueId: number;
let n = 0;

async function account(name: string) {
  const made = await registerUser({ name, email: `${name.toLowerCase()}@brake.test`, phone: `0171234${String(500 + ++n)}`, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  await getDb().prepare("UPDATE users SET phone_verified_at = datetime('now'), verified_phone = phone WHERE id = ?").run(made.user.id);
  return { ...made.user, cookie: `${SESSION_COOKIE}=${(await createSession(made.user.id)).token}` };
}

async function bookAs(who: { cookie: string; name: string }, courtId: number, phone: string, hour = 19) {
  resetRateLimits();
  const { POST } = await import("../src/app/api/bookings/route");
  return POST(
    new NextRequest("http://localhost/api/bookings", {
      method: "POST",
      headers: { "content-type": "application/json", cookie: who.cookie },
      body: JSON.stringify({ courtId, date: addDays(todayISO(), 2), hours: [hour], name: who.name, phone }),
    })
  );
}

beforeAll(async () => {
  const v = await createVenue({ name: "Brake Hall", area: "Klang", address: "Jalan B", phone: "0300000199" });
  if (!v.ok) throw new Error("venue");
  venueId = v.venue.id;
  for (let i = 0; i < 8; i++) {
    const c = await createCourt({ venueId, name: `Court ${i + 1}`, sport: "badminton", offPeakRate: 10, peakRate: 10 });
    if (!c.ok) throw new Error("court");
    courtIds.push(c.court.id);
  }
});

describe("the unpaid-bookings limit and a signed-in account", () => {
  it(`holds one account to ${PHONE_LIMITS.venue} unpaid bookings at a venue however many numbers it types`, async () => {
    const griefer = await account("Griefer");
    let created = 0;
    let refused: unknown = null;
    for (let i = 0; i < 8; i++) {
      const res = await bookAs(griefer, courtIds[i], `01712345${String(10 + i)}`);
      if (res.status === 201) created++;
      else refused = await res.json();
    }
    expect(created).toBe(PHONE_LIMITS.venue);
    expect(refused).toMatchObject({ code: "PHONE_LIMIT_VENUE" });
  });

  it("does not hold another account to it", async () => {
    const other = await account("Other");
    const res = await bookAs(other, courtIds[7], "0178888801", 21);
    expect(res.status).toBe(201);
  });

  it("frees a place when one of the unpaid bookings is paid", async () => {
    const who = await account("Payer");
    const codes: string[] = [];
    for (let i = 0; i < PHONE_LIMITS.venue; i++) {
      const res = await bookAs(who, courtIds[i], `0179999${String(100 + i)}`, 13);
      expect(res.status).toBe(201);
      codes.push(((await res.json()) as { booking: { code: string } }).booking.code);
    }
    expect((await bookAs(who, courtIds[PHONE_LIMITS.venue], "0179999199", 13)).status).toBe(409);
    expect((await setPaymentStatus(codes[0], true, "cash")).ok).toBe(true);
    expect((await bookAs(who, courtIds[PHONE_LIMITS.venue], "0179999199", 13)).status).toBe(201);
  });

  it("still counts a guest by the number typed", async () => {
    const { POST } = await import("../src/app/api/bookings/route");
    let created = 0;
    for (let i = 0; i < PHONE_LIMITS.venue + 2; i++) {
      resetRateLimits();
      const res = await POST(
        new NextRequest("http://localhost/api/bookings", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ courtId: courtIds[i], date: addDays(todayISO(), 5), hours: [10], name: "Guest One", phone: "0176666601" }),
        })
      );
      if (res.status === 201) created++;
    }
    expect(created).toBe(PHONE_LIMITS.venue);
  });
});
