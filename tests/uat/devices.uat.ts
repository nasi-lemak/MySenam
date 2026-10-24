import { describe, expect } from "vitest";
import { bookCourt, fitsScreen, freeSlot, scenario, signInOwner, signUp, url } from "./harness";

/**
 * The same journeys on the screens people hold: a customer booking on a
 * phone, and a venue's staff on a tablet moving an open game while its
 * players answer on their phones. Nothing may need scrolling sideways.
 */

describe("phones and tablets", () => {
  scenario("Phone 1: a customer books a court on a phone and finds it under their account", async (s) => {
    const customer = await signUp(await s.actor("Customer", "phone"));
    const { venueId, courtId, date, hour } = await freeSlot({ hours: [9, 10, 11, 12] });
    await s.step(customer, "opens the home page and a venue's page; neither scrolls sideways", async () => {
      await customer.page.goto(url);
      expect(await fitsScreen(customer.page)).toBeLessThanOrEqual(1);
      await customer.page.goto(`${url}/venue/${venueId}?date=${date}&sport=badminton&court=${courtId}&hour=${hour}&duration=1`);
      await customer.page.getByRole("button", { name: /^Book · RM/ }).waitFor();
      expect(await fitsScreen(customer.page)).toBeLessThanOrEqual(1);
    });
    const code = await s.step(customer, "fills in their details and books with a tap", async () => {
      await customer.page.getByLabel("Name").fill(`${customer.name} Tester`);
      await customer.page.getByLabel("Phone").fill(customer.phone);
      await customer.page.getByRole("button", { name: /^Book · RM/ }).tap();
      await customer.page.getByText("Booking confirmed!").waitFor({ timeout: 15_000 });
      return (await customer.page.getByText(/MS-[A-Z0-9]{4,}/).first().textContent())!.match(/MS-[A-Z0-9]{4,}/)![0];
    });
    await s.step(customer, "finds it on their account page, which fits the screen", async () => {
      await customer.page.goto(`${url}/account`);
      await customer.page.getByText(code).first().waitFor();
      expect(await fitsScreen(customer.page)).toBeLessThanOrEqual(1);
    });
  });

  scenario("Tablet 1: the venue moves an open game from the dashboard; its players confirm on their phones", async (s) => {
    const host = await signUp(await s.actor("Host", "phone"), { profile: { adult: true } });
    const player = await signUp(await s.actor("Player", "phone"), { profile: { adult: true } });
    const when = await freeSlot({ hours: [9, 10, 11] });
    const booking = await bookCourt(host, when.courtId, when.date, when.hour);
    const opened = await host.api("POST", "/api/games", { bookingCode: booking.code, spots: 3, level: null, share: 5, autoAccept: true });
    if (opened.status !== 201) throw new Error(`open game: ${JSON.stringify(opened.body)}`);
    const gameId = (opened.body.game as { id: number }).id;
    const joined = await player.api("POST", `/api/games/${gameId}`, { action: "join" });
    if (joined.status !== 200) throw new Error(`join: ${JSON.stringify(joined.body)}`);

    // A manager of the game's venue, made by the platform's owner.
    const owner = await signInOwner(await s.actor("Owner"));
    const email = `desk-${Date.now()}@uat.mysenam.test`;
    const made = await owner.api("POST", "/api/admin/admins", { name: "UAT Desk Manager", email, password: "a manager's long password", venueId: when.venueId, role: "manager" });
    if (made.status >= 300) throw new Error(`manager: ${JSON.stringify(made.body)}`);
    const manager = await s.actor("Manager", "tablet");

    await s.step(manager, "signs in on the tablet and finds the game's booking on its day", async () => {
      await manager.page.goto(`${url}/admin`);
      await manager.page.locator('input[type="email"]').fill(email);
      await manager.page.locator('input[type="password"]').fill("a manager's long password");
      await manager.page.getByRole("button", { name: "Sign in" }).tap();
      await manager.page.getByRole("button", { name: /sign out/i }).waitFor({ timeout: 15_000 });
      await manager.page.getByLabel("Day to show").fill(when.date);
      await manager.page.getByText(booking.code).first().waitFor();
      expect(await fitsScreen(manager.page)).toBeLessThanOrEqual(1);
    });
    await s.step(manager, "changes its time, sees who is in it, and gives the venue's reason", async () => {
      const row = manager.page.locator("li, tr, div").filter({ hasText: booking.code }).filter({ has: manager.page.getByRole("button", { name: "Change time" }) }).last();
      await row.getByRole("button", { name: "Change time" }).tap();
      await manager.page.locator("button", { hasText: /\d{1,2}:\d{2} [AP]M–/ }).first().tap();
      const preview = manager.page.getByTestId("move-preview");
      await preview.getByText(/players are told the venue's reason/).waitFor();
      expect(await preview.getByRole("button", { name: "Confirm" }).isDisabled()).toBe(true);
      await preview.getByTestId("move-reason").fill("Court 1 is being resurfaced");
      await preview.getByRole("button", { name: "Confirm" }).tap();
      await manager.page.getByText(/is now .* Same code/).waitFor();
    });
    await s.step(player, "is told the venue moved the game and why, and confirms on their phone", async () => {
      await player.page.goto(`${url}/games`);
      const asked = player.page.getByTestId(`move-asked-${gameId}`);
      await asked.getByText(/Court 1 is being resurfaced/).waitFor();
      expect(await fitsScreen(player.page)).toBeLessThanOrEqual(1);
      await asked.getByRole("button", { name: "I'm still coming" }).tap();
      await asked.waitFor({ state: "detached" });
    });
    await s.step(host, "sees the game at its new time, with the player still in it", async () => {
      const now = ((await host.api("GET", "/api/my/games")).body.hosting as { id: number; date: string; startHour: number; joined: number }[]).find((g) => g.id === gameId)!;
      expect([now.date, now.startHour]).not.toEqual([when.date, when.hour]);
      expect(now.joined).toBe(1);
    });
  });
});
