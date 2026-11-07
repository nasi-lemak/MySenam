import { describe, expect } from "vitest";
import { bookCourt, dayAhead, rowAction, scenario, signInOwner, signUp, url, weekdayDate, type Actor, type Scenario } from "./harness";

/**
 * Changing a booking's time, as customers and a venue's staff meet it: a
 * customer moving their own booking from My Booking to another free time
 * (same length, same code) and the venue seeing it there; the changes that
 * are refused, a time somebody took meanwhile and a booking inside the
 * venue's cut-off; and the venue's staff moving a customer's booking from the
 * dashboard.
 *
 * Each scenario has a venue of its own with one pickleball court, made by
 * the platform's owner (setup, not the subject): with one court a taken time
 * cannot quietly go to another court, and a venue's own cut-off touches no
 * other scenario's bookings.
 */

const PASSWORD = "a manager's long password";

interface Venue {
  venueId: number;
  courtId: number;
  name: string;
  managerEmail: string;
}

/** A live venue with one pickleball court, its cut-off in hours, and a manager. */
async function pickleballVenue(s: Scenario, cutoffHours = 2): Promise<Venue> {
  const owner = await signInOwner(await s.actor("Owner"));
  const stamp = Date.now().toString(36);
  const name = `Pickleball UAT ${stamp}`;
  const made = await owner.api("POST", "/api/admin/venues", { name, area: "Subang Jaya", address: "3 Jalan SS 15/4, Subang Jaya", phone: "03-5631 2000" });
  if (made.status !== 201) throw new Error(`venue: ${JSON.stringify(made.body)}`);
  const venueId = (made.body.venue as { id: number }).id;
  const court = await owner.api("POST", "/api/admin/courts", { venueId, sport: "pickleball", name: "Court 1", offPeakRate: 20, peakRate: 28, capacity: 1, deposit: 0 });
  if (court.status >= 300) throw new Error(`court: ${JSON.stringify(court.body)}`);
  const courtId = ((court.body.courts as { id: number }[] | undefined)?.[0] ?? (court.body.court as { id: number })).id;
  if (cutoffHours !== 2) {
    const cut = await owner.api("PATCH", `/api/admin/venues/${venueId}`, { cancelCutoffHours: cutoffHours });
    if (cut.status !== 200) throw new Error(`cut-off: ${JSON.stringify(cut.body)}`);
  }
  const managerEmail = `desk-${stamp}@uat.mysenam.test`;
  const manager = await owner.api("POST", "/api/admin/admins", { name: "UAT Pickleball Manager", email: managerEmail, password: PASSWORD, venueId, role: "manager" });
  if (manager.status >= 300) throw new Error(`manager: ${JSON.stringify(manager.body)}`);
  return { venueId, courtId, name, managerEmail };
}

async function signInManager(a: Actor, email: string) {
  await a.page.goto(`${url}/admin`);
  await a.page.getByLabel("Email").fill(email);
  await a.page.getByLabel("Password").fill(PASSWORD);
  await a.page.getByRole("button", { name: "Sign in" }).click();
  await a.page.getByRole("button", { name: /sign out/i }).waitFor({ timeout: 15_000 });
}

/** My Booking, opened on one booking by its code and the phone it was booked with. */
async function findOnMyBooking(a: Actor, code: string) {
  await a.page.goto(`${url}/my-booking`);
  await a.page.getByLabel("Booking code").fill(code);
  await a.page.getByLabel("Phone number").fill(a.phone);
  await a.page.getByRole("button", { name: "Find my booking" }).click();
  await a.page.getByText(code).first().waitFor();
}

/** The Time line on My Booking. */
const shownTime = (a: Actor) => a.page.locator("dl div").filter({ has: a.page.getByText("Time", { exact: true }) }).locator("dd");

describe("changing a booking's time", () => {
  scenario("Change time 1: a customer moves their booking to a free time; the venue sees it moved", async (s) => {
    const venue = await pickleballVenue(s);
    const customer = await signUp(await s.actor("Customer"));
    const date = dayAhead(5);

    const code = await s.step(customer, "books the court at 10 AM on the venue's page", async () => {
      await customer.page.goto(`${url}/venue/${venue.venueId}?date=${date}&sport=pickleball&court=${venue.courtId}&hour=10&duration=1`);
      await customer.page.getByLabel("Name").fill(`${customer.name} Tester`);
      await customer.page.getByLabel("Phone").fill(customer.phone);
      await customer.page.getByRole("button", { name: /^Book · RM/ }).click();
      await customer.page.getByText("Booking confirmed!").waitFor({ timeout: 15_000 });
      return (await customer.page.getByText(/MS-[A-Z0-9]{4,}/).first().textContent())!.match(/MS-[A-Z0-9]{4,}/)![0];
    });

    await s.step(customer, "finds it on My Booking by its code and phone number", async () => {
      await findOnMyBooking(customer, code);
      expect(await shownTime(customer).textContent()).toBe("10:00 AM – 11:00 AM");
    });

    await s.step(customer, "changes it to 2 PM the same day, from the free times offered", async () => {
      await customer.page.getByRole("button", { name: "Change date or time" }).click();
      await customer.page.getByText("Same length, same booking code.", { exact: false }).waitFor();
      // Its own hour is not offered again; the hour it moves to is.
      expect(await customer.page.getByRole("button", { name: /^10:00 AM–11:00 AM/ }).count()).toBe(0);
      await customer.page.getByRole("button", { name: /^2:00 PM–3:00 PM/ }).click();
      // The price is said before anything changes (ADR 0067): this booking costs the same at 2 PM, and the customer confirms.
      const quote = customer.page.getByTestId("move-quote");
      await quote.getByText(`Change booking ${code} to ${date}, 2:00 PM–3:00 PM?`).waitFor();
      await quote.getByTestId("move-money").first().waitFor();
      await quote.getByRole("button", { name: "Confirm the change" }).click();
      await customer.page.getByRole("status").getByText(`Changed to ${date}, 2:00 PM–3:00 PM.`).waitFor();
      await customer.page.getByText("2:00 PM – 3:00 PM").waitFor();
      expect(await shownTime(customer).textContent()).toBe("2:00 PM – 3:00 PM");
      await customer.page.getByText(code).first().waitFor();
    });

    await s.step(customer, "sees the same code at the new time on their account page", async () => {
      await customer.page.goto(`${url}/account`);
      const card = customer.page.locator("div").filter({ hasText: code }).filter({ hasText: "Cancel booking" }).last();
      await card.getByText(`${weekdayDate(date)} · 2:00 PM – 3:00 PM`).waitFor();
    });

    const manager = await s.actor("Manager");
    await s.step(manager, "finds the booking at its new time on the venue's day list", async () => {
      await signInManager(manager, venue.managerEmail);
      await manager.page.getByLabel("Day to show").fill(date);
      const row = manager.page.locator("tr").filter({ hasText: code });
      await row.getByText("2:00 PM – 3:00 PM").waitFor();
      expect(await manager.page.getByText("10:00 AM – 11:00 AM").count()).toBe(0);
    });
  });

  scenario("Change time 2: a change to a time just taken, and one inside the cut-off, are refused and say why", async (s) => {
    const venue = await pickleballVenue(s, 48);
    const customer = await signUp(await s.actor("Customer"));
    const date = dayAhead(5);
    const far = await bookCourt(customer, venue.courtId, date, 10);
    const near = await bookCourt(customer, venue.courtId, dayAhead(1), 12);

    await s.step(customer, "opens the change for a booking five days away; 3 PM is offered", async () => {
      await findOnMyBooking(customer, far.code);
      await customer.page.getByRole("button", { name: "Change date or time" }).click();
      await customer.page.getByRole("button", { name: /^3:00 PM–4:00 PM/ }).waitFor();
    });

    const other = await signUp(await s.actor("Other"));
    await s.step(other, "meanwhile books 3 PM that day on the venue's page", async () => {
      await other.page.goto(`${url}/venue/${venue.venueId}?date=${date}&sport=pickleball&court=${venue.courtId}&hour=15&duration=1`);
      await other.page.getByLabel("Name").fill(`${other.name} Tester`);
      await other.page.getByLabel("Phone").fill(other.phone);
      await other.page.getByRole("button", { name: /^Book · RM/ }).click();
      await other.page.getByText("Booking confirmed!").waitFor({ timeout: 15_000 });
    });

    await s.step(customer, "picks 3 PM, still on their screen, and is told it is no longer free; the booking stays", async () => {
      customer.page.once("dialog", (d) => void d.accept());
      await customer.page.getByRole("button", { name: /^3:00 PM–4:00 PM/ }).click();
      await customer.page.getByText("That time is not free any more. Please pick another.").waitFor();
      expect(await shownTime(customer).textContent()).toBe("10:00 AM – 11:00 AM");
      await customer.page.getByRole("button", { name: "Close" }).click();
    });

    await s.step(customer, "tries to change tomorrow's booking, inside the venue's 48-hour cut-off: no time is offered, and they are told to call", async () => {
      await findOnMyBooking(customer, near.code);
      await customer.page.getByRole("button", { name: "Change date or time" }).click();
      await customer.page.getByText("Bookings can only be changed at least 48 hours before they start. Please call the venue.").waitFor();
      expect(await customer.page.getByRole("button", { name: /^\d{1,2}:\d{2} [AP]M–/ }).count()).toBe(0);
      expect(await shownTime(customer).textContent()).toBe("12:00 PM – 1:00 PM");
    });

    await s.step(customer, "and both bookings are where they were", async () => {
      for (const [code, hour] of [[far.code, 10], [near.code, 12]] as const) {
        const res = await customer.api("GET", `/api/bookings?code=${code}&phone=${encodeURIComponent(customer.phone)}`);
        expect((res.body.booking as { startHour: number }).startHour).toBe(hour);
      }
    });
  });

  scenario("Change time 3: the venue's staff move a customer's booking from the dashboard; the customer sees the new time", async (s) => {
    const venue = await pickleballVenue(s);
    const customer = await signUp(await s.actor("Customer"));
    const date = dayAhead(6);
    const booking = await bookCourt(customer, venue.courtId, date, 10);
    const manager = await s.actor("Manager");

    await s.step(manager, "finds the booking on its day and changes its time to 4 PM", async () => {
      await signInManager(manager, venue.managerEmail);
      await manager.page.getByLabel("Day to show").fill(date);
      const row = manager.page.locator("tr").filter({ hasText: booking.code });
      await rowAction(row, "Change time");
      await manager.page.getByRole("button", { name: /^4:00 PM–5:00 PM/ }).click();
      const preview = manager.page.getByTestId("move-preview");
      await preview.getByText(`${date}, 4:00 PM–5:00 PM, Court 1`, { exact: false }).waitFor();
      await preview.getByRole("button", { name: "Confirm" }).click();
      await manager.page.getByText(`${booking.code} is now ${date}, 4:00 PM–5:00 PM. Same code`, { exact: false }).waitFor();
      await row.getByText("4:00 PM – 5:00 PM").waitFor();
    });

    await s.step(customer, "sees the same code at 4 PM on their account page", async () => {
      await customer.page.goto(`${url}/account`);
      const card = customer.page.locator("div").filter({ hasText: booking.code }).filter({ hasText: "Cancel booking" }).last();
      await card.getByText(`${weekdayDate(date)} · 4:00 PM – 5:00 PM`).waitFor();
    });
  });
});
