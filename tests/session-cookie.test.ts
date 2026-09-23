import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";

import { sessionCookieOptions } from "../src/lib/session-cookie";

const EXPIRES = new Date("2027-01-01T00:00:00Z");

function req(url: string, headers: Record<string, string> = {}) {
  return new NextRequest(new Request(url, { headers }));
}

describe("session cookie flags", () => {
  it("is always HttpOnly, Lax and site-wide", () => {
    const o = sessionCookieOptions(req("http://localhost:3000/api/auth/login"), EXPIRES);
    expect(o.httpOnly).toBe(true);
    expect(o.sameSite).toBe("lax");
    expect(o.path).toBe("/");
    expect(o.expires).toBe(EXPIRES);
  });

  it("marks Secure on a direct HTTPS request", () => {
    expect(sessionCookieOptions(req("https://mysenam.my/api/auth/login"), EXPIRES).secure).toBe(true);
  });

  it("marks Secure behind a proxy that reports https", () => {
    expect(
      sessionCookieOptions(req("http://app.internal/api/auth/login", { "x-forwarded-proto": "https" }), EXPIRES).secure
    ).toBe(true);
    // A proxy chain lists protocols; the client-facing one comes first.
    expect(
      sessionCookieOptions(req("http://app.internal/x", { "x-forwarded-proto": "https, http" }), EXPIRES).secure
    ).toBe(true);
  });

  it("does not mark Secure on plain HTTP, which would stop the cookie being sent at all", () => {
    expect(sessionCookieOptions(req("http://localhost:3000/x"), EXPIRES).secure).toBe(false);
    expect(
      sessionCookieOptions(req("http://app.internal/x", { "x-forwarded-proto": "http" }), EXPIRES).secure
    ).toBe(false);
  });

  it("can be forced on for a proxy that sets no header", () => {
    process.env.SECURE_COOKIES = "1";
    expect(sessionCookieOptions(req("http://app.internal/x"), EXPIRES).secure).toBe(true);
    delete process.env.SECURE_COOKIES;
    expect(sessionCookieOptions(req("http://app.internal/x"), EXPIRES).secure).toBe(false);
  });
});
