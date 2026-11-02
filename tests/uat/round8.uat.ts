import fs from "fs";
import { describe, expect, inject } from "vitest";
import type { Locator, Page } from "playwright-core";
import { bookCourt, dayAhead, fitsScreen, freeSlot, gone, rowAction, scenario, signInOwner, signUp, url, weekdayDate, type Actor } from "./harness";
import { STAFF_PASSWORD, staffApi, staffSignIn } from "./families";

/**
 * Round 8's workflows as the people involved meet them, each in a browser of
 * their own, on a laptop or a phone:
 *
 * - **Counter AI** (docs/features/payments-and-credit.md#cancelling-a-booking-paid-at-the-counter,
 *   #cash-up): the front desk takes one booking's payment in cash and
 *   another's by QR, cancels the cash one when the customer rings, sees what
 *   was paid and the venue's terms first, and hands the RM20 back from the
 *   till; the payout is listed under the day's bookings, and the desk's
 *   cash-up adds up the day by method.
 * - **Prices AJ** (docs/features/pricing.md#a-managers-price-adjustment): a
 *   booking paid in cash, then lowered by a manager with a reason; the
 *   difference on a credit note of its own for the desk to hand back, which
 *   the customer sees among her receipts and the cash-up counts; a later
 *   cancellation gives back only what is left. The desk is offered no
 *   adjustment.
 * - **Late AK** (docs/features/booking.md#late-cancellations-and-strikes): a
 *   manager lets customers give a court back after the cutoff, nothing
 *   refunded; a customer gives tomorrow's paid court back from her account
 *   page, told so before she confirms; the court is offered again and
 *   somebody else books it.
 * - **Links AL** (docs/features/booking.md#links-that-open-a-booking): the
 *   confirmation email's link opens *My booking* on another device without
 *   the code or phone being typed, keeps it on a refresh, and cancels from
 *   there; the same link with another booking's code opens nothing.
 * - **Waitlist AM** (docs/features/booking.md#leaving-and-turning-an-offer-down):
 *   two people queue on the venue page for a taken court, each emailed that
 *   they are on the list with a link to leave it; the place frees and is
 *   offered to the first, who leaves from the joined email's link instead;
 *   the place passes at once to the second, who claims it.
 * - **Alerts AN** (docs/features/venue-operations.md#booking-alerts): a
 *   manager asks to hear of customers' online cancellations, in Malay; the
 *   desk cancels one booking for a caller (never announced back to the
 *   desk), the customer cancels another online, and the venue's inbox gets
 *   one alert, in Malay, with who, where, when and the code.
 * - **Classes AO** (docs/features/programmes.md#changing-a-class): the front
 *   desk is offered no change of a class's instructor, and refused one asked
 *   for directly; a manager changes it for
 *   the session and the later ones of its weekly series; customers see the
 *   new instructor on the classes page, and the change is in the activity
 *   log.
 *
 * Emails are read from the acceptance server's output (MYSENAM_SEND=log), so
 * the scenarios that read them are skipped against a deployment.
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

/** The one email to this address whose subject matches, once it has gone out. */
async function emailed(address: string, subject: RegExp, timeout = 20_000): Promise<Mail> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const found = emailsTo(address).filter((m) => subject.test(m.subject));
    if (found.length > 1) throw new Error(`${found.length} emails to ${address} match ${subject}`);
    if (found.length === 1) return found[0];
    if (Date.now() > deadline) throw new Error(`No email to ${address} matching ${subject}; sent: ${emailsTo(address).map((m) => m.subject).join(" | ") || "none"}`);
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

const stampOf = () => `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;

interface Venue {
  venueId: number;
  name: string;
  courtIds: number[];
  manager: { email: string; name: string };
  desk: { email: string; name: string };
}

/**
 * A live venue of a scenario's own, made by the platform's owner, with a
 * manager and a front desk: tennis courts at RM20 an hour, or a pool sold by
 * the place (for a class).
 */
async function venueOf(owner: Actor, label: string, kind: "tennis" | "pool" = "tennis"): Promise<Venue> {
  const stamp = stampOf();
  const name = `${label} ${stamp}`;
  const made = await owner.api("POST", "/api/admin/venues", { name, area: "Ampang", address: "2 Jalan Ampang Hilir, Ampang", phone: "03-4251 7788" });
  if (made.status !== 201) throw new Error(`venue: ${JSON.stringify(made.body)}`);
  const venueId = (made.body.venue as { id: number }).id;
  const courts =
    kind === "pool"
      ? [{ sport: "swimming", name: "Pool", offPeakRate: 10, peakRate: 10, capacity: 8, maxPlayers: 8, deposit: 0 }]
      : ["Court 1", "Court 2"].map((n) => ({ sport: "tennis", name: n, offPeakRate: 20, peakRate: 20, capacity: 1, deposit: 0 }));
  const courtIds: number[] = [];
  for (const court of courts) {
    const c = await owner.api("POST", "/api/admin/courts", { venueId, ...court });
    if (c.status >= 300) throw new Error(`court: ${JSON.stringify(c.body)}`);
    courtIds.push(((c.body.courts as { id: number }[] | undefined)?.[0] ?? (c.body.court as { id: number })).id);
  }
  const staff = {
    manager: { email: `r8-manager-${stamp}@uat.mysenam.test`, name: `${label} Manager` },
    desk: { email: `r8-desk-${stamp}@uat.mysenam.test`, name: `${label} Desk` },
  };
  for (const role of ["manager", "desk"] as const) {
    const r = await owner.api("POST", "/api/admin/admins", { name: staff[role].name, email: staff[role].email, password: STAFF_PASSWORD, venueId, role });
    if (r.status >= 300) throw new Error(`${role}: ${JSON.stringify(r.body)}`);
  }
  return { venueId, name, courtIds, ...staff };
}

/** A day on the staff day list, and one booking's row on it. */
async function dayList(a: Actor, date: string): Promise<void> {
  await a.page.getByLabel("Day to show").fill(date);
}
const rowOf = (a: Actor, code: string) => a.page.locator("tr").filter({ hasText: code });

/** A payment taken at the counter from the day list, by the way it was paid (its button's title). */
async function takePayment(row: Locator, via: string | RegExp): Promise<void> {
  await row.getByRole("button", { name: "unpaid" }).click();
  await row.getByTitle(via, { exact: typeof via === "string" }).click();
  await row.getByRole("button", { name: /^✓ / }).waitFor();
}

/** The cash-up on *Credit & passes*, and what one way of paying shows there: taken, given back, in hand. */
const cashUp = (p: Page) => p.locator("section").filter({ has: p.getByRole("heading", { name: "Cash-up", exact: true }) });
async function methodLine(section: Locator, method: RegExp): Promise<string[]> {
  const row = section.locator("table").first().locator("tbody tr").filter({ hasText: method }).first();
  await row.waitFor();
  return (await row.locator("td").allTextContents()).slice(1).map((s) => s.trim());
}
async function totalLine(section: Locator): Promise<string[]> {
  return (await section.locator("table").first().locator("tfoot td").allTextContents()).slice(1).map((s) => s.trim());
}

/** A free tennis hour at the venue, a few days ahead. */
const tennisHour = (venueId: number, fromDay = 2, toDay = 6, hours = [10, 11, 12, 13, 14]) => freeSlot({ sport: "tennis", venueId, fromDay, toDay, hours });

/**
 * The outbox's queued messages sent: what the scheduler does on a live
 * server (it is off on the acceptance server) and staff opening the venue's
 * messages does too, as here.
 */
async function sendQueued(mgrApi: Actor, venueId: number): Promise<void> {
  expect((await mgrApi.api("GET", `/api/admin/messages?venueId=${venueId}`)).status).toBe(200);
}

/** The activity log of a venue, as its manager's API reads it (a check, not the screen). */
async function activity(mgrApi: Actor, venueId: number): Promise<string> {
  return JSON.stringify((await mgrApi.api("GET", `/api/admin/activity?venueId=${venueId}`)).body);
}

describe("money at the counter", () => {
  scenario("Counter AI: the desk takes one booking in cash and another by QR, cancels the cash one and hands RM20 back from the till, seeing first what was paid and the venue's terms; the payout is listed with the day and the cash-up adds up by method", async (s) => {
    const owner = await signInOwner(await s.actor("Owner"));
    const club = await venueOf(owner, "Gelanggang Tenis Ampang");
    const customer = await signUp(await s.actor("Customer"));
    const [first, second] = [await tennisHour(club.venueId), await tennisHour(club.venueId)];
    // Two hours booked online (setup); both paid at the counter, as the scenario does.
    const cashBooking = (await bookCourt(customer, first.courtId, first.date, first.hour)).code;
    const qrBooking = (await bookCourt(customer, second.courtId, second.date, second.hour)).code;
    const desk = await s.actor("Desk");
    const today = dayAhead(0);

    await s.step(desk, "takes RM20 in cash for one booking and RM20 by QR for the other at the counter", async () => {
      await staffSignIn(desk, club.desk.email);
      await dayList(desk, first.date);
      await takePayment(rowOf(desk, cashBooking), "Cash");
      await dayList(desk, second.date);
      await takePayment(rowOf(desk, qrBooking), /e-wallet/);
    });

    await s.step(desk, "cancels the cash booking when the customer rings: told it was paid RM20 in cash today and the venue's terms, hands RM20 back from the till", async () => {
      await dayList(desk, first.date);
      await rowAction(rowOf(desk, cashBooking), "Cancel");
      const panel = desk.page.getByTestId("cancel-panel");
      await panel.getByText(`Cancel booking ${cashBooking}`).waitFor();
      await panel.getByText(/^Paid RM20 by Cash on /).waitFor();
      await panel.getByText("Inside the venue's terms: free to cancel up to 2 h before it starts.").waitFor();
      await panel.getByText("Money handed back at the counter is recorded as paid out by you, on the booking's credit note.").waitFor();
      await panel.getByRole("button", { name: "Hand RM20 back from the till (Cash)" }).click();
      await desk.page.getByText(`Booking ${cashBooking} cancelled. Hand RM20 back from the till.`).waitFor();
      await gone(desk.page.getByTestId("cancel-panel"));
    });

    await s.step(desk, "on today's list, finds the RM20 handed back listed for the till: when, how, the booking and its credit note, and who", async () => {
      await dayList(desk, today);
      const payouts = desk.page.getByTestId("payouts");
      await payouts.getByText(`Handed back at the counter on ${today}`).waitFor();
      const line = payouts.locator("li").filter({ hasText: cashBooking });
      expect(await line.textContent()).toMatch(new RegExp(` · RM20 · Cash · ${cashBooking} \\(\\S+\\) · ${club.desk.name}$`));
      await payouts.getByText("In all: RM20").waitFor();
      expect(await payouts.locator("li").count()).toBe(1);
    });

    await s.step(desk, "counts the drawer on Credit & passes → Cash-up: cash RM20 taken and RM20 given back, nothing in hand; RM20 by QR; RM20 in all, each receipt and the credit note listed with who took or gave it", async () => {
      await desk.page.getByRole("button", { name: "Credit & passes", exact: true }).click();
      const sheet = cashUp(desk.page);
      await sheet.getByText("What you took and gave back yourself", { exact: false }).waitFor();
      expect(await methodLine(sheet, /^Cash/)).toEqual(["RM20", "−RM20", "RM0"]);
      expect(await methodLine(sheet, /e-wallet/)).toEqual(["RM20", "RM0", "RM20"]);
      expect(await totalLine(sheet)).toEqual(["RM40", "−RM20", "RM20"]);
      const entries = sheet.locator("table").nth(1).locator("tbody tr");
      expect(await entries.count()).toBe(3);
      const credit = entries.filter({ hasText: "(credit note)" });
      expect(await credit.count()).toBe(1);
      expect(await credit.textContent()).toContain(club.desk.name);
      expect(await credit.locator("td").last().textContent()).toBe("−RM20");
    });

    await s.step(customer, "sees the cash booking cancelled on her account, and the QR one still booked", async () => {
      const mine = (await customer.api("GET", "/api/my/bookings")).body.bookings as { code: string; status: string; paymentStatus: string }[];
      expect(mine.find((b) => b.code === cashBooking)?.status).toBe("cancelled");
      expect(mine.find((b) => b.code === qrBooking)).toMatchObject({ status: "confirmed", paymentStatus: "paid" });
    });
  });

  scenario("Prices AJ: a manager lowers a price paid in cash, with a reason; the difference on a credit note of its own, among the customer's receipts and in the cash-up; the desk cannot adjust; cancelled, what is left goes back", async (s) => {
    const owner = await signInOwner(await s.actor("Owner"));
    const club = await venueOf(owner, "Kelab Tenis Cheras");
    const mgrApi = await staffApi(await s.actor("Manager API"), club.manager.email);
    const customer = await signUp(await s.actor("Customer"));
    const slot = await tennisHour(club.venueId);
    const code = (await bookCourt(customer, slot.courtId, slot.date, slot.hour)).code;
    const desk = await s.actor("Desk");
    const manager = await s.actor("Manager");

    await s.step(desk, "takes RM20 in cash at the counter; the row offers the desk no price adjustment", async () => {
      await staffSignIn(desk, club.desk.email);
      await dayList(desk, slot.date);
      const row = rowOf(desk, code);
      await takePayment(row, "Cash");
      expect(await row.getByRole("button", { name: "Adjust price" }).count()).toBe(0);
    });

    const note = await s.step(manager, "lowers the price to RM15 because the lights failed last week: told it is paid, so only lower, and that RM5 goes back in cash on a credit note", async () => {
      await staffSignIn(manager, club.manager.email);
      await dayList(manager, slot.date);
      const row = rowOf(manager, code);
      await row.getByRole("button", { name: "Adjust price" }).click();
      await row.getByText("It is paid: the price can only come down. The difference goes on a credit note; give it back by Cash.").waitFor();
      expect(await row.getByLabel("New price").inputValue()).toBe("20");
      await row.getByLabel("New price").fill("15");
      await row.getByLabel("Why (kept with the booking)").fill("The lights failed during last week's game");
      await row.getByRole("button", { name: "Save the price" }).click();
      const done = row.getByText(/^RM5 to give back by Cash, on credit note \S+\.$/);
      await done.waitFor();
      return /credit note (\S+)\.$/.exec((await done.textContent())!)![1];
    });

    await s.step(customer, "finds among her receipts the booking's receipt as sold, RM20, and a credit note of RM5 for the price the venue lowered", async () => {
      const p = customer.page;
      await p.goto(`${url}/account`);
      const receipts = p.locator("section").filter({ has: p.getByRole("heading", { name: "Receipts" }) });
      await receipts.locator("li").filter({ hasText: note }).waitFor();
      expect(await receipts.locator("li").filter({ hasText: note }).textContent()).toMatch(/RM5/);
    });

    await s.step(manager, "reads everybody's cash-up for today: cash RM20 taken, RM5 given back, RM15 in hand", async () => {
      await manager.page.getByRole("button", { name: "Credit & passes", exact: true }).click();
      const sheet = cashUp(manager.page);
      expect(await methodLine(sheet, /^Cash/)).toEqual(["RM20", "−RM5", "RM15"]);
      await sheet.locator("tbody tr").filter({ hasText: note }).waitFor();
    });

    await s.step(desk, "cancels the booking for the customer later: only the RM15 left is handed back", async () => {
      await desk.page.reload();
      await dayList(desk, slot.date);
      await rowAction(rowOf(desk, code), "Cancel");
      const panel = desk.page.getByTestId("cancel-panel");
      await panel.getByRole("button", { name: "Hand RM15 back from the till (Cash)" }).click();
      await desk.page.getByText(`Booking ${code} cancelled. Hand RM15 back from the till.`).waitFor();
    });
    expect(await activity(mgrApi, club.venueId)).toContain("booking.price_adjusted");
  });
});

describe("customers' own changes", () => {
  scenario("Late AK: a manager lets customers give a court back after the cutoff, nothing refunded; a customer gives tomorrow's paid court back from her account, told so before she confirms; the court is offered again and somebody else books it", async (s) => {
    const owner = await signInOwner(await s.actor("Owner"));
    const club = await venueOf(owner, "Kelab Tenis Kelana");
    // Cancelling free until 48 hours before (setup: the venue's own settings).
    const cut = await owner.api("PATCH", `/api/admin/venues/${club.venueId}`, { cancelCutoffHours: 48 });
    expect(cut.status, JSON.stringify(cut.body)).toBe(200);
    const deskApi = await staffApi(await s.actor("Desk API"), club.desk.email);
    const customer = await signUp(await s.actor("Customer", "phone"));
    const slot = await tennisHour(club.venueId, 1, 1, [13, 14, 15, 16, 17, 18, 19, 20]);
    const code = (await bookCourt(customer, slot.courtId, slot.date, slot.hour)).code;
    const paid = await deskApi.api("POST", "/api/admin/payments", { code, paid: true, via: "cash" });
    expect(paid.status, JSON.stringify(paid.body)).toBe(200);
    const manager = await s.actor("Manager");
    const card = (p: Page) => p.locator("div").filter({ hasText: code }).filter({ has: p.getByRole("button", { name: /^(Cancel booking|Give the court back \(no refund\))$/ }) }).last();

    await s.step(manager, "under Cancellations, refunds and no-shows, lets customers give a court back after the cutoff with no refund", async () => {
      await staffSignIn(manager, club.manager.email);
      await manager.page.getByRole("navigation", { name: "Dashboard sections" }).getByRole("button", { name: "Venue details", exact: true }).click();
      const policy = manager.page.locator("div.rounded-xl").filter({ has: manager.page.getByRole("heading", { name: "Cancellations, refunds and no-shows" }) }).last();
      await policy.getByLabel("Still let customers give the court back after the cutoff, with no refund").check();
      await policy.getByRole("button", { name: "Save", exact: true }).click();
      await policy.getByText("Saved.").waitFor();
    });

    await s.step(customer, "on her phone, finds tomorrow's paid booking on her account offering to give the court back, with no refund", async () => {
      await customer.page.goto(`${url}/account`);
      await card(customer.page).getByRole("button", { name: "Give the court back (no refund)" }).waitFor();
      expect(await fitsScreen(customer.page)).toBeLessThanOrEqual(1);
    });

    await s.step(customer, "gives it back: asked first, told nothing is refunded and the venue keeps what she paid; then told it is cancelled, the RM20 she paid kept and nothing refunded", async () => {
      customer.page.once("dialog", (d) => {
        expect(d.message()).toBe(
          "It is past the free-cancellation time: giving the court back refunds nothing, and the venue keeps what you paid. The court is offered to somebody else. Give it back?"
        );
        void d.accept();
      });
      await card(customer.page).getByRole("button", { name: "Give the court back (no refund)" }).click();
      await customer.page.getByText("Cancelled. The venue kept the RM20 you paid; nothing is refunded.").waitFor();
      expect(await customer.page.getByText("the rest goes back", { exact: false }).count()).toBe(0);
      const mine = (await customer.api("GET", "/api/my/bookings")).body.bookings as { code: string; status: string }[];
      expect(mine.find((b) => b.code === code)?.status).toBe("cancelled");
    });

    const other = await signUp(await s.actor("Other"));
    await s.step(other, "finds the hour free again on the venue's page and books it", async () => {
      await other.page.goto(`${url}/venue/${club.venueId}?date=${slot.date}&sport=tennis&court=${slot.courtId}&hour=${slot.hour}&duration=1`);
      await other.page.getByLabel("Name").fill(`${other.name} Tester`);
      await other.page.getByLabel("Phone").fill(other.phone);
      await other.page.getByRole("button", { name: /^Book · RM/ }).click();
      await other.page.getByText("Booking confirmed!").waitFor({ timeout: 15_000 });
    });
  });
});

describe.skipIf(!serverLog)("links the app emails, round 8", () => {
  scenario("Links AL: the confirmation email's link opens My booking on another device without the code or phone typed, keeps it on a refresh, and cancels from there; the link with another booking's code opens nothing", async (s) => {
    const customer = await s.actor("Customer", "phone");
    const slot = await freeSlot({ hours: [13, 14, 15, 16] });
    const strangerSlot = await freeSlot({ hours: [17, 18, 19, 20] });
    const stranger = await signUp(await s.actor("Stranger"));
    const strangers = (await bookCourt(stranger, strangerSlot.courtId, strangerSlot.date, strangerSlot.hour)).code;
    const page = customer.page;

    const code = await s.step(customer, "books a court on her phone without an account, giving her email address", async () => {
      await page.goto(`${url}/venue/${slot.venueId}?date=${slot.date}&sport=badminton&court=${slot.courtId}&hour=${slot.hour}&duration=1`);
      await page.getByLabel("Name").fill("Customer Tester");
      await page.getByLabel("Phone").fill(customer.phone);
      await page.getByLabel("Email (for your code + calendar)").fill(customer.email);
      await page.getByRole("button", { name: /^Book · RM/ }).tap();
      await page.getByText("Booking confirmed!").waitFor({ timeout: 15_000 });
      return (await page.getByText(/MS-[A-Z0-9]{4,}/).first().textContent())!.match(/MS-[A-Z0-9]{4,}/)![0];
    });

    const link = await s.step(customer, "is emailed the confirmation: the code, the day with its weekday, and a link to My booking", async () => {
      const m = await emailed(customer.email, new RegExp(`^Booking ${code} confirmed — `));
      expect(m.text).toContain(`Code: ${code}`);
      expect(m.text).toContain(weekdayDate(slot.date));
      return linkIn(m, /^\/my-booking$/);
    });

    const laptop = await s.actor("Customer at home");
    const shown = (p: Page, label: string) => p.locator("dl div").filter({ has: p.locator("dt", { hasText: label }) }).locator("dd");
    await s.step(laptop, "opens the link on her laptop: My booking shows the booking without the code or phone typed, and a refresh keeps it; the address never holds the phone", async () => {
      const p = laptop.page;
      await p.goto(link);
      await p.locator(".font-mono").filter({ hasText: code }).waitFor();
      expect(await shown(p, "Date").textContent()).toBe(weekdayDate(slot.date));
      expect(await shown(p, "Booked by").textContent()).toContain("Customer Tester");
      await p.reload();
      await p.locator(".font-mono").filter({ hasText: code }).waitFor();
      expect(p.url()).toContain(`code=${code}`);
      expect(p.url()).not.toContain(customer.phone);
    });

    await s.step(laptop, "cancels the booking from there, after a confirm", async () => {
      const p = laptop.page;
      p.once("dialog", (d) => void d.accept());
      await p.getByRole("button", { name: "Cancel booking" }).click();
      await p.getByText("Cancelled", { exact: true }).waitFor();
      const res = await laptop.api("GET", `/api/bookings?code=${code}&phone=${encodeURIComponent(customer.phone)}`);
      expect((res.body.booking as { status: string }).status).toBe("cancelled");
    });

    await s.step(stranger, "given the link with her own booking's code put in it, is shown nothing of either booking", async () => {
      const p = stranger.page;
      const forged = new URL(link);
      forged.searchParams.set("code", strangers);
      await p.goto(forged.toString());
      await p.getByRole("alert").getByText("Booking not found", { exact: false }).waitFor();
      expect(await p.locator("dl").count()).toBe(0);
    });
  });

  scenario("Waitlist AM: two people queue for a taken court on the venue page, each emailed a link to leave; the place frees and is offered to the first, who leaves by the joined email's link instead; the place passes at once to the second, who claims it", async (s) => {
    const owner = await signInOwner(await s.actor("Owner"));
    const club = await venueOf(owner, "Kelab Tenis Setapak");
    const mgrApi = await staffApi(await s.actor("Manager API"), club.manager.email);
    const holder = await signUp(await s.actor("Holder"));
    const slot = await tennisHour(club.venueId, 3, 7, [15, 16, 17]);
    // One court booked at that hour, and the other closed to the public for it (setup): the hour is full.
    const taken = (await bookCourt(holder, slot.courtId, slot.date, slot.hour)).code;
    const otherCourt = club.courtIds.find((c) => c !== slot.courtId)!;
    await bookCourt(holder, otherCourt, slot.date, slot.hour);
    const first = await s.actor("Aisyah");
    const second = await s.actor("Ben");

    const courtName = slot.courtId === club.courtIds[0] ? "Court 1" : "Court 2";
    const join = async (a: Actor, name: string) => {
      const p = a.page;
      await p.goto(`${url}/venue/${club.venueId}?date=${slot.date}&sport=tennis`);
      // The court's row on the grid: the hour taken shows "+", to queue for it (the only one taken there).
      const row = p.getByRole("table").locator("tr").filter({ has: p.locator("td", { hasText: new RegExp(`^${courtName}`) }) });
      await row.getByRole("button", { name: "+", exact: true }).click();
      const dialog = p.getByRole("dialog", { name: courtName });
      await dialog.getByLabel("Name").fill(name);
      await dialog.getByLabel("Phone").fill(a.phone);
      await dialog.getByLabel("Email (for your code + calendar)").fill(a.email);
      await dialog.getByRole("button", { name: "Join waitlist" }).click();
      await p.getByRole("dialog", { name: "You're on the waitlist" }).waitFor();
    };

    await s.step(first, "finds the hour taken on the venue's page and joins its waiting list, giving her email", async () => {
      await join(first, "Aisyah Tester");
    });
    await s.step(second, "joins the same waiting list after her", async () => {
      await join(second, "Ben Tester");
    });

    const leaveLink = await s.step(first, "is emailed that she is on the list, first in line, with the day and its weekday and a link to leave it", async () => {
      await sendQueued(mgrApi, club.venueId);
      const m = await emailed(first.email, /^On the waiting list — /);
      expect(m.text).toContain(weekdayDate(slot.date));
      expect(m.text).toContain("(number 1 in line)");
      return linkIn(m, /^\/waitlist\/leave\/[^/]+$/);
    });
    await emailed(second.email, /^On the waiting list — /);

    await s.step(holder, "cancels one of the two bookings, freeing the court", async () => {
      const r = await holder.api("POST", "/api/bookings/cancel", { code: taken, phone: holder.phone });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    });

    await s.step(first, "is offered the place by email; no longer wanting it, opens the link from the joined email instead, sees what it was for, and leaves the list", async () => {
      await sendQueued(mgrApi, club.venueId);
      await emailed(first.email, /^A place has opened up — /);
      const p = first.page;
      await p.goto(leaveLink);
      await p.getByRole("heading", { name: "Leave the waiting list" }).waitFor();
      await p.getByText(club.name, { exact: false }).waitFor();
      await p.getByText(weekdayDate(slot.date), { exact: false }).waitFor();
      await p.getByRole("button", { name: "Leave the list" }).click();
      await p.getByRole("heading", { name: "You have left the waiting list" }).waitFor();
      await p.getByRole("status").getByText("The next person waiting is asked instead.", { exact: false }).waitFor();
    });

    const offer = await s.step(second, "is offered the place at once, by email, with a link to claim it", async () => {
      await sendQueued(mgrApi, club.venueId);
      const m = await emailed(second.email, /^A place has opened up — /);
      expect(m.text).toContain(weekdayDate(slot.date));
      return linkIn(m, /^\/waitlist\/[^/]+$/);
    });

    await s.step(second, "claims the place from the email's link: it is his, with a code", async () => {
      const p = second.page;
      await p.goto(offer);
      await p.getByRole("button", { name: "Claim my place" }).click();
      await p.getByText("The place is yours").waitFor();
    });

    await s.step(first, "the leave link, opened again, takes nobody off anything and says so", async () => {
      await first.page.goto(leaveLink);
      await first.page.getByText("This link no longer takes anyone off a list", { exact: false }).waitFor();
    });
  });

  scenario("Alerts AN: a manager asks to hear of customers' online cancellations, in Malay; the desk cancels one booking for a caller, never announced back; the customer cancels another online and the venue's inbox gets one alert, in Malay, with who, where, when and the code", async (s) => {
    const owner = await signInOwner(await s.actor("Owner"));
    const club = await venueOf(owner, "Kelab Tenis Bangsar");
    const inbox = `frontdesk-${stampOf()}@uat.mysenam.test`;
    const mgrApi = await staffApi(await s.actor("Manager API"), club.manager.email);
    const customer = await signUp(await s.actor("Customer"));
    const [one, two] = [await tennisHour(club.venueId, 2, 5), await tennisHour(club.venueId, 2, 5)];
    const manager = await s.actor("Manager");
    const desk = await s.actor("Desk");

    await s.step(manager, "under Venue details → New-booking alerts, gives the desk's inbox, chooses alerts written in Bahasa Malaysia, and ticks to hear when a customer cancels online, for bookings within a week", async () => {
      await staffSignIn(manager, club.manager.email);
      await manager.page.getByRole("navigation", { name: "Dashboard sections" }).getByRole("button", { name: "Venue details", exact: true }).click();
      const alerts = manager.page.locator("div.rounded-xl").filter({ has: manager.page.getByRole("heading", { name: "New-booking alerts" }) }).last();
      await alerts.getByLabel("Email").fill(inbox);
      await alerts.getByLabel("Alerts written in").selectOption({ label: "Bahasa Malaysia" });
      await alerts.getByLabel("cancels a booking").check();
      await alerts.locator("label").filter({ hasText: "For bookings starting within" }).locator("select").selectOption({ label: "a week" });
      await alerts.getByRole("button", { name: "Save", exact: true }).click();
      await alerts.getByText("Saved. You will hear about each booking made online.").waitFor();
    });

    // Two bookings made online after that (setup), each announced to the inbox as new.
    const byPhone = (await bookCourt(customer, one.courtId, one.date, one.hour)).code;
    const online = (await bookCourt(customer, two.courtId, two.date, two.hour)).code;

    await s.step(desk, "cancels one booking at the counter for the customer, who rang", async () => {
      await staffSignIn(desk, club.desk.email);
      await dayList(desk, one.date);
      await rowAction(rowOf(desk, byPhone), "Cancel");
      await desk.page.getByTestId("cancel-panel").getByRole("button", { name: "Cancel the booking" }).click();
      await desk.page.getByText(`Booking ${byPhone} cancelled.`).waitFor();
    });

    await s.step(customer, "cancels the other herself on her account page, after a confirm", async () => {
      const p = customer.page;
      await p.goto(`${url}/account`);
      const card = p.locator("div").filter({ hasText: online }).filter({ has: p.getByRole("button", { name: "Cancel booking" }) }).last();
      p.once("dialog", (d) => void d.accept());
      await card.getByRole("button", { name: "Cancel booking" }).click();
      await gone(p.locator("div").filter({ hasText: online }).getByRole("button", { name: "Cancel booking" }));
    });

    await s.step(manager, "the venue's inbox has one cancellation alert, for the customer's own, in Malay: who, her number, the court, the day with its weekday, and the code", async () => {
      await sendQueued(mgrApi, club.venueId);
      const m = await emailed(inbox, /^Tempahan dibatalkan: /);
      expect(m.text).toMatch(/^Satu tempahan telah dibatalkan dalam talian\./);
      expect(m.text).toContain(`${customer.name} Tester, ${customer.phone}`);
      expect(m.text).toContain(`di ${club.name}`);
      expect(m.text).toContain(weekdayDate(two.date, "ms"));
      expect(m.text).toContain(`Kod ${online}.`);
      expect(m.text).not.toContain(byPhone);
      expect(m.subject).not.toMatch(/\b(AM|PM)\b/);
    });
  });
});

describe("changing a class", () => {
  scenario("Classes AO: the front desk is refused changing a class's instructor; a manager changes it for the session and the later ones of its weekly series; customers see the new instructor on the classes page; the change is in the activity log", async (s) => {
    const owner = await signInOwner(await s.actor("Owner"));
    const centre = await venueOf(owner, "Kolam Renang Setapak", "pool");
    const mgrApi = await staffApi(await s.actor("Manager API"), centre.manager.email);
    const slot = await freeSlot({ sport: "swimming", venueId: centre.venueId, fromDay: 3, toDay: 6, hours: [9, 10, 11] });
    const className = `Water confidence ${stampOf()}`;
    // A weekly class for four weeks, one place taken (setup).
    const made = await mgrApi.api("POST", "/api/admin/classes", {
      courtId: centre.courtIds[0],
      name: className,
      instructor: "Cikgu Rina",
      date: slot.date,
      start: slot.hour * 60,
      end: slot.hour * 60 + 60,
      capacity: 6,
      price: 25,
      weeks: 4,
    });
    expect(made.status, JSON.stringify(made.body)).toBeLessThan(300);
    const classId = ((made.body.classes as { id: number }[] | undefined)?.[0] ?? (made.body.class as { id: number })).id;
    const member = await signUp(await s.actor("Member"));
    const enrolled = await member.api("POST", "/api/classes/enrol", { classId, name: "Member Tester", phone: member.phone, email: member.email });
    expect(enrolled.status, JSON.stringify(enrolled.body)).toBeLessThan(300);
    const desk = await s.actor("Desk");
    const manager = await s.actor("Manager");
    const firstRow = (p: Page) => p.locator("tr").filter({ hasText: className }).filter({ hasText: slot.date });
    const editor = (p: Page) => p.getByRole("dialog").or(p.locator("form").filter({ has: p.getByRole("heading", { name: `Change ${className} on ${slot.date}` }) }));

    await s.step(desk, "on Classes, is offered no Change on the session (a manager's to change); asked anyway, the server refuses it", async () => {
      await staffSignIn(desk, centre.desk.email);
      await desk.page.getByRole("button", { name: "Classes", exact: true }).click();
      await firstRow(desk.page).first().waitFor();
      expect(await firstRow(desk.page).getByRole("button", { name: "Change", exact: true }).count()).toBe(0);
      const refused = await desk.api("PATCH", `/api/admin/classes/${classId}`, { instructor: "Coach Hafiz" });
      expect(refused.status).toBe(403);
      expect(String(refused.body.error)).toContain("Front-desk accounts cannot change this.");
    });

    await s.step(manager, "changes the instructor to Coach Hafiz for this session and every later one of the weekly class", async () => {
      await staffSignIn(manager, centre.manager.email);
      await manager.page.getByRole("button", { name: "Classes", exact: true }).click();
      await firstRow(manager.page).getByRole("button", { name: "Change", exact: true }).click();
      const form = editor(manager.page);
      await form.getByText("1 enrolled now.", { exact: false }).waitFor();
      await form.getByLabel("Instructor").fill("Coach Hafiz");
      await form.getByLabel("Also every later session of this weekly class that has not started").check();
      await form.getByRole("button", { name: "Save changes" }).click();
      await manager.page.getByText("Changed 4 sessions.").waitFor();
      // The list is read again after the save, a moment after the message: wait for it rather than count the rows it is replacing.
      await expect.poll(() => manager.page.locator("tr").filter({ hasText: className }).filter({ hasText: "Cikgu Rina" }).count(), { timeout: 15_000 }).toBe(0);
    });

    await s.step(member, "sees each session of the class listed with Coach Hafiz on the classes page, none with Cikgu Rina", async () => {
      await member.page.goto(`${url}/classes`);
      // Each session is one item of the list; other venues' classes (another Cikgu Rina's among them) are not this one.
      const sessions = member.page.locator("li").filter({ hasText: className });
      await sessions.first().getByText(/with Coach Hafiz/).waitFor();
      const shown = await sessions.allTextContents();
      expect(shown.length).toBeGreaterThan(0);
      for (const text of shown) expect(text).toMatch(/with Coach Hafiz/);
      expect(shown.join(" ")).not.toContain("Cikgu Rina");
    });

    expect(await activity(mgrApi, centre.venueId)).toContain("class.changed");
  });
});
