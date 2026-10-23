import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { Browser } from "playwright-core";
import { launch } from "./browser";

/**
 * The launch requirements, end to end against the production build: what a
 * customer does first (book a court), what an owner does first (sign in), and
 * what the market research called trust blockers (headers, the default
 * password, requests from another site).
 */

const url = inject("e2eUrl");
const OWNER = { email: "owner@e2e.my", password: "an end-to-end owner password" };
let browser: Browser;

/** A page that records anything the content security policy blocked. */
async function watchedPage() {
  const page = await browser.newPage();
  const blocked: string[] = [];
  page.on("console", (m) => {
    if (/Content Security Policy|Refused to/i.test(m.text())) blocked.push(m.text());
  });
  return { page, blocked };
}

beforeAll(async () => {
  browser = await launch();
});
afterAll(async () => {
  await browser?.close();
});

/** Tomorrow in Malaysia: a date every starter venue takes bookings for. */
function tomorrow(): string {
  const now = new Date(Date.now() + 8 * 3_600_000 + 86_400_000);
  return now.toISOString().slice(0, 10);
}

async function badmintonCourt(): Promise<{ venueId: number; courtId: number }> {
  const { venues } = (await (await fetch(`${url}/api/venues?sport=badminton`)).json()) as {
    venues: { id: number; courts: { id: number; sport: string }[] }[];
  };
  const venue = venues.find((v) => v.courts.some((c) => c.sport === "badminton"))!;
  return { venueId: venue.id, courtId: venue.courts.find((c) => c.sport === "badminton")!.id };
}

describe("every page", () => {
  it("is sent with the security headers", async () => {
    for (const path of ["/", "/admin", "/api/health"]) {
      const res = await fetch(`${url}${path}`);
      expect(res.headers.get("content-security-policy"), path).toContain("frame-ancestors 'none'");
      expect(res.headers.get("x-frame-options"), path).toBe("DENY");
      expect(res.headers.get("strict-transport-security"), path).toContain("max-age=");
      expect(res.headers.get("x-content-type-options"), path).toBe("nosniff");
    }
  });

  it("loads in the browser without the policy blocking any of its own scripts", async () => {
    const { page, blocked } = await watchedPage();
    await page.goto(`${url}/`);
    await page.waitForLoadState("networkidle");
    expect(blocked).toEqual([]);
    await page.close();
  });
});

describe("a customer", () => {
  it("books a court from the venue page and is given a booking code", async () => {
    const { venueId, courtId } = await badmintonCourt();
    const { page, blocked } = await watchedPage();
    await page.goto(`${url}/venue/${venueId}?date=${tomorrow()}&sport=badminton&court=${courtId}&hour=10&duration=1`);
    await page.getByLabel("Name").fill("Aina End-to-End");
    await page.getByLabel("Phone").fill("0123456700");
    await page.getByRole("button", { name: /^Book · RM/ }).click();
    await page.getByText("Booking confirmed!").waitFor({ timeout: 15_000 });
    expect(await page.getByText(/MS-[A-Z0-9]{4,}/).first().textContent()).toMatch(/MS-[A-Z0-9]{4,}/);
    // The venue page, its map included, runs under the policy.
    expect(blocked).toEqual([]);
    await page.close();
  });
});

describe("the owner", () => {
  it("cannot sign in with the published default password, and can with their own", async () => {
    const { page, blocked } = await watchedPage();
    await page.goto(`${url}/admin`);
    await page.locator('input[type="email"]').fill(OWNER.email);
    await page.locator('input[type="password"]').fill("mysenam-admin");
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByText(/wrong email or password/i).waitFor({ timeout: 10_000 });

    await page.locator('input[type="password"]').fill(OWNER.password);
    await page.getByRole("button", { name: "Sign in" }).click();
    await page.getByRole("button", { name: /sign out/i }).waitFor({ timeout: 15_000 });
    expect(blocked).toEqual([]);
    await page.close();
  });
});

describe("a signed-in request made by another site", () => {
  it("is refused, while the same request from this site goes through", async () => {
    const login = await fetch(`${url}/api/admin/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: url },
      body: JSON.stringify(OWNER),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const logout = (origin: string) =>
      fetch(`${url}/api/admin/auth/logout`, { method: "POST", headers: { cookie, origin } });
    expect((await logout("https://evil.example")).status).toBe(403);
    // Still signed in: the forged request did nothing.
    const me = await fetch(`${url}/api/admin/auth/me`, { headers: { cookie } });
    expect(me.status).toBe(200);
    expect((await logout(url)).status).toBeLessThan(400);
  });
});

describe("a venue's staff, on the running app", () => {
  /** Signs in through the API as the browser would, and returns the cookie. */
  async function signIn(email: string, password: string): Promise<string> {
    const res = await fetch(`${url}/api/admin/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: url },
      body: JSON.stringify({ email, password }),
    });
    expect(res.status, `sign in as ${email}`).toBe(200);
    return res.headers.get("set-cookie")!.split(";")[0];
  }

  it("see their own venue's report and are refused another's", async () => {
    const { venues } = (await (await fetch(`${url}/api/venues`)).json()) as { venues: { id: number }[] };
    const [own, other] = venues.map((v) => v.id);
    const owner = await signIn(OWNER.email, OWNER.password);
    const made = await fetch(`${url}/api/admin/admins`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: owner, origin: url },
      body: JSON.stringify({ name: "E2E Desk Manager", email: "manager@e2e.my", password: "a manager's long password", venueId: own, role: "manager" }),
    });
    expect(made.status).toBeLessThan(300);
    const staff = await signIn("manager@e2e.my", "a manager's long password");
    const report = (venueId: number) =>
      fetch(`${url}/api/admin/reports?venueId=${venueId}&from=${tomorrow()}&to=${tomorrow()}`, { headers: { cookie: staff } });
    expect((await report(own)).status).toBe(200);
    expect((await report(other)).status).toBe(403);
  });
});
