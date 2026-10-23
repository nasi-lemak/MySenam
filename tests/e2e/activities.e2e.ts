import { afterAll, beforeAll, describe, expect, inject, it } from "vitest";
import type { Browser } from "playwright-core";
import { launch } from "./browser";

/**
 * Activities on the production build (ADR 0011): an owner makes golf bays
 * from the template in one go and lets a badminton court be booked for
 * pickleball too; a customer finds them by the word they know, and the
 * floor is sold for one activity at a time.
 */

const url = inject("e2eUrl");
const OWNER = { email: "owner@e2e.my", password: "an end-to-end owner password" };
let browser: Browser;
let cookie = "";

async function admin(method: string, path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`${url}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Cookie: cookie, Origin: url },
    body: JSON.stringify(body),
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (!res.ok) throw new Error(`${path}: ${res.status} ${JSON.stringify(data)}`);
  return data;
}

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

describe("activities", () => {
  let venueId: number;
  let hall: number;

  it("are set up from templates, and one court can offer two", async () => {
    const { venue } = (await admin("POST", "/api/admin/venues", {
      name: "E2E Activity Centre",
      area: "Damansara",
      address: "2 Jalan Aktiviti",
      phone: "0312345679",
    })) as { venue: { id: number } };
    venueId = venue.id;
    const { courts } = (await admin("POST", "/api/admin/courts", { venueId, count: 3, sport: "golf_simulator", offPeakRate: 60, peakRate: 80 })) as {
      courts: { name: string }[];
    };
    expect(courts.map((c) => c.name)).toEqual(["Bay 1", "Bay 2", "Bay 3"]);
    const made = (await admin("POST", "/api/admin/courts", { venueId, name: "Hall A", sport: "badminton", offPeakRate: 20, peakRate: 20 })) as {
      court: { id: number };
    };
    hall = made.court.id;
    await admin("PATCH", `/api/admin/courts/${hall}`, { activities: [{ sport: "pickleball", offPeakRate: 30, peakRate: 30 }] });
  });

  it("are found by the word a customer types", async () => {
    const page = await browser.newPage();
    await page.goto(`${url}/search?date=${tomorrow()}`);
    await page.getByRole("searchbox").fill("screen golf");
    await page.getByRole("button", { name: /Golf simulator/ }).first().click();
    await page.getByText("E2E Activity Centre").first().waitFor();
    await page.close();
  });

  it("sell a shared floor for one activity at a time", async () => {
    const book = (sport: string, phone: string) =>
      fetch(`${url}/api/bookings`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: url },
        body: JSON.stringify({ courtId: hall, sport, date: tomorrow(), start: 10 * 60, end: 11 * 60, name: "E2E", phone }),
      });
    const pickle = await book("pickleball", "0123450001");
    expect(pickle.status).toBe(201);
    expect(((await pickle.json()) as { booking: { sport: string; totalPrice: number } }).booking).toMatchObject({ sport: "pickleball", totalPrice: 30 });
    expect((await book("badminton", "0123450002")).status).toBeGreaterThanOrEqual(400);
  });
});
