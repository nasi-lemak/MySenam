import { describe, expect } from "vitest";
import { dayAhead, gone, scenario, signInOwner, signUp, url } from "./harness";

/**
 * A venue's first day on the marketplace, as its operator, the platform's
 * owner and its first customer meet it: signing up at /list-your-venue, the
 * draft set up from the dashboard's checklist (a court and its rates, the
 * opening hours), asking to go live, the owner's checks and approval, and a
 * customer in another browser booking it from the link the venue shares.
 *
 * Only a marketplace takes sign-ups (the UAT server runs as one); against a
 * deployment that is not, the scenario is skipped rather than passed.
 */

const marketplace = (await fetch(`${url}/list-your-venue`)).status !== 404;

/** A badminton court, day and hour free at this venue, from what its page offers. */
async function freeAt(venueId: number): Promise<{ courtId: number; date: string; hour: number }> {
  for (let d = 2; d <= 9; d++) {
    const date = dayAhead(d);
    const res = await fetch(`${url}/api/availability?venueId=${venueId}&date=${date}&sport=badminton`);
    if (!res.ok) continue;
    const { availability } = (await res.json()) as { availability: { court: { id: number }; starts: { minute: number; maxLength: number }[] }[] };
    for (const c of availability)
      for (const st of c.starts)
        if (st.minute % 60 === 0 && st.minute >= 10 * 60 && st.minute <= 19 * 60 && st.maxLength >= 60) return { courtId: c.court.id, date, hour: st.minute / 60 };
  }
  throw new Error(`Nothing free at venue ${venueId}`);
}

describe.skipIf(!marketplace)("a venue's set-up, from sign-up to its first booking", () => {
  scenario("Venue 1: a venue signs up, sets up from the checklist, goes live and takes its first booking", async (s) => {
    const operator = await s.actor("Operator");
    const venueName = `Dewan Badminton UAT ${Date.now().toString(36)}`;
    const page = operator.page;
    // Standing in the venue, in Petaling Jaya, as the form asks.
    await operator.context.grantPermissions(["geolocation"], { origin: url });
    await operator.context.setGeolocation({ latitude: 3.1073, longitude: 101.6067 });

    await s.step(operator, "signs the venue up at /list-your-venue, pinning it from where they stand", async () => {
      await page.goto(`${url}/list-your-venue`);
      // The map is drawn in the browser only, so once it is there the form is live.
      await page.getByRole("button", { name: "Zoom in" }).waitFor();
      await page.getByLabel("Venue name").fill(venueName);
      await page.getByLabel("Area").fill("Petaling Jaya");
      await page.getByLabel("Venue phone").fill("03-7955 1234");
      await page.getByLabel("Address", { exact: true }).fill("12 Jalan 14/22, Seksyen 14, Petaling Jaya");
      await page.getByRole("button", { name: "I'm at the venue: use my location" }).click();
      await page.getByText("Pinned. Drag the pin if it isn't quite right.").waitFor();
      await page.getByLabel("Your name").fill("Operator Tester");
      await page.getByLabel("Your email").fill(operator.email);
      await page.getByLabel("Choose a password").fill(operator.password);
      await page.getByRole("button", { name: "Sign up" }).click();
      // The test server sends no email, so the account opens at once, as it says.
      await page.getByText("Your account is ready").waitFor({ timeout: 15_000 });
    });

    const venueId = await s.step(operator, "signs in to the dashboard and finds the venue is a draft only they can see", async () => {
      await page.getByRole("link", { name: "Go to your dashboard" }).click();
      await page.getByLabel("Email").fill(operator.email);
      await page.getByLabel("Password").fill(operator.password);
      await page.getByRole("button", { name: "Sign in" }).click();
      await page.getByRole("button", { name: /sign out/i }).waitFor({ timeout: 15_000 });
      await page.getByText("Your venue is a draft: only you and your staff can see it").waitFor();
      await page.getByText("Add at least one court, with its rates.").waitFor();
      expect(await page.getByRole("button", { name: "Ask to go live" }).isDisabled()).toBe(true);
      const href = await page.getByRole("link", { name: "See your page ↗" }).getAttribute("href");
      return Number(/\/venue\/(\d+)/.exec(href ?? "")![1]);
    });

    const checklist = page.locator("section").filter({ hasText: "Set up your venue" });
    await s.step(operator, "follows the checklist to Courts & rates and adds a court with its rates", async () => {
      await checklist.getByText("3 steps to go").waitFor();
      await checklist.getByRole("button", { name: "Courts & rates" }).click();
      const add = page.locator("section").filter({ hasText: "Add courts, lanes, bays or a facility" });
      await add.getByLabel("Activity", { exact: true }).selectOption("badminton");
      await add.getByLabel("How many").fill("1");
      await add.getByLabel("Name (optional)").fill("Court A");
      await add.getByLabel(/^Off-peak \(/).fill("18");
      await add.getByLabel(/^Peak \(/).fill("25");
      await add.getByRole("button", { name: "Add", exact: true }).click();
      await page.getByText("Added Court A.").waitFor();
      await checklist.getByText("2 steps to go").waitFor();
    });

    await s.step(operator, "checks the opening hours under Venue details and closes an hour earlier", async () => {
      await checklist.getByRole("button", { name: "Venue details" }).first().click();
      const opens = page.getByLabel("Opens", { exact: true });
      const closes = page.getByLabel("Closes", { exact: true });
      // New venues open 8 am to 11 pm, as the checklist says.
      expect(await opens.inputValue()).toBe("08:00");
      expect(await closes.inputValue()).toBe("23:00");
      await closes.fill("22:00");
      const row = page.locator("div").filter({ has: opens }).last();
      await row.getByRole("button", { name: "Save", exact: true }).first().click();
      await page.getByText(`Saved ${venueName}.`).waitFor();
      await checklist.getByText("1 step to go").waitFor();
    });

    await s.step(operator, "asks for the venue to go live", async () => {
      await page.getByRole("button", { name: "Ask to go live" }).click();
      await page.getByText("Your venue is waiting to go live").waitFor();
    });

    const customer = await signUp(await s.actor("Customer"));
    await s.step(customer, "cannot open the venue's page while it waits", async () => {
      const res = await customer.page.goto(`${url}/venue/${venueId}`);
      expect(res?.status()).toBe(404);
    });

    const owner = await signInOwner(await s.actor("Owner"));
    await s.step(owner, "finds the venue under Venues & staff → Going live, with its court and rate", async () => {
      await owner.page.goto(`${url}/admin`);
      await owner.page.getByRole("button", { name: "Venues & staff" }).click();
      await owner.page.getByRole("heading", { name: /^Going live/ }).waitFor();
      const card = owner.page
        .locator("div")
        .filter({ hasText: venueName })
        .filter({ has: owner.page.getByRole("button", { name: "Approve" }) })
        .filter({ has: owner.page.getByRole("checkbox") })
        .last();
      await card.getByText("1 court").waitFor();
      // Not until every check is ticked.
      expect(await card.getByRole("button", { name: "Approve" }).isDisabled()).toBe(true);
    });

    await s.step(owner, "ticks what they checked and approves it", async () => {
      const card = owner.page
        .locator("div")
        .filter({ hasText: venueName })
        .filter({ has: owner.page.getByRole("button", { name: "Approve" }) })
        .filter({ has: owner.page.getByRole("checkbox") })
        .last();
      for (const label of [
        "The pin is on the venue",
        "I phoned the venue's number",
        "The business exists beyond this form",
        "Any photos show this venue",
      ])
        await card.getByLabel(new RegExp(`^${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`)).check();
      owner.page.once("dialog", (d) => void d.accept());
      await card.getByRole("button", { name: "Approve" }).click();
      await owner.page.getByText(`${venueName} is live.`).waitFor();
    });

    const link = await s.step(operator, "sees the venue live, and its booking link to share", async () => {
      await page.reload();
      await page.getByRole("button", { name: /sign out/i }).waitFor({ timeout: 15_000 });
      // The dashboard reopens on the tab it was left on; the link to share is with the bookings.
      await page.getByRole("button", { name: "Bookings", exact: true }).click();
      const shown = await page.getByText(/\/venue\/\d+/).first().textContent();
      expect(await page.getByText("Your venue is waiting to go live").count()).toBe(0);
      return shown!.trim();
    });

    const slot = await freeAt(venueId);
    const code = await s.step(customer, "opens the shared link and books the venue's court", async () => {
      await customer.page.goto(link.startsWith("http") ? link : `${url}${link}`);
      await customer.page.getByText(venueName).first().waitFor();
      await customer.page.goto(`${url}/venue/${venueId}?date=${slot.date}&sport=badminton&court=${slot.courtId}&hour=${slot.hour}&duration=1`);
      await customer.page.getByLabel("Name").fill(`${customer.name} Tester`);
      await customer.page.getByLabel("Phone").fill(customer.phone);
      await customer.page.getByRole("button", { name: /^Book · RM/ }).click();
      await customer.page.getByText("Booking confirmed!").waitFor({ timeout: 15_000 });
      return (await customer.page.getByText(/MS-[A-Z0-9]{4,}/).first().textContent())!.match(/MS-[A-Z0-9]{4,}/)![0];
    });

    await s.step(operator, "finds the first booking on its day; next time the dashboard opens, the set-up checklist is done and gone", async () => {
      await page.getByRole("button", { name: "Bookings", exact: true }).click();
      await page.getByLabel("Day to show").fill(slot.date);
      const row = page.locator("tr").filter({ hasText: code });
      await row.getByText("Court A").waitFor();
      await row.getByText(`${customer.name} Tester`).waitFor();
      // The checklist reads itself when the dashboard opens or its tab changes, not as bookings arrive.
      await page.reload();
      await page.getByRole("button", { name: /sign out/i }).waitFor({ timeout: 15_000 });
      await gone(page.getByText("Set up your venue"));
    });
  });
});
