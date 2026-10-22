import { beforeEach, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { NextRequest } from "next/server";
import { registerUser } from "../src/lib/auth";
import { createAdmin } from "../src/lib/admin-auth";
import { POLICIES, resetRateLimits } from "../src/lib/rate-limit";
import { POST as login } from "../src/app/api/auth/login/route";
import { POST as adminLogin } from "../src/app/api/admin/auth/login/route";

/**
 * Guessing one account's password from many addresses: each address has its
 * own allowance, so the account keeps a count of its own of wrong passwords,
 * from anywhere. A right password does not count against it.
 */

const attempt = (route: typeof login, email: string, password: string, ip: string) =>
  route(
    new NextRequest("http://localhost/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": ip },
      body: JSON.stringify({ email, password }),
    })
  );

const LIMIT = POLICIES.loginFailures.limit;

beforeEach(() => resetRateLimits());

describe("wrong passwords for one account", () => {
  it("from many addresses are limited together", async () => {
    const made = await registerUser({ name: "Target", email: "target@example.com", phone: "0127770001", password: "the right password" });
    if (!made.ok) throw new Error(made.error);
    for (let i = 0; i < LIMIT; i++) expect((await attempt(login, "target@example.com", "guess", `10.0.${i}.1`)).status).toBe(401);
    expect((await attempt(login, "target@example.com", "guess", "10.9.9.9")).status).toBe(429);
    // Somebody else's account is not affected.
    await registerUser({ name: "Other", email: "other@example.com", phone: "0127770002", password: "the right password" });
    expect((await attempt(login, "other@example.com", "the right password", "10.9.9.9")).status).toBe(200);
  });

  it("are not counted when the password is right", async () => {
    const made = await registerUser({ name: "Regular", email: "regular@example.com", phone: "0127770003", password: "the right password" });
    if (!made.ok) throw new Error(made.error);
    for (let i = 0; i < LIMIT + 2; i++)
      expect((await attempt(login, "regular@example.com", "the right password", `10.1.${i}.1`)).status).toBe(200);
  });

  it("are limited together for staff too", async () => {
    await createAdmin({ name: "Mgr", email: "mgr@limits.my", password: "the right password long", venueId: null });
    for (let i = 0; i < LIMIT; i++) expect((await attempt(adminLogin, "mgr@limits.my", "guess", `10.2.${i}.1`)).status).toBe(401);
    expect((await attempt(adminLogin, "mgr@limits.my", "guess", "10.9.9.8")).status).toBe(429);
  });
});
