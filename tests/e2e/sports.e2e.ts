import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { Browser } from "playwright-core";
import { launch } from "./browser";

/**
 * Sports on the production build: a customer is offered only the sports
 * somebody has a court for, and padel is searched for in its 90-minute games,
 * sold by the half hour at a venue that sells its other sports by the hour
 * (ADR 0009).
 */

const url = inject("e2eUrl");
const OWNER = { email: "owner@e2e.my", password: "an end-to-end owner password" };
let browser: Browser;
let cookie = "";

/** The owner's own requests, made as the admin screens make them. */
async function admin(path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie, Origin: url },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(data)}`);
  return data;
}

/** Tomorrow in Malaysia: every hour of it still to come. */
function tomorrow(): string {
  return new Date(Date.now() + 8 * 3_600_000 + 86_400_000).toISOString().slice(0, 10);
}

beforeAll(async () => {
  browser = await launch();
  const res = await fetch(`${url}/api/admin/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: url },
    body: JSON.stringify(OWNER),
  });
  expect(res.status).toBe(200);
  cookie = (res.headers.get("set-cookie") ?? "").split(";")[0];
});
afterAll(async () => {
  await browser?.close();
});

describe("sports", () => {
  it("offers only those somebody has a court for", async () => {
    const { sports } = (await (await fetch(`${url}/api/sports`)).json()) as { sports: string[] };
    expect(sports).toContain("badminton");
    expect(sports).not.toContain("squash");

    const page = await browser.newPage();
    await page.goto(`${url}/search`);
    await page.getByRole("button", { name: /Badminton/ }).first().waitFor();
    expect(await page.getByRole("button", { name: /Squash/ }).count()).toBe(0);
    await page.close();
  });

  it("finds padel's 90-minute games, on the half hour too, at a venue selling hours", async () => {
    const { venue } = (await admin("/api/admin/venues", {
      name: "E2E Padel Club",
      area: "Mont Kiara",
      address: "1 Jalan Padel",
      phone: "0312345678",
    })) as { venue: { id: number } };
    await admin("/api/admin/courts", { venueId: venue.id, name: "Padel 1", sport: "padel", offPeakRate: 80, peakRate: 80 });

    const { sports } = (await (await fetch(`${url}/api/sports`)).json()) as { sports: string[] };
    expect(sports).toContain("padel");

    const page = await browser.newPage();
    await page.goto(`${url}/search?sport=padel&date=${tomorrow()}`);
    const length = page.locator("select").filter({ hasText: "1.5 hours" });
    // Padel asks for its 90 minutes; badminton for an hour; back to padel, 90 again.
    await expect.poll(() => length.inputValue()).toBe("1.5");
    await page.getByRole("button", { name: /Badminton/ }).click();
    await expect.poll(() => length.inputValue()).toBe("1");
    await page.getByRole("button", { name: /Padel/ }).click();
    await expect.poll(() => length.inputValue()).toBe("1.5");
    // And finds them, starting on the half hour as well as the hour.
    await page.getByText("E2E Padel Club").first().waitFor({ timeout: 15_000 });
    await expect.poll(async () => (await page.locator("body").innerText()).match(/\d{1,2}:30 [AP]M/) !== null).toBe(true);
    await page.close();
  });
});
