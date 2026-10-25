import { describe, expect } from "vitest";
import { freeSlot, scenario, signInOwner, url } from "./harness";

/**
 * The staff dashboard in the languages a venue's staff work in: English,
 * Malay and Chinese (not Tamil). A manager picks one on the dashboard, signs
 * in, and works in it; a refusal from the server reads in it too.
 */

describe("the staff dashboard in Malay and Chinese", () => {
  scenario("Staff 1: a manager signs in and works the dashboard in Malay, then in Chinese", async (s) => {
    const owner = await signInOwner(await s.actor("Owner"));
    const { venueId } = await freeSlot({ hours: [9, 10] });
    const email = `bahasa-${Date.now()}@uat.mysenam.test`;
    const password = "a manager's long password";
    const made = await owner.api("POST", "/api/admin/admins", { name: "UAT Pengurus", email, password, venueId, role: "manager" });
    if (made.status >= 300) throw new Error(`manager: ${JSON.stringify(made.body)}`);
    const manager = await s.actor("Manager");
    const page = manager.page;

    await s.step(manager, "opens the dashboard and is offered English, Malay and Chinese, not Tamil", async () => {
      await page.goto(`${url}/admin`);
      const switcher = page.getByRole("group").filter({ has: page.getByRole("button", { name: "ms" }) });
      expect(await switcher.getByRole("button").count()).toBe(3);
      expect(await switcher.getByRole("button", { name: "தமிழ்" }).count()).toBe(0);
    });

    await s.step(manager, "switches to Malay; a wrong password is refused in Malay", async () => {
      await page.getByRole("button", { name: "ms" }).click();
      await page.getByRole("button", { name: "Log masuk" }).waitFor();
      await page.locator('input[type="email"]').fill(email);
      await page.locator('input[type="password"]').fill("not the password");
      await page.getByRole("button", { name: "Log masuk" }).click();
      await page.getByText("E-mel atau kata laluan salah.").waitFor();
    });

    await s.step(manager, "signs in and sees the dashboard in Malay", async () => {
      await page.locator('input[type="password"]').fill(password);
      await page.getByRole("button", { name: "Log masuk" }).click();
      await page.getByRole("button", { name: "Log keluar" }).waitFor({ timeout: 15_000 });
      await page.getByRole("button", { name: "Tempahan", exact: true }).first().waitFor();
      expect(await page.getByRole("button", { name: "Bookings", exact: true }).count()).toBe(0);
    });

    await s.step(manager, "switches to Chinese and stays signed in", async () => {
      await page.getByRole("button", { name: "中文" }).click();
      await page.getByRole("button", { name: "退出登录" }).waitFor({ timeout: 15_000 });
      await page.getByRole("button", { name: "预订", exact: true }).first().waitFor();
    });
  });
});
