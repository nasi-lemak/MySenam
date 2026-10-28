import fs from "fs";
import { describe, expect, inject } from "vitest";
import type { Page } from "playwright-core";
import { dayAhead, freeSlot, gone, scenario, signInOwner, signUp, url, type Actor } from "./harness";
import { confirmedCode, family, STAFF_PASSWORD, staffApi, staffSignIn, type Child } from "./families";

/**
 * Discounts together, several passes, memberships bought online, guardians a
 * venue recorded by name and number, a private venue's list, a class's
 * waiting list at the counter and competition entries, as the people
 * involved meet them, each in a browser of their own:
 *
 * - **Discounts M** (docs/features/pricing.md#discounts-together): a manager
 *   lets a combinable code go with a concession; one child's concession and
 *   the code on a booking for three; each place's share, the counter and the
 *   receipt; the setting turned back, the form and the API refuse the code.
 * - **Passes N** (#several-passes-for-one-booking): each child's own pass on
 *   the form and at the counter's payment step; balances, the receipt, and
 *   one child taken off giving back her entry only.
 * - **Membership O** (#for-somebody-you-look-after-or-a-family): a child's
 *   own membership and a family one bought online, a member only once paid,
 *   through **a stand-in for Billplz's sandbox** (tests/uat/gateway.ts: not
 *   Billplz, no live call); a members-only session booked; whom the family
 *   membership covers changed.
 * - **Guardians P** (docs/features/venue-operations.md#guardians-without-an-account):
 *   a code to a recorded guardian's number, read from the server's log, to
 *   agree to another adult's request; later, her own account proves the
 *   number and takes the relationship over with a staff code. Runs on a
 *   second server of its own with phone checks on (`phoneCheckingServer`),
 *   since an account can prove a number only there.
 * - **Access Q** (docs/features/booking.md#who-a-venue-is-for-public-members-only-private):
 *   a typed number lets nobody in; linked in the editor, the resident books;
 *   unlinked, refused again.
 * - **Waitlist R**: the desk queues callers for a full class, one in Malay; a
 *   number refused meanwhile is passed over; the offer email is in Malay.
 * - **Competition S** (docs/features/tournaments.md#who-enters-and-how): an
 *   entry at the counter, a guardian entering a child in a box league, a
 *   staff decision emailed to both sides, a stale confirmation refused.
 *
 * Emails and codes are read from the acceptance server's output (it sends
 * with MYSENAM_SEND=log), so the scenarios that need them are skipped against
 * a deployment, as is Membership O, which needs the gateway stand-in.
 */

const serverLog = inject("uatServerLog");

/**
 * The emails the app sent to one address, from its output (MYSENAM_SEND=log
 * writes `[outbox] email → <to>`, the subject, then the text).
 */
function emailsTo(address: string): { subject: string; text: string }[] {
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
async function emailed(address: string, subject: RegExp, timeout = 20_000): Promise<{ subject: string; text: string }> {
  const deadline = Date.now() + timeout;
  for (;;) {
    const found = emailsTo(address).filter((m) => subject.test(m.subject));
    if (found.length > 1) throw new Error(`${found.length} emails to ${address} match ${subject}`);
    if (found.length === 1) return found[0];
    if (Date.now() > deadline) throw new Error(`No email to ${address} matching ${subject}; sent: ${emailsTo(address).map((m) => m.subject).join(" | ") || "none"}`);
    await new Promise((r) => setTimeout(r, 250));
  }
}

interface Centre {
  venueId: number;
  name: string;
  pool: number;
  manager: { email: string; name: string };
  desk: { email: string; name: string };
}

/**
 * A swimming centre of a scenario's own: a pool sold by the place (RM10 a
 * place, `places` of them), with a manager and a front desk. Made by the
 * platform's owner.
 */
async function swimCentre(owner: Actor, label: string, places = 8): Promise<Centre> {
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  const name = `${label} ${stamp}`;
  const made = await owner.api("POST", "/api/admin/venues", { name, area: "Setapak", address: "12 Jalan Genting Kelang, Setapak", phone: "03-4023 5500" });
  if (made.status !== 201) throw new Error(`venue: ${JSON.stringify(made.body)}`);
  const venueId = (made.body.venue as { id: number }).id;
  const c = await owner.api("POST", "/api/admin/courts", { venueId, sport: "swimming", name: "Pool", offPeakRate: 10, peakRate: 10, capacity: places, maxPlayers: places, deposit: 0 });
  if (c.status >= 300) throw new Error(`pool: ${JSON.stringify(c.body)}`);
  const pool = ((c.body.courts as { id: number }[] | undefined)?.[0] ?? (c.body.court as { id: number })).id;
  const staff = {
    manager: { email: `r5-manager-${stamp}@uat.mysenam.test`, name: `${label} Manager` },
    desk: { email: `r5-desk-${stamp}@uat.mysenam.test`, name: `${label} Desk` },
  };
  for (const role of ["manager", "desk"] as const) {
    const r = await owner.api("POST", "/api/admin/admins", { name: staff[role].name, email: staff[role].email, password: STAFF_PASSWORD, venueId, role });
    if (r.status >= 300) throw new Error(`${role}: ${JSON.stringify(r.body)}`);
  }
  return { venueId, name, pool, ...staff };
}

/** The venue's grid at one resource and hour, for an activity. */
const slotLink = (venueId: number, sport: string, courtId: number, date: string, hour: number) =>
  `${url}/venue/${venueId}?date=${date}&sport=${sport}&court=${courtId}&start=${hour * 60}&minutes=60`;

/** On the booking form: the guardian not taking part, these children ticked. */
async function forChildren(page: Page, ticked: string[], all: string[]) {
  const me = page.getByLabel("Me", { exact: true });
  if (await me.isChecked()) await me.click();
  for (const name of all) {
    const box = page.getByLabel(`${name} (booked by you)`);
    if ((await box.isChecked()) !== ticked.includes(name)) await box.click();
  }
}

/** One booking's card on the account page. */
const bookingCard = (page: Page, code: string) => page.locator("div.rounded-xl").filter({ hasText: code });

/** A booking through the API for children the account manages, not the account holder (setup, or the API's own answer). */
function bookChildren(parent: Actor, at: { courtId: number; date: string; hour: number }, kids: Child[], extra: Record<string, unknown> = {}) {
  return parent.api("POST", "/api/bookings", {
    courtId: at.courtId,
    sport: "swimming",
    date: at.date,
    start: at.hour * 60,
    end: at.hour * 60 + 60,
    name: `${parent.name} Tester`,
    phone: parent.phone,
    participantIds: kids.map((k) => k.id),
    customerTakesPart: false,
    ...extra,
  });
}

/** A booking's receipt, opened from My booking with its code and number: its text. */
async function receiptText(page: Page, code: string, phone: string): Promise<string> {
  await page.goto(`${url}/my-booking`);
  await page.getByLabel("Booking code").fill(code);
  await page.getByLabel("Phone number").fill(phone);
  await page.getByRole("button", { name: "Find my booking" }).click();
  const href = await page.getByRole("link", { name: "Receipt ↗" }).getAttribute("href");
  await page.goto(new URL(href!, url).toString());
  const body = page.locator("article");
  await body.waitFor();
  return (await body.textContent())!;
}

describe("discounts together", () => {
  scenario("Discounts M: a code that combines goes with one child's concession; each place's share and the receipt add up; with the setting turned back the form takes the code away and the API refuses it, saying why", async (s) => {
    const owner = await signInOwner(await s.actor("Owner"));
    const centre = await swimCentre(owner, "Kolam Gombak");
    const mgrApi = await staffApi(await s.actor("Manager API"), centre.manager.email);
    // The venue's junior price, for one person's place (setup: Places L drives making it).
    const concession = await mgrApi.api("POST", "/api/admin/concessions", {
      venueId: centre.venueId,
      name: "Junior swimmer",
      percent: 50,
      proof: "their MyKid card",
      sport: "swimming",
      scope: "participant",
    });
    expect(concession.status, JSON.stringify(concession.body)).toBe(200);
    const concessionId = (concession.body.concession as { id: number }).id;
    // A code that does not combine, as most codes the venue has made (setup).
    const plain = await mgrApi.api("POST", "/api/admin/promos", {
      venueId: centre.venueId,
      code: "FAMILY5",
      description: "Five ringgit off a family swim",
      kind: "amount",
      value: 5,
      validFrom: dayAhead(-1),
      validTo: dayAhead(60),
      maxPerCustomer: 5,
    });
    expect(plain.status, JSON.stringify(plain.body)).toBeLessThan(300);
    const {
      parent: mother,
      kids: [amani, bella, chloe],
    } = await family(s, "Mother", ["Amani", "Bella", "Chloe"]);
    const [first, second, third] = [
      await freeSlot({ sport: "swimming", venueId: centre.venueId, fromDay: 3, toDay: 5, hours: [14, 15, 16, 17] }),
      await freeSlot({ sport: "swimming", venueId: centre.venueId, fromDay: 6, toDay: 8, hours: [14, 15, 16, 17] }),
      await freeSlot({ sport: "swimming", venueId: centre.venueId, fromDay: 9, toDay: 11, hours: [14, 15, 16, 17] }),
    ];
    const manager = await s.actor("Manager");
    const page = mother.page;
    const promos = (p: Page) => p.locator("section").filter({ has: p.getByRole("heading", { name: "Promo codes", exact: true }) });

    await s.step(manager, "on Credit & passes, lets a concession price and a code go together where the code allows it, and makes a 10% code that does", async () => {
      await staffSignIn(manager, centre.manager.email);
      await manager.page.getByRole("button", { name: "Credit & passes", exact: true }).click();
      const panel = promos(manager.page);
      await panel.getByText("The concession comes off first; the code is then worked out on the lower price and shared between the places.", { exact: false }).waitFor();
      await panel.getByLabel("A concession price and a code together").selectOption({ label: "Where the code allows it" });
      await panel.getByText("Saved: Where the code allows it.").waitFor();
      await panel.getByLabel("Code", { exact: true }).fill("SPLASH10");
      await panel.getByLabel("What it is for").fill("Ten percent off a swim");
      await panel.getByLabel("Percent").fill("10");
      await panel.getByLabel("Until", { exact: true }).fill(dayAhead(60));
      await panel.getByLabel("Goes with a concession price").check();
      await panel.getByRole("button", { name: "Create code" }).click();
      const row = panel.locator("tr").filter({ hasText: "SPLASH10" });
      await row.getByText(/with a concession price/).waitFor();
      expect(await panel.locator("tr").filter({ hasText: "FAMILY5" }).getByText(/with a concession price/).count()).toBe(0);
    });

    const code = await s.step(mother, "books her three children with Amani on the junior price and the code: the form keeps the code beside the concession; RM30 less RM5 is RM25, and 10% off that leaves RM22.50", async () => {
      await page.goto(slotLink(centre.venueId, "swimming", centre.pool, first.date, first.hour));
      await page.getByRole("button", { name: /^Book · RM/ }).waitFor();
      await forChildren(page, ["Amani", "Bella", "Chloe"], ["Amani", "Bella", "Chloe"]);
      await page.getByRole("button", { name: "Book · RM30" }).waitFor();
      await page.getByLabel("Price").selectOption({ label: "Junior swimmer, 50% off" });
      await page.getByLabel("Whose price is it?").selectOption({ label: "Amani" });
      await page.getByText("A code goes with a concession price only if the code allows it.").waitFor();
      await page.getByLabel("Promo code?").fill("SPLASH10");
      await page.getByRole("button", { name: "Book · RM25" }).waitFor();
      await page.getByRole("button", { name: /^Book · RM/ }).click();
      const booked = await confirmedCode(page);
      await page.locator("dl").locator("div").filter({ hasText: /^Total/ }).getByText(/RM22\.50/).waitFor();
      await page.getByText("Promo discount").waitFor();
      expect(await page.getByText(/Your promo code was not applied/).count()).toBe(0);
      return booked;
    });

    await s.step(mother, "on her account page, sees each child's share of what is owed: RM4.50 for Amani's place (her junior price and her share of the code off), RM9 each for Bella's and Chloe's; RM22.50 together", async () => {
      await page.goto(`${url}/account`);
      const card = bookingCard(page, code);
      await card.getByRole("button", { name: "Take somebody off" }).click();
      const who = card.getByRole("region", { name: "Who is taking part" });
      await who.locator("li").filter({ hasText: "Amani" }).getByText("RM4.50 less to pay.").waitFor();
      for (const name of ["Bella", "Chloe"]) await who.locator("li").filter({ hasText: name }).getByText("RM9 less to pay.").waitFor();
      const options = (await mother.api("GET", `/api/bookings/withdraw?code=${code}&phone=${encodeURIComponent(mother.phone)}`)).body.options as { name: string; price: number }[];
      expect(options.map((o) => [o.name, o.price]).sort()).toEqual([
        ["Amani", 4.5],
        ["Bella", 9],
        ["Chloe", 9],
      ]);
      expect(options.reduce((sum, o) => sum + o.price, 0)).toBeCloseTo(22.5, 2);
    });

    const desk = await s.actor("Desk");
    await s.step(desk, "at the counter, checks Amani's proof only and takes RM22.50 in cash", async () => {
      await staffSignIn(desk, centre.desk.email);
      await desk.page.getByLabel("Day to show").fill(first.date);
      const row = desk.page.locator("tr").filter({ hasText: code });
      await row.getByText(/Junior swimmer for Amani \(RM5 off\): check their proof/).waitFor();
      await row.getByRole("button", { name: "Proof seen" }).click();
      await row.getByRole("button", { name: "12 months" }).click();
      await row.getByText(/Junior swimmer for Amani: proof seen/).waitFor();
      await row.getByRole("button", { name: "unpaid" }).click();
      await row.getByTitle("Cash", { exact: true }).click();
      await row.getByRole("button", { name: /^✓ / }).waitFor();
    });

    await s.step(mother, "reads the receipt: three places RM30, Amani's junior price RM5, the code RM2.50, each its own line, adding up to RM22.50 paid", async () => {
      const text = await receiptText(page, code, mother.phone);
      for (const line of [/3 players, for Amani, Bella, ChloeRM30/, /Junior swimmer price, Amani−RM5/, /Promo SPLASH10−RM2\.50/, /TotalRM22\.50/]) expect(text).toMatch(line);
      expect(text).not.toMatch(/price, (Bella|Chloe)/);
    });

    // With the venue's say still yes, a code that does not combine is refused with its reason (the API, as the venue's app would ask).
    const notCombinable = await bookChildren(mother, second, [amani, bella], { placeConcessions: [{ participantId: amani.id, concessionId }], promoCode: "FAMILY5" });
    expect(notCombinable.status, JSON.stringify(notCombinable.body)).toBe(201);
    expect([notCombinable.body.promoErrorCode, (notCombinable.body.booking as { totalPrice: number }).totalPrice]).toEqual(["STK_NOT_COMBINABLE", 15]);
    expect(notCombinable.body.promoError).toMatch(/concession/i);

    await s.step(manager, "turns the setting back to one discount at a time", async () => {
      const panel = promos(manager.page);
      await panel.getByLabel("A concession price and a code together").selectOption({ label: "Never: one discount at a time" });
      await panel.getByText("Saved: Never: one discount at a time.").waitFor();
    });

    await s.step(mother, "on the form, choosing Amani's junior price now takes the code's field away and says why", async () => {
      await page.goto(slotLink(centre.venueId, "swimming", centre.pool, third.date, third.hour));
      await page.getByRole("button", { name: /^Book · RM/ }).waitFor();
      await forChildren(page, ["Amani", "Chloe"], ["Amani", "Bella", "Chloe"]);
      await page.getByLabel("Promo code?").waitFor();
      await page.getByLabel("Price").selectOption({ label: "Junior swimmer, 50% off" });
      await page.getByLabel("Whose price is it?").selectOption({ label: "Amani" });
      await page.getByText("One discount at a time here: a promo code does not go with a concession price.").waitFor();
      await gone(page.getByLabel("Promo code?"));
      await page.getByRole("button", { name: "Book · RM15" }).waitFor();
    });

    // The API, asked for both all the same: the booking stands at the concession price, the code refused with its reason.
    const refused = await bookChildren(mother, third, [amani, chloe], { placeConcessions: [{ participantId: amani.id, concessionId }], promoCode: "SPLASH10" });
    expect(refused.status, JSON.stringify(refused.body)).toBe(201);
    expect([refused.body.promoErrorCode, (refused.body.booking as { totalPrice: number }).totalPrice]).toEqual(["ONE_DISCOUNT", 15]);
    expect(typeof refused.body.promoError).toBe("string");
  });
});

/** A pass for one child's own place, sold at the counter on their guardian's number and put on her account (setup). */
async function childPass(desk: Actor, centre: Centre, parent: Actor, child: Child, entries = 5): Promise<{ id: number; code: string; name: string }> {
  const name = `Swim pass, ${child.name}`;
  const r = await desk.api("POST", "/api/admin/passes", {
    venueId: centre.venueId,
    name,
    sport: "swimming",
    kind: "session",
    entries,
    entryMinutes: 60,
    price: 40,
    holderName: `${parent.name} Tester`,
    holderPhone: parent.phone,
    accountEmail: parent.email,
    expiresOn: dayAhead(60),
    scope: "participant",
    holderParticipantId: child.id,
  });
  if (r.status >= 300) throw new Error(`pass for ${child.name}: ${r.status} ${JSON.stringify(r.body)}`);
  const pass = r.body.pass as { id: number; code: string };
  return { ...pass, name };
}

/** What is left on each of the account's passes, by name. */
async function passesLeft(parent: Actor): Promise<Record<string, number>> {
  const { passes } = (await parent.api("GET", "/api/my/passes")).body as { passes: { name: string; remaining: number }[] };
  return Object.fromEntries(passes.map((p) => [p.name, p.remaining]));
}

describe("several passes for one booking", () => {
  scenario("Passes N: a guardian pays for two children with each child's own pass on the form; the counter pays another booking with both passes; balances and receipt agree; taking one child off gives back only her entry", async (s) => {
    const owner = await signInOwner(await s.actor("Owner"));
    const centre = await swimCentre(owner, "Kolam Kepong");
    const deskApi = await staffApi(await s.actor("Desk API"), centre.desk.email);
    const {
      parent: mother,
      kids: [amani, bella],
    } = await family(s, "Mother", ["Amani", "Bella"]);
    const [atCounter, online] = [
      await freeSlot({ sport: "swimming", venueId: centre.venueId, fromDay: 3, toDay: 6, hours: [14, 15, 16, 17] }),
      await freeSlot({ sport: "swimming", venueId: centre.venueId, fromDay: 7, toDay: 11, hours: [14, 15, 16, 17] }),
    ];
    // A booking for both, to pay at the counter; the venue then knows the children (setup).
    const unpaid = await bookChildren(mother, atCounter, [amani, bella]);
    expect(unpaid.status, JSON.stringify(unpaid.body)).toBe(201);
    const counterCode = (unpaid.body.booking as { code: string }).code;
    const amanis = await childPass(deskApi, centre, mother, amani);
    const bellas = await childPass(deskApi, centre, mother, bella);
    expect(await passesLeft(mother)).toEqual({ [amanis.name]: 5, [bellas.name]: 5 });
    const page = mother.page;

    const code = await s.step(mother, "books both children and chooses a pass for each person: each child's own pass pays her own place, one entry each", async () => {
      await page.goto(slotLink(centre.venueId, "swimming", centre.pool, online.date, online.hour));
      await page.getByRole("button", { name: /^Book · RM/ }).waitFor();
      await forChildren(page, ["Amani", "Bella"], ["Amani", "Bella"]);
      const passes = page.getByTestId("pass-allocation");
      await passes.getByLabel("Which pass pays for whom").selectOption({ label: "A pass for each person" });
      // Each child is offered her own pass only.
      const amaniPick = passes.getByLabel("Amani", { exact: true });
      expect(await amaniPick.locator("option").allTextContents()).toEqual(["No — pay at the counter", `${amanis.name} · 5 left`]);
      await amaniPick.selectOption({ label: `${amanis.name} · 5 left` });
      await passes.getByLabel("Bella", { exact: true }).selectOption({ label: `${bellas.name} · 5 left` });
      await passes.getByText("Uses 1 of 5").first().waitFor();
      expect(await passes.getByText("Uses 1 of 5").count()).toBe(2);
      await passes.getByText("Each place is paid by its own pass.").waitFor();
      await page.getByRole("button", { name: /^Book · RM/ }).click();
      return confirmedCode(page);
    });

    await s.step(mother, "sees the booking paid and one entry gone from each child's pass", async () => {
      const mine = (await mother.api("GET", "/api/my/bookings")).body.bookings as { code: string; paymentStatus: string }[];
      expect(mine.find((b) => b.code === code)?.paymentStatus).toBe("paid");
      expect(await passesLeft(mother)).toEqual({ [amanis.name]: 4, [bellas.name]: 4 });
    });

    const desk = await s.actor("Desk");
    await s.step(desk, "at the counter, pays the other booking with the passes on the mother's number, one for each child, and the day list shows it paid", async () => {
      await staffSignIn(desk, centre.desk.email);
      await desk.page.getByLabel("Day to show").fill(atCounter.date);
      const row = desk.page.locator("tr").filter({ hasText: counterCode });
      await row.getByRole("button", { name: "unpaid" }).click();
      await row.getByRole("button", { name: "Passes…" }).click();
      const box = row.getByTestId("counter-pass-pay");
      await box.getByLabel("Which pass pays for whom").selectOption({ label: "A pass for each person" });
      await box.getByLabel("Amani", { exact: true }).selectOption({ label: `${amanis.name} · 4 left` });
      await box.getByLabel("Bella", { exact: true }).selectOption({ label: `${bellas.name} · 4 left` });
      await box.getByText("Each place is paid by its own pass.").waitFor();
      await box.getByRole("button", { name: "Pay with these passes" }).click();
      await row.getByRole("button", { name: /^✓ / }).waitFor();
    });
    expect(await passesLeft(mother)).toEqual({ [amanis.name]: 3, [bellas.name]: 3 });

    await s.step(mother, "reads the receipt of the booking she paid with the passes: two places, RM20, paid by pass", async () => {
      const text = await receiptText(page, code, mother.phone);
      for (const line of [/2 players, for Amani, BellaRM20/, /TotalRM20/, /Paid: Pass/]) expect(text).toMatch(line);
    });

    await s.step(mother, "takes Bella off the booking paid by passes: Amani stays booked, and Bella's entry goes back on Bella's pass only", async () => {
      await page.goto(`${url}/account`);
      const card = bookingCard(page, code);
      await card.getByRole("button", { name: "Take somebody off" }).click();
      const who = card.getByRole("region", { name: "Who is taking part" });
      await who.locator("li").filter({ hasText: "Bella" }).getByText(/1 back on the pass/).waitFor();
      page.once("dialog", (d) => void d.accept());
      await who.locator("li").filter({ hasText: "Bella" }).getByRole("button", { name: "Take off" }).click();
      await page.getByText(/^Bella is off the booking\. 1 back on the pass/).waitFor();
      expect(await passesLeft(mother)).toEqual({ [amanis.name]: 3, [bellas.name]: 4 });
      const mine = (await mother.api("GET", "/api/my/bookings")).body.bookings as { code: string; status: string; participantName: string | null }[];
      expect(mine.find((b) => b.code === code)).toMatchObject({ status: "confirmed", participantName: "Amani" });
    });
  });
});

const gateway = inject("uatGateway");

/** On the Billplz stand-in's payment page (tests/uat/gateway.ts, not Billplz): what it asks, then paid. */
async function payOnStandIn(page: Page, amount: string, about: RegExp) {
  await page.getByRole("heading", { name: "Billplz stand-in (acceptance tests only, not Billplz)" }).waitFor({ timeout: 20_000 });
  expect(await page.getByTestId("bill-amount").textContent()).toBe(amount);
  expect(await page.getByTestId("bill-description").textContent()).toMatch(about);
}

describe.skipIf(gateway === null)("memberships bought online", () => {
  scenario("Membership O: a guardian buys a child's own membership online, a member only once paid through the gateway stand-in; the child books a members-only session; a family membership names two children, and whom it covers changes", async (s) => {
    const owner = await signInOwner(await s.actor("Owner"));
    const centre = await swimCentre(owner, "Kolam Ahli");
    const mgrApi = await staffApi(await s.actor("Manager API"), centre.manager.email);
    // A members-only club that takes payment online, through the stand-in's sandbox keys, with a junior and a family plan (setup).
    const members = await mgrApi.api("POST", "/api/admin/venue-access", { venueId: centre.venueId, action: "settings", access: "members", listed: true, note: "" });
    expect(members.status, JSON.stringify(members.body)).toBe(200);
    const { BILLPLZ_STAND_IN } = await import("./gateway");
    const keys = await owner.api("PUT", `/api/admin/venues/${centre.venueId}/payment-settings`, { provider: "billplz", credentials: { ...BILLPLZ_STAND_IN }, sandbox: true, enabled: true });
    expect(keys.status, JSON.stringify(keys.body)).toBe(200);
    for (const plan of [
      { name: "Junior swim", months: 1, price: 30, offeredFor: "participant" },
      // One person put on in place of another each term (docs/features/pricing.md#changing-whom-a-family-membership-covers).
      { name: "Family swim", months: 1, price: 80, offeredFor: "family", familyLimit: 2, coverSwaps: 1 },
    ]) {
      const made = await mgrApi.api("POST", "/api/admin/membership-plans", { venueId: centre.venueId, ...plan });
      expect(made.status, JSON.stringify(made.body)).toBeLessThan(300);
    }
    const {
      parent: mother,
      kids: [amani, bella, chloe],
    } = await family(s, "Mother", ["Amani", "Bella", "Chloe"]);
    const slots = [
      await freeSlot({ sport: "swimming", venueId: centre.venueId, fromDay: 3, toDay: 5, hours: [14, 15, 16, 17] }),
      await freeSlot({ sport: "swimming", venueId: centre.venueId, fromDay: 6, toDay: 8, hours: [14, 15, 16, 17] }),
      await freeSlot({ sport: "swimming", venueId: centre.venueId, fromDay: 9, toDay: 11, hours: [14, 15, 16, 17] }),
    ];
    const page = mother.page;
    const plans = page.locator("section").filter({ has: page.getByRole("heading", { name: /Become a member|Renew your membership|Your membership/ }) });
    const planRow = (name: string) => plans.locator("li").filter({ hasText: name });
    const refusedFor = async (kids: Child[], at = slots[2]) => {
      const r = await bookChildren(mother, at, kids);
      return [r.status, r.body.code];
    };

    // Not a member: a place for Amani on the members' pool is refused (the API, as the form would be).
    expect(await refusedFor([amani], slots[0])).toEqual([409, "ENT_MEMBERS_PLACE"]);

    await s.step(mother, "chooses the junior plan for Amani on the venue page and sees its price and dates before any payment page opens", async () => {
      await page.goto(`${url}/venue/${centre.venueId}`);
      await planRow("Junior swim").getByText("For somebody you look after").waitFor();
      await planRow("Junior swim").getByRole("button", { name: /^Join · RM30/ }).click();
      await planRow("Junior swim").getByRole("radio", { name: "Amani" }).check();
      await planRow("Junior swim").getByRole("button", { name: "See the price and dates" }).click();
      await planRow("Junior swim").getByText(/^Junior swim for Amani: from \d{4}-\d{2}-\d{2} to \d{4}-\d{2}-\d{2}\.$/).waitFor();
      await planRow("Junior swim").getByText(/The membership starts only once the payment is confirmed/).waitFor();
    });

    await s.step(mother, "presses Pay and is on the gateway's page (the stand-in) for RM30, for Amani; nobody is a member yet", async () => {
      await planRow("Junior swim").getByRole("button", { name: "Pay RM30" }).click();
      await payOnStandIn(page, "RM30.00", /Junior swim for Amani/);
      expect(await refusedFor([amani], slots[0])).toEqual([409, "ENT_MEMBERS_PLACE"]);
      const list = (await mgrApi.api("GET", `/api/admin/memberships?venueId=${centre.venueId}`)).body.memberships as unknown[];
      expect(list).toEqual([]);
    });

    await s.step(mother, "pays; back on the site she is told Amani's membership runs from today, and its receipt names Amani", async () => {
      await page.getByRole("button", { name: "Pay", exact: true }).click();
      await page.getByText("Amani is a member").waitFor({ timeout: 20_000 });
      await page.getByText(new RegExp(`^Amani's membership MB-[A-Z0-9-]+ at ${centre.name} runs from ${dayAhead(0)} to `)).waitFor();
      await page.getByRole("link", { name: "Receipt ↗" }).click();
      await page.locator("article").getByText(/Membership MB-[A-Z0-9-]+ for Amani/).waitFor();
    });

    await s.step(mother, "books Amani, not herself, on the members' pool from the booking form: booked", async () => {
      await page.goto(slotLink(centre.venueId, "swimming", centre.pool, slots[0].date, slots[0].hour));
      await page.getByRole("button", { name: /^Book · RM/ }).waitFor();
      await forChildren(page, ["Amani"], ["Amani", "Bella", "Chloe"]);
      await page.getByRole("button", { name: /^Book · RM/ }).click();
      const code = await confirmedCode(page);
      const mine = (await mother.api("GET", "/api/my/bookings")).body.bookings as { code: string; status: string; participantName: string | null }[];
      expect(mine.find((b) => b.code === code)).toMatchObject({ status: "confirmed", participantName: "Amani" });
    });
    // Bella and Chloe are still not members.
    expect(await refusedFor([bella], slots[1])).toEqual([409, "ENT_MEMBERS_PLACE"]);

    await s.step(mother, "buys the family plan naming Bella and Chloe: price and dates first, paid through the stand-in, and the membership is made", async () => {
      await page.goto(`${url}/venue/${centre.venueId}`);
      const row = planRow("Family swim");
      await row.getByText("Family: you and up to 2 people you look after").waitFor();
      await row.getByRole("button", { name: /^Join · RM80/ }).click();
      await row.getByRole("checkbox", { name: "Bella" }).check();
      await row.getByRole("checkbox", { name: "Chloe" }).check();
      await row.getByRole("button", { name: "See the price and dates" }).click();
      await row.getByText(/^Family swim for Me, Bella, Chloe: from /).waitFor();
      await row.getByRole("button", { name: "Pay RM80" }).click();
      await payOnStandIn(page, "RM80.00", /Family swim for Mother Tester, Bella, Chloe/);
      await page.getByRole("button", { name: "Pay", exact: true }).click();
      await page.getByText("You're a member").waitFor({ timeout: 20_000 });
    });
    const both = await bookChildren(mother, slots[1], [bella, chloe]);
    expect(both.status, JSON.stringify(both.body)).toBe(201);

    await s.step(mother, "on the venue page, takes Chloe off the family membership: saved, nothing charged or refunded, and a place for Chloe is refused while Bella's stands", async () => {
      await page.goto(`${url}/venue/${centre.venueId}`);
      const card = page.locator("div").filter({ has: page.getByText(/^Family membership MB-[A-Z0-9-]+, until /) }).last();
      await card.getByText("It covers as many people as its plan allows (2).").waitFor();
      await card.getByText("The price stays as paid: nothing is charged for adding somebody, and nothing is refunded for taking somebody off.").waitFor();
      await card.getByRole("button", { name: "Take Chloe off" }).click();
      await card.getByText("Saved.").waitFor();
      await card.getByText("1 more person can be put on it this term.").waitFor();
      await card.getByRole("button", { name: "Add Chloe" }).waitFor();
      expect(await refusedFor([chloe])).toEqual([409, "ENT_MEMBERS_PLACE"]);
    });

    await s.step(mother, "adds Chloe back, using the term's one place for somebody put on in place of another: she is covered again, and the card says it is full", async () => {
      const card = page.locator("div").filter({ has: page.getByText(/^Family membership MB-[A-Z0-9-]+, until /) }).last();
      await card.getByRole("button", { name: "Add Chloe" }).click();
      await card.getByRole("button", { name: "Take Chloe off" }).waitFor();
      await card.getByText("It covers as many people as its plan allows (2).").waitFor();
      const r = await bookChildren(mother, slots[2], [chloe]);
      expect(r.status, JSON.stringify(r.body)).toBe(201);
    });

    // The venue's list: Amani's own, and the mother's family membership covering Bella and Chloe, both bought online.
    const list = (await mgrApi.api("GET", `/api/admin/memberships?venueId=${centre.venueId}`)).body.memberships as {
      online?: boolean;
      price: number;
      holderParticipantName?: string | null;
      covers?: { name: string }[];
    }[];
    expect(
      list.map((m) => [m.online, m.price, m.holderParticipantName ?? null, (m.covers ?? []).map((c) => c.name).sort()]).sort((a, b) => Number(a[1]) - Number(b[1]))
    ).toEqual([
      [true, 30, "Amani", []],
      [true, 80, null, ["Bella", "Chloe"]],
    ]);
  });
});

describe("who a private venue is for", () => {
  scenario("Access Q: a private venue's resident with only a typed number is refused online; staff link his account in the access editor and he books; unlinked, he is refused again", async (s) => {
    const owner = await signInOwner(await s.actor("Owner"));
    const centre = await swimCentre(owner, "Kondo Seri");
    const mgrApi = await staffApi(await s.actor("Manager API"), centre.manager.email);
    // Free hours, found while the venue is still public (a private one is in no list).
    const slots = [
      await freeSlot({ sport: "swimming", venueId: centre.venueId, fromDay: 3, toDay: 6, hours: [14, 15, 16, 17] }),
      await freeSlot({ sport: "swimming", venueId: centre.venueId, fromDay: 7, toDay: 11, hours: [14, 15, 16, 17] }),
    ];
    // The condominium's pool, for its residents only (setup).
    const made = await mgrApi.api("POST", "/api/admin/venue-access", { venueId: centre.venueId, action: "settings", access: "private", note: "Residents of Kondo Seri only." });
    expect(made.status, JSON.stringify(made.body)).toBe(200);
    const resident = await signUp(await s.actor("Resident"));
    const bookSelf = (at: { date: string; hour: number }) =>
      resident.api("POST", "/api/bookings", { courtId: centre.pool, sport: "swimming", date: at.date, start: at.hour * 60, end: at.hour * 60 + 60, name: "Resident Tester", phone: resident.phone });
    /** The venue's page as the resident sees it: not there for him, or there to book. */
    const refusedOnline = async () => {
      const shown = await resident.page.goto(slotLink(centre.venueId, "swimming", centre.pool, slots[1].date, slots[1].hour));
      expect(shown?.status()).toBe(404);
      expect(await resident.page.getByRole("button", { name: /^Book · RM/ }).count()).toBe(0);
      const r = await bookSelf(slots[1]);
      expect([r.status, r.body.code]).toEqual([409, "PRIVATE_VENUE"]);
    };
    const manager = await s.actor("Manager");
    const editor = (p: Page) => p.locator("div").filter({ has: p.getByText("Who can find and book this venue", { exact: true }) }).last();
    const row = (p: Page) => editor(p).locator("tr").filter({ hasText: resident.phone });

    await s.step(manager, "adds the resident to the list by the number he gives, without an account: the editor says he can be booked only at the counter until linked", async () => {
      await staffSignIn(manager, centre.manager.email);
      await manager.page.getByRole("button", { name: "Venue details", exact: true }).first().click();
      await manager.page.getByRole("button", { name: /^Who it is for/ }).click();
      const e = editor(manager.page);
      await e.getByText(/^Online, a person on the list can book only from the account you link them to: this site cannot check phone numbers/).waitFor();
      await e.getByLabel("Phone", { exact: true }).fill(resident.phone);
      await e.getByLabel("Name", { exact: true }).fill("Resident Tester");
      await e.getByLabel("Unit or number").fill("B-07-2");
      await e.getByRole("button", { name: "Add", exact: true }).click();
      await e.getByText("Added.").waitFor();
      await row(manager.page).getByText("Not linked: an account has this number, unchecked").waitFor();
      await e.getByText(/^Not linked to an account, and their number not checked: 1\. Until you link them, they can be booked only at the counter\./).waitFor();
    });

    await s.step(resident, "with that number typed on his account but not linked, finds no such venue and his booking is refused", async () => {
      await refusedOnline();
    });

    await s.step(manager, "links the entry to the resident's account by his email: the editor names the account", async () => {
      manager.page.once("dialog", (d) => void d.accept(resident.email));
      await row(manager.page).getByRole("button", { name: "Link account" }).click();
      await editor(manager.page).getByText("Linked.").waitFor();
      await row(manager.page).getByText(resident.email).waitFor();
      await gone(editor(manager.page).getByText(/^Not linked to an account, and their number not checked/));
    });

    await s.step(resident, "opens the venue page, private to residents, and books the pool for himself", async () => {
      const page = resident.page;
      await page.goto(slotLink(centre.venueId, "swimming", centre.pool, slots[0].date, slots[0].hour));
      await page.getByText("Private: for residents, staff and approved guests.").waitFor();
      await page.getByRole("button", { name: /^Book · RM/ }).click();
      const code = await confirmedCode(page);
      const mine = (await resident.api("GET", "/api/my/bookings")).body.bookings as { code: string; status: string }[];
      expect(mine.find((b) => b.code === code)?.status).toBe("confirmed");
    });

    await s.step(manager, "unlinks the account: the entry is back to counter only", async () => {
      manager.page.once("dialog", (d) => void d.accept());
      await row(manager.page).getByRole("button", { name: "Unlink" }).click();
      await editor(manager.page).getByText("Unlinked.").waitFor();
      await row(manager.page).getByText("Not linked: an account has this number, unchecked").waitFor();
    });

    await s.step(resident, "is refused online again: no venue page, no booking", async () => {
      await refusedOnline();
    });
  });
});

/** The link in an email that leads into this site: the only one there must be. */
function linkIn(mail: { subject: string; text: string }, path: RegExp): string {
  const links = [...mail.text.matchAll(/https?:\/\/[^\s)]+/g)].map((m) => m[0].replace(/[.,]$/, ""));
  const ours = links.filter((l) => l.startsWith(`${url}/`) && path.test(new URL(l).pathname));
  if (ours.length !== 1) throw new Error(`Expected one ${path} link in "${mail.subject}", found: ${links.join(", ") || "none"}`);
  return ours[0];
}

describe.skipIf(!serverLog)("a class's waiting list at the counter", () => {
  scenario("Waitlist R: the desk queues two callers for a full class, one to be told in Malay; the first caller's number is refused meanwhile and passed over; the place goes to the second, offered by email in Malay, and she claims it", async (s) => {
    const owner = await signInOwner(await s.actor("Owner"));
    const centre = await swimCentre(owner, "Kolam Wangsa Melawati");
    const mgrApi = await staffApi(await s.actor("Manager API"), centre.manager.email);
    const slot = await freeSlot({ sport: "swimming", venueId: centre.venueId, fromDay: 4, toDay: 10, hours: [15, 16, 17] });
    const className = `Aqua aerobics ${slot.date}`;
    // A class of one, taken (setup).
    const made = await mgrApi.api("POST", "/api/admin/classes", {
      courtId: centre.pool,
      name: className,
      instructor: "Cikgu Rina",
      date: slot.date,
      start: slot.hour * 60,
      end: slot.hour * 60 + 60,
      capacity: 1,
      price: 15,
    });
    expect(made.status, JSON.stringify(made.body)).toBeLessThan(300);
    const classId = ((made.body.classes as { id: number }[] | undefined)?.[0] ?? (made.body.class as { id: number })).id;
    const member = await signUp(await s.actor("Member"));
    const enrolled = await member.api("POST", "/api/classes/enrol", { classId, name: "Member Tester", phone: member.phone, email: member.email });
    expect(enrolled.status, JSON.stringify(enrolled.body)).toBeLessThan(300);
    const place = ((enrolled.body.booking ?? (enrolled.body.bookings as unknown[])[0]) as { code: string }).code;
    // Two callers, each with a browser of their own for the email they get; neither has an account.
    const zul = await s.actor("Zul");
    const siti = await s.actor("Siti");
    const desk = await s.actor("Desk");
    const roster = desk.page.locator("div.fixed").filter({ has: desk.page.getByRole("heading", { name: className }) });

    const addCaller = async (who: Actor, name: string, language: string) => {
      const form = roster.locator("form").filter({ hasText: `Waiting list for ${className}` });
      if (!(await form.isVisible())) await roster.getByRole("button", { name: "Add to the waiting list" }).click();
      await form.getByLabel("Name", { exact: true }).fill(name);
      await form.getByLabel("Phone", { exact: true }).fill(who.phone);
      await form.getByLabel("Email (optional)").fill(who.email);
      await form.getByLabel("Language for the offer").selectOption({ label: language });
      await form.getByRole("button", { name: "Add them" }).click();
    };

    await s.step(desk, "opens the full class's list on Classes and queues a caller, Zul, whose offer goes in English", async () => {
      await staffSignIn(desk, centre.desk.email);
      await desk.page.getByRole("button", { name: "Classes", exact: true }).click();
      await desk.page.locator("tr").filter({ hasText: className }).getByRole("button", { name: "1/1" }).click();
      await roster.getByRole("button", { name: "Add to the waiting list" }).click();
      await roster.getByText(/^For somebody who rang or is at the counter\./).waitFor();
      await addCaller(zul, "Zul Hakim", "English");
      await roster.getByText("Added: number 1 in the queue.").waitFor();
    });

    await s.step(desk, "queues a second caller, Siti, choosing Bahasa Malaysia for her offer: the queue shows who put each there and in which language", async () => {
      await addCaller(siti, "Siti Aminah", "Bahasa Malaysia");
      await roster.getByText("Added: number 2 in the queue.").waitFor();
      const queue = roster.locator("li").filter({ hasText: "Siti Aminah" });
      await queue.getByText("offer in Bahasa Malaysia").waitFor();
      await queue.getByText(`At the counter (${centre.desk.name})`).waitFor();
      await roster.locator("li").filter({ hasText: "Zul Hakim" }).getByText("offer in English").waitFor();
    });

    // The venue stops taking Zul's number after he joined (setup: the manager's list of refused numbers).
    const blocked = await mgrApi.api("POST", `/api/admin/venues/${centre.venueId}/blocked-phones`, { phone: zul.phone, reason: "Repeated no-shows" });
    expect(blocked.status, JSON.stringify(blocked.body)).toBeLessThan(300);

    await s.step(member, "cancels her place in the class, freeing it", async () => {
      const r = await member.api("POST", "/api/bookings/cancel", { code: place, phone: member.phone });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    });

    const offer = await s.step(siti, "is sent the offer by email in Malay, with a link to claim the place; Zul, refused meanwhile, is sent nothing", async () => {
      const mail = await emailed(siti.email, /^Ada tempat kosong — /);
      expect(mail.text).toMatch(new RegExp(`^Hai Siti, ada tempat kosong untuk ${className} di ${centre.name}, ${slot.date} `));
      expect(mail.text).toContain("Ia ditahan untuk anda selama 30 minit");
      expect(emailsTo(zul.email).filter((m) => /place has opened up|tempat kosong/.test(m.subject))).toEqual([]);
      return linkIn(mail, /^\/waitlist\/[^/]+$/);
    });

    await s.step(desk, "sees Zul passed over and gone from the queue, and Siti's place held for her", async () => {
      await desk.page.reload();
      await desk.page.getByRole("button", { name: "Classes", exact: true }).click();
      await desk.page.locator("tr").filter({ hasText: className }).getByRole("button", { name: /^\d\/1$/ }).click();
      await roster.locator("li").filter({ hasText: "Siti Aminah" }).getByText("Offered").waitFor();
      expect(await roster.locator("li").filter({ hasText: "Zul Hakim" }).count()).toBe(0);
    });

    await s.step(siti, "opens the link, reads the page in Malay without choosing it (the email's language), and claims the place", async () => {
      await siti.page.goto(offer);
      expect(new URL(offer).searchParams.get("lang")).toBe("ms");
      await siti.page.getByRole("heading", { name: "Ada tempat kosong" }).waitFor();
      await siti.page.getByRole("button", { name: "Tuntut tempat saya" }).click();
      await siti.page.getByText("Tempat ini milik anda").waitFor();
    });
  });
});

/** A live venue with two badminton courts, a manager and a front desk, made by the platform's owner. */
async function badmintonHall(owner: Actor, label: string) {
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  const name = `${label} ${stamp}`;
  const made = await owner.api("POST", "/api/admin/venues", { name, area: "Cheras", address: "5 Jalan Cheras Hartamas, Cheras", phone: "03-9130 2200" });
  if (made.status !== 201) throw new Error(`venue: ${JSON.stringify(made.body)}`);
  const venueId = (made.body.venue as { id: number }).id;
  const courtIds: number[] = [];
  for (const court of ["Court 1", "Court 2"]) {
    const c = await owner.api("POST", "/api/admin/courts", { venueId, sport: "badminton", name: court, offPeakRate: 15, peakRate: 22, capacity: 1, deposit: 0 });
    if (c.status >= 300) throw new Error(`court: ${JSON.stringify(c.body)}`);
    courtIds.push(((c.body.courts as { id: number }[] | undefined)?.[0] ?? (c.body.court as { id: number })).id);
  }
  const staff = {
    manager: { email: `r5-organiser-${stamp}@uat.mysenam.test`, name: `${label} Organiser` },
    desk: { email: `r5-hall-desk-${stamp}@uat.mysenam.test`, name: `${label} Desk` },
  };
  for (const role of ["manager", "desk"] as const) {
    const r = await owner.api("POST", "/api/admin/admins", { name: staff[role].name, email: staff[role].email, password: STAFF_PASSWORD, venueId, role });
    if (r.status >= 300) throw new Error(`${role}: ${JSON.stringify(r.body)}`);
  }
  return { venueId, name, courtIds, ...staff };
}

interface PublicLeague {
  people: { id: number; name: string }[];
  matches: { id: number; a: number; b: number; status: string; score: string | null; winner: number | null; version: number }[];
}

describe("competitions: entries at the counter and by a guardian, decisions told", () => {
  scenario("Competition S: the desk enters a player in a tournament at the counter; a guardian enters her child in a box league; staff decide a disputed result and both sides are emailed; a confirmation of a result changed meanwhile is refused", async (s) => {
    const owner = await signInOwner(await s.actor("Owner"));
    const hall = await badmintonHall(owner, "Dewan Cheras");
    const mgrApi = await staffApi(await s.actor("Manager API"), hall.manager.email);
    // A tournament taking entries, and a box league whose first season starts tomorrow (setup).
    const day = dayAhead(12);
    const tournament = await mgrApi.api("POST", "/api/admin/tournaments", {
      venueId: hall.venueId,
      courtIds: hall.courtIds,
      name: `Cheras Open ${day}`,
      sport: "badminton",
      template: "racket_best_of_3",
      format: "knockout",
      teamSize: 1,
      entryFee: 0,
      maxEntries: 8,
      startsOn: day,
      endsOn: day,
      startMin: 9 * 60,
      endMin: 14 * 60,
      matchMinutes: 40,
      resultsBy: "staff",
    });
    expect(tournament.status, JSON.stringify(tournament.body)).toBe(201);
    const tournamentId = (tournament.body.tournament as { id: number }).id;
    const leagueName = `Cheras box league ${Date.now().toString(36)}`;
    const league = await mgrApi.api("POST", "/api/admin/leagues", { venueId: hall.venueId, name: leagueName, sport: "badminton", fee: 0, startsOn: dayAhead(1) });
    expect(league.status, JSON.stringify(league.body)).toBe(201);
    const leagueId = (league.body.league as { id: number }).id;

    const desk = await s.actor("Desk");
    const walkIn = { name: "Encik Rahman Yusof", phone: `017${String(Date.now()).slice(-7)}` };
    await s.step(desk, "at the counter, enters a walk-in player in the tournament on the name and number he gives: on the entry list as entered at the counter, by whom", async () => {
      const page = desk.page;
      page.on("dialog", (d) => void d.accept());
      await staffSignIn(desk, hall.desk.email);
      await page.getByRole("button", { name: "Tournaments", exact: true }).click();
      await page.locator("li").filter({ hasText: `Cheras Open ${day}` }).getByRole("button", { name: "Open", exact: true }).click();
      await page.getByRole("button", { name: "Enter somebody at the counter" }).click();
      const form = page.locator("form").filter({ has: page.getByRole("heading", { name: "Enter somebody at the counter" }) });
      await form.getByText(/^On the number and name you are given, as for a counter booking/).waitFor();
      await form.getByLabel("Phone number").fill(walkIn.phone);
      await form.getByLabel("Name", { exact: true }).fill(walkIn.name);
      await form.getByRole("button", { name: "Enter", exact: true }).click();
      await page.locator("tr").filter({ hasText: walkIn.name }).getByText(`Entered at the counter by ${hall.desk.name}`).waitFor();
      const shown = (await (await fetch(`${url}/api/tournaments/${tournamentId}`)).json()) as { tournament: { entries: { name: string; status: string }[] } };
      expect(shown.tournament.entries.map((e) => e.name)).toContain(walkIn.name);
    });

    const { parent: mother } = await family(s, "Mother", ["Aisha"]);
    await s.step(mother, "on the league's page, chooses her daughter as who is joining and joins her: the page holds Aisha's place for her", async () => {
      const page = mother.page;
      await page.goto(`${url}/leagues/${leagueId}`);
      await page.getByLabel("Who is joining").selectOption({ label: "Aisha" });
      await page.getByText("Their box-mates will see their name and your phone number, so you can arrange their matches.").waitFor();
      await page.getByRole("button", { name: "Join the league" }).click();
      await page.getByText("Aisha: in the league").waitFor();
    });
    // Two adults join for themselves, and the season starts today with one box of three (setup).
    const ben = await signUp(await s.actor("Ben"));
    const chan = await signUp(await s.actor("Chan"));
    for (const p of [ben, chan]) {
      const joined = await p.api("POST", `/api/leagues/${leagueId}`, { action: "join" });
      expect(joined.status, JSON.stringify(joined.body)).toBeLessThan(300);
    }
    const started = await mgrApi.api("POST", `/api/admin/leagues/${leagueId}`, { action: "start", startsOn: dayAhead(0) });
    expect(started.status, JSON.stringify(started.body)).toBe(200);
    const detail = async () => ((await (await fetch(`${url}/api/leagues/${leagueId}`)).json()) as { league: PublicLeague }).league;
    const d0 = await detail();
    const id = (name: string) => d0.people.find((p) => p.name === name)!.id;
    const [aishaId, benId, chanId] = [id("Aisha"), id("Ben Tester"), id("Chan Tester")];
    const matchOf = (l: PublicLeague, x: number, y: number) => l.matches.find((m) => (m.a === x && m.b === y) || (m.a === y && m.b === x))!;
    const aishaBen = matchOf(d0, aishaId, benId);
    const benChan = matchOf(d0, benId, chanId);

    // Ben reports beating Aisha (the API, as his phone would).
    const reported = await ben.api("POST", `/api/leagues/${leagueId}/matches/${aishaBen.id}`, { action: "report", winner: benId, score: "21-15, 21-17", version: aishaBen.version });
    expect(reported.status, JSON.stringify(reported.body)).toBe(200);

    await s.step(mother, "sees Ben's report on Aisha's match in her box and says it is wrong, with what really happened", async () => {
      const page = mother.page;
      await page.reload();
      const row = page.locator("li").filter({ hasText: "Aisha v Ben Tester" }).or(page.locator("li").filter({ hasText: "Ben Tester v Aisha" }));
      await row.getByText("Ben Tester reported this.").waitFor();
      await row.getByRole("button", { name: "That's wrong" }).click();
      await row.getByPlaceholder("What really happened?").fill("Aisha won in two games, 21-19 and 21-18.");
      await row.getByRole("button", { name: "Send" }).click();
      await row.getByText("Disputed", { exact: false }).waitFor();
    });

    const manager = await s.actor("Manager");
    await s.step(manager, "finds the disputed result on the league and decides it for Aisha, with the score", async () => {
      const page = manager.page;
      await staffSignIn(manager, hall.manager.email);
      await page.getByRole("button", { name: "Leagues", exact: true }).click();
      await page.locator("li").filter({ hasText: leagueName }).getByRole("button", { name: "Open", exact: true }).click();
      const disputed = page.locator("section").filter({ has: page.getByRole("heading", { name: "Disputed results" }) });
      const item = disputed.locator("li").filter({ hasText: "Aisha won in two games" });
      await item.locator("select").selectOption({ label: "Aisha won" });
      await item.getByPlaceholder("21-15, 21-18").fill(aishaBen.a === aishaId ? "21-19, 21-18" : "19-21, 18-21");
      await item.getByRole("button", { name: "Save", exact: true }).click();
      await gone(disputed);
    });

    await s.step(mother, "is emailed what the venue decided about Aisha's match, as Ben is: Aisha won, with the score", async () => {
      const subject = new RegExp(`^${leagueName}: the venue has decided a result$`);
      // The venue's messages (opening them sends what is due, as the scheduler would): one to each side.
      await expect
        .poll(async () => {
          const list = (await mgrApi.api("GET", `/api/admin/messages?venueId=${hall.venueId}`)).body.messages as { recipient: string; subject: string | null; status: string }[];
          return list.filter((m) => subject.test(m.subject ?? "")).map((m) => [m.recipient, m.status]).sort();
        })
        .toEqual([mother.email, ben.email].sort().map((r) => [r, "sent"]));
      for (const who of [mother, ben]) {
        const mail = await emailed(who.email, subject);
        expect(mail.text).toMatch(/The venue's staff decided (Aisha v Ben Tester in .+: Aisha won, 21-19, 21-18 \(Aisha's|Ben Tester v Aisha in .+: Aisha won, 19-21, 18-21 \(Ben Tester's) score first\)\./);
        expect(mail.text).toContain(`${url}/leagues/${leagueId}`);
      }
      expect((await detail()).matches.find((m) => m.id === aishaBen.id)).toMatchObject({ status: "confirmed", winner: aishaId });
    });

    // Chan reports beating Ben (setup, the API).
    const chanReport = await chan.api("POST", `/api/leagues/${leagueId}/matches/${benChan.id}`, { action: "report", winner: chanId, score: "21-10, 21-12" });
    expect(chanReport.status, JSON.stringify(chanReport.body)).toBe(200);
    const benRow = (page: Page) => page.locator("li").filter({ hasText: "Ben Tester v Chan Tester" }).or(page.locator("li").filter({ hasText: "Chan Tester v Ben Tester" }));

    await s.step(ben, "opens the league and sees Chan's report, ready to confirm", async () => {
      await ben.page.goto(`${url}/leagues/${leagueId}`);
      await benRow(ben.page).getByText("Chan Tester reported this.").waitFor();
    });
    // Meanwhile Chan corrects his score.
    const seen = (await detail()).matches.find((m) => m.id === benChan.id)!;
    const corrected = await chan.api("POST", `/api/leagues/${leagueId}/matches/${benChan.id}`, { action: "report", winner: chanId, score: "21-10, 21-14", version: seen.version });
    expect(corrected.status, JSON.stringify(corrected.body)).toBe(200);

    await s.step(ben, "confirms the result as he saw it: refused, because it changed meanwhile; looks again and confirms the corrected one", async () => {
      const page = ben.page;
      await benRow(page).getByRole("button", { name: "Confirm" }).click();
      await page.getByText("The result changed while you were looking at it. Look at it again, then answer.").waitFor();
      expect((await detail()).matches.find((m) => m.id === benChan.id)).toMatchObject({ status: "reported" });
      await page.reload();
      await benRow(page).getByText(/21-14|14-21/).waitFor();
      await benRow(page).getByRole("button", { name: "Confirm" }).click();
      await gone(benRow(page).getByRole("button", { name: "Confirm" }));
      expect((await detail()).matches.find((m) => m.id === benChan.id)).toMatchObject({ status: "confirmed", winner: chanId });
    });
  });
});

/**
 * A second acceptance server, for one scenario, on an install that checks
 * customers' phone numbers (MYSENAM_PHONE_CHECK=on): a guardian a venue
 * recorded by name and number can take their relationship over only from an
 * account that has proved that number, which an install without phone checks
 * (the main acceptance server) has no way to do. The same production build,
 * a fresh in-memory database, MYSENAM_SEND=log, so the codes sent to a number
 * are read from its output (`[phone code] → +<number>: <code>`), which is kept
 * beside the scenario's evidence. Only this process is stopped afterwards.
 */
async function phoneCheckingServer(dir: string): Promise<{ base: string; output: () => string; stop: () => Promise<void> }> {
  const { spawn } = await import("child_process");
  const net = await import("net");
  const path = await import("path");
  const { OWNER } = await import("../e2e/server");
  const port = await new Promise<number>((resolve, reject) => {
    const probe = net.createServer();
    probe.listen(0, () => {
      const { port: p } = probe.address() as import("net").AddressInfo;
      probe.close(() => resolve(p));
    });
    probe.on("error", reject);
  });
  const base = `http://127.0.0.1:${port}`;
  const root = path.join(import.meta.dirname, "..", "..");
  const child = spawn(path.join(root, "node_modules", ".bin", "next"), ["start", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: root,
    env: {
      ...process.env,
      NODE_ENV: "production",
      MYSENAM_DB: ":memory:",
      DATABASE_URL: "",
      MYSENAM_COUNTRY: "MY",
      MYSENAM_SCHEDULER: "off",
      MYSENAM_SEND: "log",
      MYSENAM_GEOCODER: "off",
      MYSENAM_PHONE_CHECK: "on",
      MYSENAM_URL: base,
      ADMIN_EMAIL: OWNER.email,
      ADMIN_PASSWORD: OWNER.password,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  const file = path.join(dir, "server-phone-checks.log");
  const record = (d: Buffer) => {
    log += d;
    fs.appendFileSync(file, d);
  };
  child.stdout?.on("data", record);
  child.stderr?.on("data", record);
  const deadline = Date.now() + 90_000;
  for (;;) {
    try {
      if ((await fetch(`${base}/api/health`)).ok) break;
    } catch {
      // not listening yet
    }
    if (Date.now() > deadline || child.exitCode !== null) throw new Error(`The phone-checking server did not start:\n${log}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  return {
    base,
    output: () => log,
    stop: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
      }),
  };
}

/** This actor's requests go to another server from now on (their own cookies, that server as the origin), its emails read from that server's output. */
function rebase(a: Actor, base: string, output?: () => string): Actor {
  if (output) a.serverOutput = output;
  a.api = async (method, p, body) => {
    const res = await a.context.request.fetch(`${base}${p}`, {
      method,
      headers: { "content-type": "application/json", origin: base },
      data: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status(), body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
  };
  return a;
}

describe.skipIf(!serverLog)("guardians recorded by name and number", () => {
  scenario("Guardians P: a child known at the counter with only a name-and-number guardian; another adult asks; staff send her a code, she reads it back and the request completes; later she registers, proves her number and takes her relationship over with a staff code", async (s) => {
    const server = await phoneCheckingServer(s.dir);
    try {
      const base = server.base;
      const owner = rebase(await s.actor("Owner"), base);
      expect((await owner.api("POST", "/api/admin/auth/login", (await import("../e2e/server")).OWNER)).status).toBe(200);
      const centre = await swimCentre(owner, "Kolam Ampang");
      const guardian = { name: "Puan Tan Mei Ling", phone: `0129${String(Date.now()).slice(-6)}` };
      const at = { date: dayAhead(5), hour: 15 };
      const link = `${base}/venue/${centre.venueId}?date=${at.date}&sport=swimming&court=${centre.pool}&start=${at.hour * 60}&minutes=60`;
      /** The codes this server sent to a number, newest last. */
      const codesTo = (phone: string) => [...server.output().matchAll(new RegExp(`\\[phone code\\] → \\+60${phone.slice(1)}: (\\d{6})`, "g"))].map((m) => m[1]);
      const newCode = async (phone: string, before: number) => {
        await expect.poll(() => codesTo(phone).length).toBeGreaterThan(before);
        return codesTo(phone).at(-1)!;
      };
      const signIn = async (a: Actor, email: string) => {
        await a.page.goto(`${base}/admin`);
        await a.page.getByLabel("Email").fill(email);
        await a.page.getByLabel("Password").fill(STAFF_PASSWORD);
        await a.page.getByRole("button", { name: "Sign in" }).click();
        await a.page.getByRole("button", { name: /sign out/i }).waitFor({ timeout: 15_000 });
      };
      const desk = await s.actor("Desk");
      const page = desk.page;
      page.on("dialog", (d) => void d.accept());
      const panel = page.locator("section").filter({ has: page.getByRole("heading", { name: "Participants: guardians and own logins" }) });
      const lookUp = async () => {
        await page.goto(`${base}/admin`);
        await page.getByRole("button", { name: /sign out/i }).waitFor({ timeout: 15_000 });
        await page.getByRole("button", { name: "Venue details", exact: true }).first().click();
        await panel.getByLabel("Guardian's phone number").fill(guardian.phone);
        await panel.getByRole("button", { name: "Look up" }).click();
        return panel.locator("ul > li").filter({ hasText: "Mei" }).first();
      };

      await s.step(desk, "registers a walk-in's daughter at the counter on her mother's name and number, the mother's declaration made to the desk; the mother has no account", async () => {
        await signIn(desk, centre.desk.email);
        await page.goto(link);
        await page.getByRole("button", { name: /^Book · RM/ }).waitFor();
        await page.getByLabel("Name", { exact: true }).fill(guardian.name);
        await page.getByLabel("Phone", { exact: true }).fill(guardian.phone);
        await page.getByRole("button", { name: "For somebody on this number (a child)?" }).click();
        await page.getByText("Nobody this venue knows on this number.").waitFor();
        await page.getByRole("button", { name: "Add somebody new on this number" }).click();
        await page.getByPlaceholder("Their first name").fill("Mei");
        await page.getByPlaceholder("Birth year (optional)").fill("2015");
        await page.getByLabel("The guardian is their").selectOption({ label: "guardian is their parent" });
        await page.getByLabel(`${guardian.name} told me they are this person's parent`, { exact: false }).check();
        await page.getByRole("button", { name: "Add", exact: true }).click();
        await page.getByRole("checkbox", { name: /^Mei/ }).waitFor();
        await page.getByText(`guardian: ${guardian.name} (parent)`).waitFor();
      });

      const father = rebase(await s.actor("Father"), base, server.output);
      await signUp(father);
      const inviteCode = await s.step(desk, "Mei's father, with an account of his own, asks at the counter to become her guardian too: the desk finds Mei by her mother's number and makes a single-use code for his account", async () => {
        const adultName = "Father Tester";
        await page.goto(link);
        await page.getByRole("button", { name: /^Book · RM/ }).waitFor();
        await page.getByLabel("Name", { exact: true }).fill(adultName);
        await page.getByLabel("Phone", { exact: true }).fill(father.phone);
        await page.getByRole("button", { name: "For somebody on this number (a child)?" }).click();
        await page.getByText("Nobody this venue knows on this number.").waitFor();
        await page.getByRole("button", { name: "An adult not on record asks to become a guardian of a child we know?" }).click();
        const box = page.getByTestId("add-guardian");
        await box.getByLabel("A recorded guardian's number").fill(guardian.phone);
        await box.getByRole("button", { name: "Find", exact: true }).click();
        await box.getByRole("radio", { name: /^Mei\b/ }).check();
        await box.getByLabel(`Email of ${adultName}'s MySenam account (optional: then only that account can accept)`).fill(father.email);
        await box.getByRole("button", { name: `Make an invitation code for ${adultName}` }).click();
        const shown = box.getByRole("status");
        await shown.getByText(`Until it is accepted and agreed, ${adultName} cannot book for Mei or see anything about them.`, { exact: false }).waitFor();
        return (await shown.textContent())!.match(/[A-Z2-9]{5}-[A-Z2-9]{5}/)![0];
      });

      await s.step(father, "accepts the code on his own account with his declaration: waiting for Mei's guardian, nothing about her his yet", async () => {
        const fp = father.page;
        await fp.goto(`${base}/account`);
        const form = fp.locator("section#people").locator("form").filter({ hasText: "Have a code?" });
        await form.getByLabel("Code", { exact: true }).fill(inviteCode);
        await form.getByLabel("If you are becoming their guardian, you are their").selectOption("parent");
        await form.getByLabel(/^If you are becoming their guardian: I am their parent/).check();
        await form.getByRole("button", { name: "Accept", exact: true }).click();
        await fp.locator("section#people").getByText(/^Accepted\./).waitFor();
        const mine = (await father.api("GET", "/api/my/people")).body as { people: { displayName: string }[] };
        expect(mine.people.map((p) => p.displayName)).not.toContain("Mei");
      });

      const sent = codesTo(guardian.phone).length;
      await s.step(desk, "finds Mei by her mother's number under Participants, sees the father's request waiting, and sends the mother a code to agree", async () => {
        const mei = await lookUp();
        await mei.getByText(`${guardian.name}: parent, declared at the counter`).waitFor();
        await mei.getByText("number not checked").waitFor();
        await mei.getByRole("button", { name: `Ask ${guardian.name} to agree: send a code to their number` }).click();
        await panel.getByText(`A code went to the number recorded for ${guardian.name}.`, { exact: false }).first().waitFor();
      });
      const agreeCode = await newCode(guardian.phone, sent);

      await s.step(desk, "enters the code the mother reads back: the request completes, the father now acts for Mei, and the mother's number is known to reach her", async () => {
        const mei = panel.locator("ul > li").filter({ hasText: "Mei" }).first();
        await mei.getByLabel("The code they read out").fill(agreeCode);
        await mei.getByRole("button", { name: "Enter the code" }).click();
        await panel.getByText("Done, and recorded.").waitFor();
        await mei.getByText("number checked by a code").waitFor();
        // The request is no longer waiting for anybody's answer.
        await gone(mei.getByRole("button", { name: `Ask ${guardian.name} to agree: send a code to their number` }));
      });

      await s.step(father, "now manages Mei, beside the guardian the venue recorded", async () => {
        await father.page.goto(`${base}/account`);
        await father.page.locator("section#people").locator("li").filter({ hasText: "Mei" }).getByText(/parent · 1 other guardian\(s\)/).waitFor();
      });

      // Later the mother makes an account with the number the venue recorded (setup: registering).
      const mother = rebase(await s.actor("Mother"), base, server.output);
      mother.phone = guardian.phone;
      await signUp(mother);
      const before = codesTo(guardian.phone).length;
      await s.step(mother, "proves the number on her new account with the code sent to it", async () => {
        const mp = mother.page;
        await mp.goto(`${base}/account/phone`);
        await mp.getByRole("button", { name: /Verify via SMS/ }).click();
        const code = await newCode(guardian.phone, before);
        await mp.getByLabel("Code", { exact: true }).fill(code);
        await mp.getByRole("button", { name: "Check" }).click();
        await mp.getByText("✓ Checked").waitFor();
      });

      const claim = await s.step(desk, "gives the mother, in person, a code to take her relationship over with her account", async () => {
        const mei = await lookUp();
        const row = mei.locator("li").filter({ hasText: `${guardian.name}: parent` });
        await row.getByRole("button", { name: "Code to take it over with an account" }).click();
        const shown = row.getByRole("status");
        await shown.getByText(/only after that account has proved the number recorded for them/).waitFor();
        return (await shown.textContent())!.match(/[A-Z2-9]{5}-[A-Z2-9]{5}/)![0];
      });

      await s.step(mother, "enters the code on her people page with her declaration: she now acts for Mei with this account, as the guardian the venue recorded", async () => {
        const mp = mother.page;
        await mp.goto(`${base}/account`);
        const form = mp.locator("section#people").locator("form").filter({ hasText: "Have a code?" });
        await form.getByLabel("Code", { exact: true }).fill(claim);
        await form.getByLabel("If you are becoming their guardian, you are their").selectOption("parent");
        await form.getByLabel(/^If you are becoming their guardian: I am their parent/).check();
        await form.getByRole("button", { name: "Accept", exact: true }).click();
        await mp.locator("section#people").getByText("Done: you now act for Mei with this account, as the guardian the venue recorded.").waitFor();
        const mine = (await mother.api("GET", "/api/my/people")).body as { people: { displayName: string }[] };
        expect(mine.people.map((p) => p.displayName)).toContain("Mei");
      });

      await s.step(desk, "sees the mother's relationship, the same one begun at the counter, now under her own account's name and signed in with it", async () => {
        const mei = await lookUp();
        await mei.locator("li").filter({ hasText: "Mother Tester: parent, declared at the counter" }).getByText("now signs in with their own account").waitFor();
        expect(await mei.getByRole("button", { name: "Code to take it over with an account" }).count()).toBe(0);
      });
    } finally {
      await server.stop();
    }
  });
});
