import fs from "fs";
import { describe, expect, inject } from "vitest";
import type { Page } from "playwright-core";
import { bookCourt, freeSlot, scenario, signUp, url, type Actor } from "./harness";

/**
 * The links the app emails, followed as the person who receives them would:
 * opened from the email in their own browser, not reached by navigating.
 *
 * - **Email 1**: a booking confirmation's link opens *My booking*, where the
 *   code it gives shows that booking.
 * - **Email 2**: a waiting-list offer's link opens the claim page; claiming
 *   books the place for the person waiting, whose own confirmation then
 *   arrives, and the same link used again offers nothing.
 * - **Email 3**: a password reset's link sets a new password; the old one no
 *   longer signs in, the new one does, and the link cannot be used twice.
 * - **Email 4** (docs/architecture/authentication.md#signing-up): signing up
 *   by an emailed link; the form answers somebody else typing the same
 *   address exactly as it answered the newcomer, and the address is emailed
 *   how to sign in instead, with no link that makes or changes anything.
 *
 * The acceptance server sends with MYSENAM_SEND=log and its output is kept
 * beside the evidence (tests/uat/setup.ts), so the emails are read there.
 * Against a deployment (E2E_URL) there is no such log, and these scenarios are
 * skipped rather than passed.
 */

const serverLog = inject("uatServerLog");

interface Mail {
  subject: string;
  text: string;
}

/** The emails the app sent to one address, from its output (`[outbox] email → <to>`, the subject, then the text). */
function emailsTo(address: string): Mail[] {
  if (!serverLog || !fs.existsSync(serverLog)) return [];
  return fs
    .readFileSync(serverLog, "utf8")
    .split("[outbox] ")
    .filter((chunk) => chunk.startsWith(`email → ${address}\n`))
    .map((chunk) => {
      const lines = chunk.split("\n").slice(1);
      const end = lines.findIndex((l, i) => i > 0 && l.startsWith("["));
      const body = (end < 0 ? lines : lines.slice(0, end)).join("\n").trim();
      return { subject: lines[0], text: body.slice(lines[0].length).trim() };
    });
}

/** The one email to this address whose subject matches, once it has gone out (sending is not awaited by every path). */
async function emailed(address: string, subject: RegExp, timeout = 20_000): Promise<Mail> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const found = emailsTo(address).filter((m) => subject.test(m.subject));
    if (found.length > 1) throw new Error(`${found.length} emails to ${address} match ${subject}`);
    if (found.length === 1) return found[0];
    if (Date.now() > deadline) throw new Error(`No email to ${address} matching ${subject}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** The link in an email that leads into this site: the only one there must be. */
function linkIn(mail: Mail, path: RegExp): string {
  const links = [...mail.text.matchAll(/https?:\/\/[^\s)]+/g)].map((m) => m[0].replace(/[.,]$/, ""));
  const ours = links.filter((l) => l.startsWith(`${url}/`) && path.test(new URL(l).pathname));
  if (ours.length !== 1) throw new Error(`Expected one ${path} link in "${mail.subject}", found: ${links.join(", ") || "none"}`);
  return ours[0];
}

/** *My booking*, looked up with the code and phone, showing the booking. */
async function lookUp(page: Page, code: string, phone: string) {
  await page.getByLabel("Booking code").fill(code);
  await page.getByLabel("Phone number").fill(phone);
  await page.getByRole("button", { name: "Find my booking" }).click();
  await page.locator(".font-mono").filter({ hasText: code }).waitFor();
}

/** A field of the booking shown on *My booking*. */
const shown = (page: Page, label: string) => page.locator("dl div").filter({ has: page.locator("dt", { hasText: label }) }).locator("dd");

describe.skipIf(!serverLog)("following the links the app emails", () => {
  scenario("Email 1: a customer books with their email address; the confirmation email's link opens My booking, where its code shows that booking", async (s) => {
    const customer = await s.actor("Customer");
    const slot = await freeSlot({ hours: [9, 10, 11, 12] });
    const page = customer.page;

    const code = await s.step(customer, "books a court on the venue page, giving an email address for the code", async () => {
      await page.goto(`${url}/venue/${slot.venueId}?date=${slot.date}&sport=badminton&court=${slot.courtId}&hour=${slot.hour}&duration=1`);
      await page.getByLabel("Name").fill("Customer Tester");
      await page.getByLabel("Phone").fill(customer.phone);
      await page.getByLabel("Email (for your code + calendar)").fill(customer.email);
      await page.getByRole("button", { name: /^Book · RM/ }).click();
      await page.getByText("Booking confirmed!").waitFor({ timeout: 15_000 });
      return (await page.getByText(/MS-[A-Z0-9]{4,}/).first().textContent())!.match(/MS-[A-Z0-9]{4,}/)![0];
    });

    const mail = await s.step(customer, "receives one confirmation email naming the code and a link to My booking", async () => {
      const m = await emailed(customer.email, new RegExp(`^Booking ${code} confirmed — `));
      expect(m.text).toContain(`Code: ${code}`);
      expect(m.text).toContain(slot.date);
      return m;
    });

    await s.step(customer, "opens the link from the email in a fresh tab, enters the code, and sees that booking", async () => {
      const link = linkIn(mail, /^\/my-booking$/);
      await page.goto("about:blank");
      await page.goto(link);
      await page.getByRole("button", { name: "Find my booking" }).waitFor();
      await lookUp(page, code, customer.phone);
      expect(await shown(page, "Date").textContent()).toBe(slot.date);
      expect(await shown(page, "Booked by").textContent()).toContain("Customer Tester");
      await page.getByText("Confirmed", { exact: true }).waitFor();
    });
  });

  scenario("Email 2: a place on a full court opens up; the waiting-list offer email's link claims it for the person waiting, their confirmation follows, and the link then offers nothing", async (s) => {
    const first = await signUp(await s.actor("First"));
    const waiter = await signUp(await s.actor("Waiter"));
    const slot = await freeSlot({ hours: [13, 14, 15, 16] });
    // Setup: the court is taken, and the second person waits for it.
    const taken = await bookCourt(first, slot.courtId, slot.date, slot.hour);
    const waits = await waiter.api("POST", "/api/waitlist", {
      courtId: slot.courtId,
      date: slot.date,
      start: slot.hour * 60,
      end: slot.hour * 60 + 60,
      name: "Waiter Tester",
      phone: waiter.phone,
      email: waiter.email,
    });
    expect(waits.status, JSON.stringify(waits.body)).toBeLessThan(300);

    await s.step(first, "cancels the booking, freeing the court", async () => {
      const res = await first.api("POST", "/api/bookings/cancel", { code: taken.code, phone: first.phone });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    });

    const offer = await s.step(waiter, "receives one email saying a place has opened up, with a link to claim it", async () => {
      const m = await emailed(waiter.email, /^A place has opened up — /);
      expect(m.text).toContain(slot.date);
      expect(m.text).toContain("held for you for 30 minutes");
      return linkIn(m, /^\/waitlist\/[^/]+$/);
    });

    await s.step(first, "cannot take the court back while it is held for the person waiting", async () => {
      const again = await first.api("POST", "/api/bookings", { courtId: slot.courtId, date: slot.date, hours: [slot.hour], name: "First Tester", phone: first.phone });
      expect(again.status).toBeGreaterThanOrEqual(400);
    });

    const code = await s.step(waiter, "opens the link from the email and claims the place: it is theirs, with a code", async () => {
      await waiter.page.goto(offer);
      await waiter.page.getByText("A place opened up").waitFor();
      await waiter.page.getByRole("button", { name: "Claim my place" }).click();
      await waiter.page.getByText("The place is yours").waitFor();
      return (await waiter.page.getByText(/MS-[A-Z0-9]{4,}/).first().textContent())!.match(/MS-[A-Z0-9]{4,}/)![0];
    });

    await s.step(waiter, "is sent the booking's confirmation, whose link opens My booking showing it as theirs", async () => {
      const m = await emailed(waiter.email, new RegExp(`^Booking ${code} confirmed — `));
      await waiter.page.goto(linkIn(m, /^\/my-booking$/));
      await lookUp(waiter.page, code, waiter.phone);
      expect(await shown(waiter.page, "Date").textContent()).toBe(slot.date);
      expect(await shown(waiter.page, "Booked by").textContent()).toContain("Waiter Tester");
    });

    await s.step(first, "the same link, opened again by anybody, offers nothing", async () => {
      await first.page.goto(offer);
      await first.page.getByRole("button", { name: "Claim my place" }).click();
      await first.page.getByText("Offer unavailable").waitFor();
      expect(await first.page.getByText("The place is yours").count()).toBe(0);
      const mine = (await first.api("GET", "/api/my/bookings")).body.bookings as { code: string; status: string }[];
      expect(mine.filter((b) => b.status === "confirmed").map((b) => b.code)).not.toContain(code);
    });
  });

  scenario("Email 3: a customer who forgot their password follows the emailed link to set a new one; the old one stops working, the new one signs in, and the link works once", async (s) => {
    const customer: Actor = await signUp(await s.actor("Customer"));
    const page = customer.page;
    const fresh = "a brand-new acceptance password";

    await s.step(customer, "signed out, asks for a link on the forgot-password page", async () => {
      await customer.context.clearCookies();
      await page.goto(`${url}/forgot-password`);
      await page.getByLabel("Email").fill(customer.email);
      await page.getByRole("button", { name: "Email me a link" }).click();
      await page.getByText(/a link is on its way/).waitFor();
    });

    const link = await s.step(customer, "receives one email with a link to set a new password", async () => {
      const m = await emailed(customer.email, /^Set a new password — /);
      return linkIn(m, /^\/reset-password$/);
    });

    await s.step(customer, "opens the link from the email and sets a new password", async () => {
      await page.goto(link);
      await page.getByLabel("New password").fill(fresh);
      await page.getByRole("button", { name: "Save and sign in" }).click();
      await page.getByText("Your password is changed, and you are signed out everywhere else.").waitFor();
    });

    await s.step(customer, "the old password is refused and the new one signs in", async () => {
      await customer.context.clearCookies();
      const old = await customer.api("POST", "/api/auth/login", { email: customer.email, password: customer.password });
      expect(old.status).toBe(401);
      const now = await customer.api("POST", "/api/auth/login", { email: customer.email, password: fresh });
      expect(now.status).toBe(200);
    });

    await s.step(customer, "the same link opened again is refused as used, and sets nothing", async () => {
      await page.goto(link);
      await page.getByLabel("New password").fill("yet another acceptance password");
      await page.getByRole("button", { name: "Save and sign in" }).click();
      await page.getByText("That link has run out or been used. Ask for a new one.").waitFor();
      expect(await page.getByText("Your password is changed").count()).toBe(0);
      await customer.context.clearCookies();
      expect((await customer.api("POST", "/api/auth/login", { email: customer.email, password: "yet another acceptance password" })).status).toBe(401);
      expect((await customer.api("POST", "/api/auth/login", { email: customer.email, password: fresh })).status).toBe(200);
    });
  });

  scenario("Email 4: signing up by the emailed link, which works once; somebody else typing the same address sees the same, and it is emailed how to sign in, with no link", async (s) => {
    const newcomer = await s.actor("Newcomer", "phone");
    const page = newcomer.page;

    const told = await s.step(newcomer, "on Register, gives an email address only and is told to check their email", async () => {
      await page.goto(`${url}/login?mode=register`);
      await page.getByLabel("Email").fill(newcomer.email);
      expect(await page.getByLabel("Password").count()).toBe(0);
      await page.getByRole("button", { name: "Email me a link" }).click();
      const status = page.getByRole("status");
      await status.getByText("Check your email").waitFor();
      return (await status.textContent())!;
    });

    const link = await s.step(newcomer, "receives one email with a link to finish creating the account", async () => {
      const m = await emailed(newcomer.email, /^Finish creating your /);
      return linkIn(m, /^\/register$/);
    });

    await s.step(newcomer, "opens the link, sees the address it is for, gives name, phone and password, and is signed in on the account page", async () => {
      await page.goto(link);
      await page.getByText(`For ${newcomer.email}.`).waitFor();
      await page.getByLabel("Name").fill("Newcomer Tester");
      await page.getByLabel("Phone").fill(newcomer.phone);
      await page.getByLabel("Password").fill(newcomer.password);
      await page.getByRole("button", { name: "Create account" }).click();
      await page.waitForURL(/\/account/);
      expect((await newcomer.api("GET", "/api/auth/me")).body.user).toMatchObject({ email: newcomer.email, name: "Newcomer Tester" });
    });

    await s.step(newcomer, "signed out, the same link opened again makes nothing and says to sign in or ask for a new link", async () => {
      await newcomer.context.clearCookies();
      await page.goto(link);
      await page.getByRole("alert").getByText(/This link cannot be used/).waitFor();
      expect(await page.getByLabel("Password").count()).toBe(0);
    });

    const stranger = await s.actor("Stranger");
    await s.step(stranger, "types the newcomer's address into Register and is shown exactly what the newcomer was", async () => {
      await stranger.page.goto(`${url}/login?mode=register`);
      await stranger.page.getByLabel("Email").fill(newcomer.email);
      await stranger.page.getByRole("button", { name: "Email me a link" }).click();
      const status = stranger.page.getByRole("status");
      await status.getByText("Check your email").waitFor();
      expect(await status.textContent()).toBe(told);
    });

    await s.step(newcomer, "receives an email saying they already have an account, how to sign in and to set a new password, with no link that makes or changes anything", async () => {
      const m = await emailed(newcomer.email, /^You already have a /);
      expect(m.text).not.toMatch(/token=|\/register|\/reset-password/);
      linkIn(m, /^\/login$/);
      linkIn(m, /^\/forgot-password$/);
      expect((await newcomer.api("POST", "/api/auth/login", { email: newcomer.email, password: newcomer.password })).status).toBe(200);
    });
  });
});
