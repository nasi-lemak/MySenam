import { afterEach, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import {
  authenticateAdmin,
  createAdmin,
  DEFAULT_ADMIN_PASSWORD,
  ensureBootstrapAdmin,
  listAdmins,
  replaceDefaultOwnerPasswords,
} from "../src/lib/admin-auth";
import { hashPassword } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { crossSiteRefusal, type RequestFacts } from "../src/lib/same-origin";
import { contentSecurityPolicy, newNonce, securityHeaders } from "../src/lib/security-headers";

/**
 * What the market research called trust blockers before any venue sees the
 * product: the published default password, headers, and requests made from
 * another site.
 */

afterEach(() => vi.unstubAllEnvs());

describe("the published default owner password", () => {
  it("makes no owner in production, without a proper ADMIN_PASSWORD", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ADMIN_PASSWORD", "");
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    await ensureBootstrapAdmin();
    expect(await listAdmins()).toHaveLength(0);
    vi.stubEnv("ADMIN_PASSWORD", DEFAULT_ADMIN_PASSWORD);
    await ensureBootstrapAdmin();
    vi.stubEnv("ADMIN_PASSWORD", "short");
    await ensureBootstrapAdmin();
    expect(await listAdmins()).toHaveLength(0);
    expect(errors).toHaveBeenCalled();
    errors.mockRestore();

    vi.stubEnv("ADMIN_PASSWORD", "a proper long password");
    await ensureBootstrapAdmin();
    expect(await listAdmins()).toHaveLength(1);
    expect(await authenticateAdmin("admin@mysenam.my", "a proper long password")).not.toBeNull();
  });

  it("opens nothing in production for an account that still has it, until ADMIN_PASSWORD replaces it", async () => {
    // An owner made before the default was refused.
    const [owner] = await listAdmins();
    await getDb().prepare("UPDATE admins SET password_hash = ? WHERE id = ?").run(hashPassword(DEFAULT_ADMIN_PASSWORD), owner.id);
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("ADMIN_PASSWORD", "the owner's new password");
    expect(await authenticateAdmin(owner.email, DEFAULT_ADMIN_PASSWORD)).toBeNull();
    expect(await replaceDefaultOwnerPasswords()).toBe(1);
    expect(await authenticateAdmin(owner.email, "the owner's new password")).not.toBeNull();
    // Venue staff are never touched by it.
    const staff = await createAdmin({ name: "Desk", email: "desk@venue.my", password: "desk password long", venueId: null });
    expect(staff.ok).toBe(true);
    expect(await replaceDefaultOwnerPasswords()).toBe(0);
  });

  it("is still the development default outside production", async () => {
    vi.stubEnv("NODE_ENV", "test");
    const [owner] = await listAdmins();
    await getDb().prepare("UPDATE admins SET password_hash = ? WHERE id = ?").run(hashPassword(DEFAULT_ADMIN_PASSWORD), owner.id);
    expect(await authenticateAdmin(owner.email, DEFAULT_ADMIN_PASSWORD)).not.toBeNull();
    expect(await replaceDefaultOwnerPasswords()).toBe(0);
  });
});

describe("security headers", () => {
  const h = new Map(securityHeaders().map((x) => [x.key, x.value]));

  it("forbid framing, scripts without this response's nonce, and plugins, and ask for HTTPS", () => {
    const csp = contentSecurityPolicy("abc123==", false);
    expect(csp).toContain("frame-ancestors 'none'");
    // Only scripts carrying the nonce, and what they load; 'unsafe-inline' is ignored by any browser that reads nonces.
    expect(csp).toContain("script-src 'self' 'nonce-abc123==' 'strict-dynamic'");
    expect(csp).not.toContain("unsafe-eval");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("form-action 'self'");
    expect(h.get("X-Frame-Options")).toBe("DENY");
    expect(h.get("X-Content-Type-Options")).toBe("nosniff");
    expect(h.get("Strict-Transport-Security")).toBe("max-age=31536000");
    expect(h.get("Permissions-Policy")).toContain("geolocation=(self)");
  });

  it("makes a fresh, unguessable nonce for each response", () => {
    const seen = new Set(Array.from({ length: 50 }, () => newNonce()));
    expect(seen.size).toBe(50);
    for (const n of seen) expect(atob(n)).toHaveLength(16);
  });

  it("let React's development tools evaluate code, only in development", () => {
    expect(contentSecurityPolicy("x", true)).toContain("'unsafe-eval'");
  });
});

describe("a signed-in change asked for by another site", () => {
  const facts = (over: Partial<RequestFacts> & { headers?: Record<string, string> }): RequestFacts => ({
    method: "POST",
    pathname: "/api/bookings",
    cookieNames: ["ms_session"],
    ...over,
    header: (name) => over.headers?.[name] ?? (name === "host" ? "book.example.my" : null),
  });

  it("is refused by Origin or by Sec-Fetch-Site", () => {
    expect(crossSiteRefusal(facts({ headers: { host: "book.example.my", origin: "https://evil.example" } }))).toBe("foreign origin");
    expect(crossSiteRefusal(facts({ headers: { host: "book.example.my", "sec-fetch-site": "cross-site" } }))).toBe("cross-site");
    expect(crossSiteRefusal(facts({ cookieNames: ["ms_admin"], headers: { host: "book.example.my", origin: "null" } }))).not.toBeNull();
  });

  it("goes through from this site, behind a proxy, or from the configured address", () => {
    expect(crossSiteRefusal(facts({ headers: { host: "book.example.my", origin: "https://book.example.my" } }))).toBeNull();
    expect(
      crossSiteRefusal(facts({ headers: { host: "127.0.0.1:3000", "x-forwarded-host": "book.example.my", origin: "https://book.example.my" } }))
    ).toBeNull();
    vi.stubEnv("MYSENAM_URL", "https://courts.example.my");
    expect(crossSiteRefusal(facts({ headers: { host: "127.0.0.1:3000", origin: "https://courts.example.my" } }))).toBeNull();
    // No Origin at all: an older browser, or not a browser; SameSite still applies.
    expect(crossSiteRefusal(facts({ headers: { host: "book.example.my" } }))).toBeNull();
  });

  it("does not touch reads, servers without our cookies, or the key-authorised public API", () => {
    const foreign = { host: "book.example.my", origin: "https://evil.example" };
    expect(crossSiteRefusal(facts({ method: "GET", headers: foreign }))).toBeNull();
    expect(crossSiteRefusal(facts({ cookieNames: [], headers: foreign }))).toBeNull();
    expect(crossSiteRefusal(facts({ cookieNames: ["ms_lang"], headers: foreign }))).toBeNull();
    expect(crossSiteRefusal(facts({ pathname: "/api/v1/bookings", headers: foreign }))).toBeNull();
    expect(crossSiteRefusal(facts({ pathname: "/venue/1", headers: foreign }))).toBeNull();
  });
});
