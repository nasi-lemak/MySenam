import { describe, expect } from "vitest";
import { OWNER } from "../e2e/server";
import { bookCourt, courtFor, dayAhead, scenario, signInOwner, signUp, url, type Actor } from "./harness";

/**
 * Booking, as customers and staff meet it: booking from a venue's page and
 * finding it under the account, two people racing for the same court, a
 * customer cancelling, and a manager kept to their own venue.
 */

async function bookOnPage(a: Actor, venueId: number, courtId: number, date: string, hour: number) {
  await a.page.goto(`${url}/venue/${venueId}?date=${date}&sport=badminton&court=${courtId}&hour=${hour}&duration=1`);
  await a.page.getByLabel("Name").fill(`${a.name} Tester`);
  await a.page.getByLabel("Phone").fill(a.phone);
  await a.page.getByRole("button", { name: /^Book · RM/ }).waitFor();
}

describe("booking", () => {
  scenario("Booking 1: a customer books a court and finds it under their account", async (s) => {
    const customer = await signUp(await s.actor("Customer"));
    const { venueId, courtIds } = await courtFor();
    const date = dayAhead(4);
    const code = await s.step(customer, "chooses a court and an hour on the venue page and books it", async () => {
      await bookOnPage(customer, venueId, courtIds[0], date, 9);
      await customer.page.getByRole("button", { name: /^Book · RM/ }).click();
      await customer.page.getByText("Booking confirmed!").waitFor({ timeout: 15_000 });
      return (await customer.page.getByText(/MS-[A-Z0-9]{4,}/).first().textContent())!.match(/MS-[A-Z0-9]{4,}/)![0];
    });
    await s.step(customer, "finds the booking on their account page", async () => {
      await customer.page.goto(`${url}/account`);
      await customer.page.getByText(code).first().waitFor();
    });
  });

  scenario("Booking 2: two customers race for the same court at the same hour", async (s) => {
    const [a, b] = [await s.actor("Aina"), await s.actor("Bala")];
    const { venueId, courtIds } = await courtFor();
    const date = dayAhead(5);
    await s.step(a, "has the court and hour ready to book", () => bookOnPage(a, venueId, courtIds[0], date, 10));
    await s.step(b, "has the same court and hour ready to book", () => bookOnPage(b, venueId, courtIds[0], date, 10));
    await s.step(a, "both press Book at the same moment", async () => {
      await Promise.all([a.page.getByRole("button", { name: /^Book · RM/ }).click(), b.page.getByRole("button", { name: /^Book · RM/ }).click()]);
      await Promise.all([a.page.waitForLoadState("networkidle"), b.page.waitForLoadState("networkidle")]);
      const confirmed = await Promise.all(
        [a, b].map((x) => x.page.getByText("Booking confirmed!").waitFor({ timeout: 10_000 }).then(() => true, () => false))
      );
      // Exactly one has the court; the other is told, and keeps nothing.
      expect(confirmed.filter(Boolean)).toHaveLength(1);
    });
    await s.step(b, "is refused that court and hour if they try again", async () => {
      const again = await b.api("POST", "/api/bookings", { courtId: courtIds[0], date, hours: [10], name: "Bala Tester", phone: b.phone });
      expect(again.status).toBeGreaterThanOrEqual(400);
    });
  });

  scenario("Booking 3: a customer cancels a booking from their account", async (s) => {
    const customer = await signUp(await s.actor("Customer"));
    const { courtIds } = await courtFor();
    const booking = await bookCourt(customer, courtIds[courtIds.length - 1], dayAhead(6), 11);
    await s.step(customer, "cancels it on the account page", async () => {
      customer.page.on("dialog", (d) => void d.accept());
      await customer.page.goto(`${url}/account`);
      const row = customer.page.locator("li, div").filter({ hasText: booking.code }).filter({ has: customer.page.getByRole("button", { name: "Cancel booking" }) }).last();
      await row.getByRole("button", { name: "Cancel booking" }).click();
      await customer.page.getByText(/cancelled/i).first().waitFor();
    });
    await s.step(customer, "and the court is free again for somebody else", async () => {
      const other = await signUp(await s.actor("Next"));
      const again = await bookCourt(other, courtIds[courtIds.length - 1], dayAhead(6), 11);
      expect(again.code).toMatch(/^MS-/);
    });
  });

  scenario("Booking 4: a venue's manager sees their own venue and is refused another's", async (s) => {
    const owner = await signInOwner(await s.actor("Owner"));
    const { venues } = (await (await fetch(`${url}/api/venues`)).json()) as { venues: { id: number; name: string }[] };
    const [own, other] = venues;
    const email = `manager-${Date.now()}@uat.mysenam.test`;
    await s.step(owner, "makes a manager for one venue", async () => {
      const made = await owner.api("POST", "/api/admin/admins", { name: "UAT Manager", email, password: "a manager's long password", venueId: own.id, role: "manager" });
      expect(made.status).toBeLessThan(300);
    });
    const manager = await s.actor("Manager");
    await s.step(manager, "signs in to the dashboard", async () => {
      await manager.page.goto(`${url}/admin`);
      await manager.page.locator('input[type="email"]').fill(email);
      await manager.page.locator('input[type="password"]').fill("a manager's long password");
      await manager.page.getByRole("button", { name: "Sign in" }).click();
      await manager.page.getByRole("button", { name: /sign out/i }).waitFor({ timeout: 15_000 });
      await manager.page.getByText(own.name).first().waitFor();
    });
    const elsewhere = await signUp(await s.actor("Elsewhere"));
    const otherCourt = ((await (await fetch(`${url}/api/venues`)).json()) as { venues: { id: number; courts: { id: number }[] }[] }).venues.find((v) => v.id === other.id)!.courts[0].id;
    const theirs = await bookCourt(elsewhere, otherCourt, dayAhead(4), 15);
    await s.step(manager, "sees none of the other venue's bookings, and is refused its report", async () => {
      // The list answers for the manager's own venue whatever venue is asked for.
      const list = await manager.api("GET", `/api/admin/bookings?venueId=${other.id}&date=${dayAhead(4)}`);
      expect(JSON.stringify(list.body)).not.toContain(theirs.code);
      const period = `from=${dayAhead(0)}&to=${dayAhead(6)}`;
      expect((await manager.api("GET", `/api/admin/reports?venueId=${own.id}&${period}`)).status).toBe(200);
      expect((await manager.api("GET", `/api/admin/reports?venueId=${other.id}&${period}`)).status).toBe(403);
      void OWNER;
    });
  });
});
