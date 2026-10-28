import fs from "fs";
import { describe, expect, inject } from "vitest";
import type { Dialog, Page } from "playwright-core";
import { dayAhead, fitsScreen, freeSlot, gone, scenario, signInOwner, signUp, url, type Actor } from "./harness";
import { family, STAFF_PASSWORD, staffApi, staffSignIn, type Child } from "./families";

/**
 * Round 6's workflows as the people involved meet them, each in a browser of
 * their own, on a laptop or a phone:
 *
 * - **Guests T** (docs/features/booking.md#residents-inviting-their-own-guests):
 *   a resident invites two guests by email, one with an account and one
 *   without; the screen, the list and the emails are the same for both; the
 *   one with an account follows the emailed link, signs in, accepts and books.
 * - **Coaches U** (docs/features/programmes.md#giving-a-lesson-to-another-coach):
 *   a manager gives a paid lesson to a dearer coach, adjusting the price, and
 *   the desk takes the difference on its own receipt; a lesson paid from
 *   credit goes to a cheaper coach and the difference back to credit with a
 *   credit note; the desk is refused; the customer moves a lesson with its coach.
 * - **Coaches V** (#who-chooses-the-coach): the venue assigns the coach; a
 *   customer books "a lesson" and is told who.
 * - **Membership W** (docs/features/pricing.md#membership-validity): a child's
 *   membership ending before a session refuses it with where to renew; renewed
 *   through **a stand-in for Billplz's sandbox** (tests/uat/gateway.ts: not
 *   Billplz), she is booked; a membership cancelled flags a booking, the desk
 *   is warned and a manager admits her with a note; self check-in is refused.
 * - **Family X** (#changing-whom-a-family-membership-covers): one taken off a
 *   family membership cannot be replaced mid-term, the next term is bought
 *   naming the new list, and a manager corrects a child entered wrongly.
 * - **Places Y** (docs/features/booking.md#taking-one-person-off-a-booking):
 *   one child taken off a booking held by a deposit paid online: the balance,
 *   then the deposit's part going back, said before confirming.
 * - **Malay Z** (docs/integrations/messaging.md): a booking made in Malay is
 *   confirmed by an email in Malay, its times written PG and PTG.
 *
 * Emails are read from the acceptance server's output (MYSENAM_SEND=log), and
 * payments go through the gateway stand-in, so the scenarios that need either
 * are skipped against a deployment.
 */

const serverLog = inject("uatServerLog");
const gateway = inject("uatGateway");

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
 * manager and a front desk: a pool sold by the place (RM10 a place) or
 * tennis courts (RM20 an hour).
 */
async function venueOf(owner: Actor, label: string, kind: "pool" | "tennis"): Promise<Venue> {
  const stamp = stampOf();
  const name = `${label} ${stamp}`;
  const made = await owner.api("POST", "/api/admin/venues", { name, area: "Bangsar", address: "8 Jalan Telawi, Bangsar", phone: "03-2282 6000" });
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
    manager: { email: `r6-manager-${stamp}@uat.mysenam.test`, name: `${label} Manager` },
    desk: { email: `r6-desk-${stamp}@uat.mysenam.test`, name: `${label} Desk` },
  };
  for (const role of ["manager", "desk"] as const) {
    const r = await owner.api("POST", "/api/admin/admins", { name: staff[role].name, email: staff[role].email, password: STAFF_PASSWORD, venueId, role });
    if (r.status >= 300) throw new Error(`${role}: ${JSON.stringify(r.body)}`);
  }
  return { venueId, name, courtIds, ...staff };
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

/** A booking through the API for children the account manages (setup). */
function bookChildren(parent: Actor, at: { courtId: number; date: string; hour: number }, kids: Child[]) {
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
  });
}

/** One booking's card on the account page. */
const bookingCard = (page: Page, code: string) => page.locator("div.rounded-xl").filter({ hasText: code });

/** A venue taking payment online through the Billplz stand-in's sandbox keys (setup by the owner). */
async function paysOnline(owner: Actor, venueId: number) {
  const { BILLPLZ_STAND_IN } = await import("./gateway");
  const keys = await owner.api("PUT", `/api/admin/venues/${venueId}/payment-settings`, { provider: "billplz", credentials: { ...BILLPLZ_STAND_IN }, sandbox: true, enabled: true });
  expect(keys.status, JSON.stringify(keys.body)).toBe(200);
}

/** On the Billplz stand-in's payment page (tests/uat/gateway.ts, not Billplz): what it asks, then paid. */
async function payOnStandIn(page: Page, amount: string, about: RegExp) {
  await page.getByRole("heading", { name: "Billplz stand-in (acceptance tests only, not Billplz)" }).waitFor({ timeout: 20_000 });
  expect(await page.getByTestId("bill-amount").textContent()).toBe(amount);
  expect(await page.getByTestId("bill-description").textContent()).toMatch(about);
  await page.getByRole("button", { name: "Pay", exact: true }).click();
}

/** Dialogs a person answers: confirms accepted, prompts answered with `answer`; each message kept. */
function answerDialogs(page: Page, answer: string): string[] {
  const seen: string[] = [];
  page.on("dialog", (d: Dialog) => {
    seen.push(d.message());
    void (d.type() === "prompt" ? d.accept(answer) : d.accept());
  });
  return seen;
}

// ------------------------------------------------------------------ Guests T

describe.skipIf(!serverLog)("a resident's guests, invited by email without telling who has an account", () => {
  scenario("Guests T: a resident invites two guests by email, one with an account, and is told the same for both; she follows the emailed link, signs in, accepts and books; the list shows linked and invitation sent", async (s) => {
    const owner = await signInOwner(await s.actor("Owner"));
    const condo = await venueOf(owner, "Kondo Mutiara", "pool");
    const pool = condo.courtIds[0];
    const mgrApi = await staffApi(await s.actor("Manager API"), condo.manager.email);
    // A free hour within a guest's three days, found while the venue is still public (a private one is in no list).
    const slot = await freeSlot({ sport: "swimming", venueId: condo.venueId, fromDay: 1, toDay: 2, hours: [14, 15, 16, 17] });
    // The condominium's pool, for residents and their guests; a resident on its list, linked to his account; two guests each (setup).
    const resident = await signUp(await s.actor("Resident"));
    for (const body of [
      { action: "settings", access: "private", note: "Residents of Kondo Mutiara and their guests." },
      { action: "add", phone: resident.phone, name: "Resident Tester", label: "A-12-3", kind: "resident", account: resident.email },
      { action: "guests", perResident: 2, days: 3 },
    ]) {
      const r = await mgrApi.api("POST", "/api/admin/venue-access", { venueId: condo.venueId, ...body });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    // Aisyah has a MySenam account; Ben has none. The resident cannot tell which, and is not told.
    const aisyah = await signUp(await s.actor("Aisyah", "phone"));
    const ben = await s.actor("Ben");
    const page = resident.page;
    const guests = page.locator("section").filter({ has: page.getByRole("heading", { name: "Your guests" }) });
    const card = guests.locator("div.rounded-xl").filter({ hasText: condo.name });

    const invite = async (who: Actor, name: string): Promise<string> => {
      await card.getByRole("button", { name: "Invite a guest" }).click();
      await card.getByLabel("Their phone").fill(who.phone);
      await card.getByLabel("Name (optional)").fill(name);
      await card.getByLabel("Their email (optional)").fill(who.email);
      await card.getByLabel("Days").fill("3");
      await card.getByRole("button", { name: "Add guest" }).click();
      const said = card.getByText(/is on the list\. Invitation submitted/);
      await said.waitFor();
      return (await said.textContent())!;
    };

    const toAisyah = await s.step(resident, "on his account page, invites Aisyah with her phone and email: told she is on the list and that an invitation was submitted, if she can receive one", async () => {
      await page.goto(`${url}/account`);
      await card.getByText("0 of 2 guests · up to 3 days each").waitFor();
      return invite(aisyah, "Aisyah Rahman");
    });
    const toBen = await s.step(resident, "invites Ben the same way: told exactly the same, word for word, though Ben has no account", async () => {
      return invite(ben, "Ben Lee");
    });
    expect(toAisyah).toBe(
      "Aisyah Rahman is on the list. Invitation submitted: if the recipient can receive invitations, they'll receive further instructions. Their bookings count towards your unit's limits."
    );
    expect(toBen.replace("Ben Lee", "Aisyah Rahman")).toBe(toAisyah);

    await s.step(resident, "sees both guests listed the same way: invitation sent, not yet accepted", async () => {
      await page.reload();
      for (const name of ["Aisyah Rahman", "Ben Lee"]) await card.locator("li").filter({ hasText: name }).getByText(/invitation sent, not yet accepted/).waitFor();
      await card.getByText("2 of 2 guests · up to 3 days each").waitFor();
    });

    const link = await s.step(aisyah, "receives the invitation email, the same email Ben receives but for its link: a single-use link to accept with her account", async () => {
      const subject = new RegExp(`^Resident has invited you to ${condo.name}$`);
      const [hers, his] = [await emailed(aisyah.email, subject), await emailed(ben.email, subject)];
      const withoutLink = (m: Mail) => m.text.replace(/https?:\/\/\S+/g, "<link>");
      expect(withoutLink(hers)).toBe(withoutLink(his));
      expect(hers.text).toContain("sign in with the account that uses this email address, or create one with it");
      return linkIn(hers, /^\/guest-invitation$/);
    });

    // Signed in but not yet accepted, Aisyah is not on the list for her account: this install cannot check numbers.
    const before = await aisyah.api("POST", "/api/bookings", { courtId: pool, sport: "swimming", date: slot.date, start: slot.hour * 60, end: slot.hour * 60 + 60, name: "Aisyah Rahman", phone: aisyah.phone });
    expect([before.status, before.body.code]).toEqual([409, "PRIVATE_VENUE"]);
    await aisyah.context.clearCookies();

    await s.step(aisyah, "opens the link on her phone, signed out: asked to sign in with the account that uses this address, or make one", async () => {
      await aisyah.page.goto(link);
      await aisyah.page.getByText("Sign in with the account that uses the email address this invitation was sent to").waitFor();
      expect(await fitsScreen(aisyah.page)).toBeLessThanOrEqual(1);
    });

    await s.step(aisyah, "signs in and comes back to the invitation; accepts it: on the list as a guest until her visit ends, able to book online", async () => {
      const p = aisyah.page;
      await p.getByRole("main").getByRole("link", { name: "Sign in" }).click();
      await p.getByLabel("Email").fill(aisyah.email);
      await p.getByLabel("Password").fill(aisyah.password);
      await p.getByRole("main").getByRole("button", { name: "Sign in", exact: true }).last().click();
      await p.getByRole("button", { name: "Accept invitation" }).click();
      await p.getByText(new RegExp(`^Accepted\\. You are on ${condo.name}'s list as a guest until ${dayAhead(2)}, and can book there online\\.$`)).waitFor();
      expect(await fitsScreen(p)).toBeLessThanOrEqual(1);
    });

    await s.step(aisyah, "goes to the private venue and books the pool for herself", async () => {
      const p = aisyah.page;
      await p.getByRole("link", { name: `Go to ${condo.name}` }).click();
      await p.getByText("Private: for residents, staff and approved guests.").waitFor();
      await p.goto(slotLink(condo.venueId, "swimming", pool, slot.date, slot.hour));
      await p.getByRole("button", { name: /^Book · RM/ }).click();
      await p.getByText("Booking confirmed!").waitFor({ timeout: 15_000 });
      expect(await fitsScreen(p)).toBeLessThanOrEqual(1);
      const mine = (await aisyah.api("GET", "/api/my/bookings")).body.bookings as { status: string; date: string }[];
      expect(mine.filter((b) => b.date === slot.date).map((b) => b.status)).toEqual(["confirmed"]);
    });

    await s.step(resident, "sees Aisyah linked to her account and Ben's invitation still sent, not yet accepted", async () => {
      await page.reload();
      await card.locator("li").filter({ hasText: "Aisyah Rahman" }).getByText("linked to their account").waitFor();
      expect(await card.locator("li").filter({ hasText: "Aisyah Rahman" }).getByText(/invitation sent/).count()).toBe(0);
      await card.locator("li").filter({ hasText: "Ben Lee" }).getByText("invitation sent, not yet accepted").waitFor();
    });
  });
});

// ------------------------------------------------------------------ Coaches U and V

interface Coaches {
  [name: string]: number;
}

/** Coaches of tennis at a venue, each taking lessons 8 AM to 10 PM every day (setup by its manager): their ids by name. */
async function coachesAt(mgrApi: Actor, venueId: number, list: { name: string; rate: number }[]): Promise<Coaches> {
  const hours = [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, from: 8 * 60, until: 22 * 60 }));
  for (const c of list) {
    const r = await mgrApi.api("POST", "/api/admin/coaches", { venueId, name: c.name, bio: "Licensed tennis coach.", sports: ["tennis"], rate: c.rate, hours });
    expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
  }
  const { coaches } = (await mgrApi.api("GET", `/api/admin/coaches?venueId=${venueId}`)).body as { coaches: { id: number; name: string }[] };
  return Object.fromEntries(coaches.map((c) => [c.name, c.id]));
}

/** A lesson as `/api/my/bookings` lists it. */
async function myLesson(a: Actor, code: string) {
  const mine = (await a.api("GET", "/api/my/bookings")).body.bookings as { code: string; coachId: number | null; totalPrice: number; paymentStatus: string; startMin: number; courtId: number }[];
  return mine.find((b) => b.code === code)!;
}

/** The coach a lesson being changed goes with, above its times (the select inside the *Coach* label). */
const coachPick = (page: Page) => page.locator("label").filter({ hasText: /^Coach/ }).locator("select");

describe("lessons given to another coach, and coaches the venue assigns", () => {
  scenario("Coaches U: a paid lesson given to a dearer coach, the difference taken at the desk on its own receipt; one paid from credit to a cheaper coach, the difference back with a credit note; the desk refused; the coach kept on a move", async (s) => {
    const owner = await signInOwner(await s.actor("Owner"));
    const club = await venueOf(owner, "Kelab Tenis Damansara", "tennis");
    const mgrApi = await staffApi(await s.actor("Manager API"), club.manager.email);
    const coach = await coachesAt(mgrApi, club.venueId, [
      { name: "Ana Lim", rate: 80 },
      { name: "Ben Tan", rate: 100 },
      { name: "Cara Ong", rate: 60 },
    ]);
    const customer = await signUp(await s.actor("Customer"));
    const [first, second] = [dayAhead(4), dayAhead(5)];
    const desk = await s.actor("Desk");
    const manager = await s.actor("Manager");
    const rowOf = (a: Actor, code: string) => a.page.locator("tr").filter({ hasText: code });
    const dayList = async (a: Actor, date: string) => {
      await a.page.getByLabel("Day to show").fill(date);
    };

    const lesson1 = await s.step(customer, "books a lesson with Ana Lim on the coach's page: RM20 the court and RM80 the coach", async () => {
      const p = customer.page;
      await p.goto(`${url}/venue/${club.venueId}/coach/${coach["Ana Lim"]}`);
      await p.getByLabel("Pick a day").selectOption(first);
      await p.getByRole("button", { name: "10:00 AM", exact: true }).click();
      await p.getByLabel("Name", { exact: true }).fill("Customer Tester");
      await p.getByLabel("Phone", { exact: true }).fill(customer.phone);
      await p.getByRole("button", { name: "Book 60 min with Ana Lim at 10:00 AM" }).click();
      const done = p.getByText(/^Booked\. Your code is MS-[A-Z0-9]+/);
      await done.waitFor();
      await p.getByText(/With Ana Lim · RM100/).waitFor();
      return (await done.textContent())!.match(/MS-[A-Z0-9]+/)![0];
    });

    await s.step(desk, "takes RM100 in cash for the lesson at the counter", async () => {
      await staffSignIn(desk, club.desk.email);
      await dayList(desk, first);
      const row = rowOf(desk, lesson1);
      await row.getByText(/Lesson with Ana Lim/).waitFor();
      await row.getByRole("button", { name: "unpaid" }).click();
      await row.getByTitle("Cash", { exact: true }).click();
      await row.getByRole("button", { name: /^✓ / }).waitFor();
    });

    await s.step(manager, "gives the paid lesson to Ben Tan: both fees shown first, and asked whether to keep the price or adjust it; chooses to adjust, RM20 more owed at the counter, and confirms at the same time", async () => {
      await staffSignIn(manager, club.manager.email);
      await dayList(manager, first);
      const row = rowOf(manager, lesson1);
      await row.getByRole("button", { name: "Change time" }).click();
      await coachPick(manager.page).selectOption({ label: "Ben Tan" });
      const terms = manager.page.getByTestId("coach-terms");
      await terms.getByText("Ana Lim's fee for this lesson: RM80. Ben Tan's: RM100.").waitFor();
      await terms.getByText("It is paid. Choose what happens to the price:").waitFor();
      await terms.getByText("the venue absorbs the RM20 more the new coach costs, on the record.").waitFor();
      // No time is offered until the money is decided.
      expect(await manager.page.getByRole("button", { name: /^10:00 AM–11:00 AM/ }).count()).toBe(0);
      await terms.getByRole("radio", { name: /^Adjust it: RM20 more owed by the customer, taken at the counter on a receipt of its own\./ }).check();
      const { courtId } = await myLesson(customer, lesson1);
      const courtName = courtId === club.courtIds[0] ? "Court 1" : "Court 2";
      await manager.page.getByRole("button", { name: /^10:00 AM–11:00 AM/ }).filter({ hasText: courtName }).click();
      const preview = manager.page.getByTestId("move-preview");
      await preview.getByText(`${first}, 10:00 AM–11:00 AM, ${courtName}`, { exact: false }).waitFor();
      await preview.getByRole("button", { name: "Confirm" }).click();
      await row.getByText(/Lesson with Ben Tan/).waitFor();
      await row.getByRole("button", { name: "RM20 owed for Ben Tan's fee: take it" }).waitFor();
    });
    // Still paid as sold; RM20 owed beside it.
    expect(await myLesson(customer, lesson1)).toMatchObject({ coachId: coach["Ben Tan"], totalPrice: 100, paymentStatus: "paid" });

    await s.step(desk, "sees what is owed for the dearer coach beside the lesson and takes it in cash: on a receipt of its own", async () => {
      await desk.page.reload();
      await dayList(desk, first);
      const row = rowOf(desk, lesson1);
      await row.getByRole("button", { name: "RM20 owed for Ben Tan's fee: take it" }).click();
      await row.getByTitle("Cash", { exact: true }).click();
      await desk.page.getByText(`RM20 taken for ${lesson1}, on a receipt of its own.`).waitFor();
      await gone(row.getByRole("button", { name: /owed for Ben Tan's fee/ }));
    });

    // The customer's credit, RM200, and a second lesson with Ana paid from it (setup: through the booking API, since the
    // lesson form takes payment at the venue or online).
    const topUp = await mgrApi.api("POST", "/api/admin/wallet", { userId: customer.id, amount: 200, venueId: club.venueId, reason: "Prepaid coaching" });
    expect(topUp.status, JSON.stringify(topUp.body)).toBe(201);
    const booked2 = await customer.api("POST", "/api/bookings", {
      venueId: club.venueId,
      sport: "tennis",
      date: second,
      start: 10 * 60,
      end: 11 * 60,
      name: "Customer Tester",
      phone: customer.phone,
      email: customer.email,
      coachId: coach["Ana Lim"],
      payFromWallet: true,
    });
    expect(booked2.status, JSON.stringify(booked2.body)).toBe(201);
    const lesson2 = (booked2.body.booking as { code: string }).code;
    const credit = async () => (await customer.api("GET", `/api/my/wallet?venueId=${club.venueId}`)).body.balance as number;
    expect([(await myLesson(customer, lesson2)).paymentStatus, await credit()]).toEqual(["paid", 100]);

    await s.step(desk, "tries to give the second lesson to Cara Ong: refused, only a manager can", async () => {
      await dayList(desk, second);
      const row = rowOf(desk, lesson2);
      await row.getByRole("button", { name: "Change time" }).click();
      await coachPick(desk.page).selectOption({ label: "Cara Ong" });
      const terms = desk.page.getByTestId("coach-terms");
      await terms.getByRole("radio", { name: /^Adjust it:/ }).check();
      await desk.page.getByRole("button", { name: /^10:00 AM–11:00 AM/ }).first().click();
      await desk.page.getByText("Only a manager can give a lesson to another coach.").waitFor();
      expect((await myLesson(customer, lesson2)).coachId).toBe(coach["Ana Lim"]);
    });

    await s.step(manager, "gives the second lesson, paid from credit, to Cara Ong and adjusts the price: RM20 back to the customer's credit, with a credit note", async () => {
      await manager.page.reload();
      await dayList(manager, second);
      const row = rowOf(manager, lesson2);
      await row.getByRole("button", { name: "Change time" }).click();
      await coachPick(manager.page).selectOption({ label: "Cara Ong" });
      const terms = manager.page.getByTestId("coach-terms");
      await terms.getByText("Ana Lim's fee for this lesson: RM80. Cara Ong's: RM60.").waitFor();
      await terms.getByRole("radio", { name: /^Adjust it: RM20 back to the customer's credit, with a credit note\./ }).check();
      const { courtId } = await myLesson(customer, lesson2);
      await manager.page.getByRole("button", { name: /^10:00 AM–11:00 AM/ }).filter({ hasText: courtId === club.courtIds[0] ? "Court 1" : "Court 2" }).click();
      await manager.page.getByTestId("move-preview").getByRole("button", { name: "Confirm" }).click();
      await row.getByText(/Lesson with Cara Ong/).waitFor();
    });

    await s.step(customer, "has RM20 back on her credit, a credit note for the difference among her receipts, and an email saying so", async () => {
      expect(await credit()).toBe(120);
      const p = customer.page;
      await p.goto(`${url}/account`);
      const receipts = p.locator("section").filter({ has: p.getByRole("heading", { name: "Receipts" }) });
      const note = receipts.locator("li").filter({ hasText: /Coaching with Cara Ong in place of Ana Lim/ });
      await note.getByText("−RM20").waitFor();
      await note.getByRole("link", { name: "Credit note" }).waitFor();
      if (serverLog) {
        const mail = await emailed(customer.email, new RegExp(`^Your lesson ${lesson2} is now with Cara Ong — `));
        expect(mail.text).toContain("RM20 has gone back to your credit at the venue.");
      }
    });

    await s.step(customer, "moves her first lesson to another time on My booking: told it keeps its coach, offered no other coach, and it stays with Ben Tan", async () => {
      const p = customer.page;
      await p.goto(`${url}/my-booking`);
      await p.getByLabel("Booking code").fill(lesson1);
      await p.getByLabel("Phone number").fill(customer.phone);
      await p.getByRole("button", { name: "Find my booking" }).click();
      await p.getByRole("button", { name: "Change date or time" }).click();
      await p.getByText("Your lesson keeps its coach: the times shown are when they take lessons and are free. To change the coach, ask the venue.").waitFor();
      expect(await coachPick(p).count()).toBe(0);
      p.once("dialog", (d) => void d.accept());
      await p.getByRole("button", { name: /^2:00 PM–3:00 PM/ }).first().click();
      await p.getByText(/^Changed to .*2:00 PM–3:00 PM/).waitFor();
      expect(await myLesson(customer, lesson1)).toMatchObject({ coachId: coach["Ben Tan"], startMin: 14 * 60 });
    });
  });

  scenario("Coaches V: the venue switches to assigning the coach; a customer on her phone books a tennis lesson by time and is told which coach she has", async (s) => {
    const owner = await signInOwner(await s.actor("Owner"));
    const club = await venueOf(owner, "Kelab Tenis Ampang", "tennis");
    const mgrApi = await staffApi(await s.actor("Manager API"), club.manager.email);
    const coach = await coachesAt(mgrApi, club.venueId, [
      { name: "Ana Lim", rate: 80 },
      { name: "Ben Tan", rate: 100 },
    ]);
    const day = dayAhead(4);
    // Ana already has a lesson at 10 AM that day, booked while customers still chose (setup).
    const regular = await signUp(await s.actor("Regular"));
    const taken = await regular.api("POST", "/api/bookings", { venueId: club.venueId, sport: "tennis", date: day, start: 600, end: 660, name: "Regular Tester", phone: regular.phone, coachId: coach["Ana Lim"] });
    expect(taken.status, JSON.stringify(taken.body)).toBe(201);
    const manager = await s.actor("Manager");

    await s.step(manager, "under Classes, sets who chooses the coach of a new lesson to the venue", async () => {
      await staffSignIn(manager, club.manager.email);
      await manager.page.getByRole("button", { name: "Classes", exact: true }).click();
      const choice = manager.page.getByLabel("Who chooses the coach of a new lesson");
      await choice.selectOption({ label: "The venue assigns a free coach" });
      await expect.poll(async () => (await mgrApi.api("GET", `/api/admin/coaches?venueId=${club.venueId}`)).body.choice).toBe("venue");
    });

    const customer = await signUp(await s.actor("Customer", "phone"));
    const p = customer.page;
    await s.step(customer, "on the venue page, sees the coaches listed for who they are and one way to book: a tennis lesson", async () => {
      await p.goto(`${url}/venue/${club.venueId}`);
      await p.getByText("The venue gives each lesson a coach who is free at the time you pick.").first().waitFor();
      expect(await p.getByRole("link", { name: "Book a lesson", exact: true }).count()).toBe(0);
      await p.getByRole("link", { name: /^Book a tennis lesson$/i }).click();
      await p.getByRole("heading", { name: /Book a tennis lesson/i }).waitFor();
      await p.getByText("Coach's fee RM80 to RM100 an hour, depending on the coach, plus the court").waitFor();
      expect(await fitsScreen(p)).toBeLessThanOrEqual(1);
    });

    const code = await s.step(customer, "picks the day and 10 AM, when Ana is already teaching, and books: told her coach is Ben Tan", async () => {
      await p.getByLabel("Pick a day").selectOption(day);
      await p.getByRole("button", { name: "10:00 AM", exact: true }).click();
      await p.getByLabel("Name", { exact: true }).fill("Customer Tester");
      await p.getByLabel("Phone", { exact: true }).fill(customer.phone);
      await p.getByRole("button", { name: "Book a 60 min lesson at 10:00 AM" }).click();
      const done = p.getByText(/^Booked\. Your code is MS-[A-Z0-9]+/);
      await done.waitFor();
      await p.getByText(/Your coach: Ben Tan · RM120/).waitFor();
      expect(await fitsScreen(p)).toBeLessThanOrEqual(1);
      return (await done.textContent())!.match(/MS-[A-Z0-9]+/)![0];
    });
    expect((await myLesson(customer, code)).coachId).toBe(coach["Ben Tan"]);
    // Booking a coach by name is the venue's own now (the API, as the coach's page would ask).
    const named = await customer.api("POST", "/api/bookings", { venueId: club.venueId, sport: "tennis", date: day, start: 720, end: 780, name: "Customer Tester", phone: customer.phone, coachId: coach["Ana Lim"] });
    expect([named.status, named.body.code]).toEqual([409, "LESSON_VENUE_ASSIGNS"]);
  });
});

// ------------------------------------------------------------------ Membership W

/** The next whole hour at the venue (Malaysia), and its day: a session whose check-in is already open. */
function nextHour(): { date: string; hour: number } {
  const now = new Date(Date.now() + 8 * 3_600_000);
  const hour = now.getUTCHours() + 1;
  return hour < 24 ? { date: now.toISOString().slice(0, 10), hour } : { date: new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10), hour: hour - 24 };
}

/** Days from today (Malaysia) to the first of next month. */
function daysToNextMonth(): number {
  const today = new Date(`${dayAhead(0)}T00:00:00Z`);
  const first = Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1);
  return Math.round((first - today.getTime()) / 86_400_000);
}

describe.skipIf(gateway === null)("membership validity on the session's date", () => {
  scenario("Membership W: a child's membership ending before next month's session refuses it with where to renew; renewed, she is booked; a membership cancelled flags a booking, self check-in refuses it, a manager admits her with a note", async (s) => {
    const owner = await signInOwner(await s.actor("Owner"));
    const club = await venueOf(owner, "Kelab Renang Ahli", "pool");
    const pool = club.courtIds[0];
    const mgrApi = await staffApi(await s.actor("Manager API"), club.manager.email);
    await paysOnline(owner, club.venueId);
    // Open round the clock, so a session starting within the hour can be checked in whenever this runs (setup).
    const hours = await owner.api("PATCH", `/api/admin/venues/${club.venueId}`, { openMin: 0, closeMin: 24 * 60 });
    expect(hours.status, JSON.stringify(hours.body)).toBe(200);
    const plan = await mgrApi.api("POST", "/api/admin/membership-plans", { venueId: club.venueId, name: "Junior swim", months: 1, price: 30, offeredFor: "participant" });
    expect(plan.status, JSON.stringify(plan.body)).toBeLessThan(300);
    const {
      parent,
      kids: [aina],
    } = await family(s, "Parent", ["Aina"], "phone");
    // A session next month (or as near as the booking window allows), found while the venue is public.
    const ahead = daysToNextMonth();
    const later = await freeSlot({ sport: "swimming", venueId: club.venueId, fromDay: ahead >= 6 && ahead <= 12 ? ahead : 6, toDay: 13, hours: [14, 15, 16, 17] });
    // Aina's place on a session starting within the hour, booked while the venue was public; the venue then
    // becomes members-only and sells her a membership at the counter until three days from now (setup).
    const soon = nextHour();
    const today = await bookChildren(parent, { courtId: pool, date: soon.date, hour: soon.hour }, [aina]);
    expect(today.status, JSON.stringify(today.body)).toBe(201);
    const todayCode = (today.body.booking as { code: string }).code;
    const members = await mgrApi.api("POST", "/api/admin/venue-access", { venueId: club.venueId, action: "settings", access: "members", listed: true, note: "" });
    expect(members.status, JSON.stringify(members.body)).toBe(200);
    const ends = dayAhead(3);
    const sold = await mgrApi.api("POST", "/api/admin/memberships", {
      venueId: club.venueId,
      holderName: "Parent Tester",
      holderPhone: parent.phone,
      accountEmail: parent.email,
      holderParticipantId: aina.id,
      startsOn: dayAhead(0),
      expiresOn: ends,
      price: 30,
    });
    expect(sold.status, JSON.stringify(sold.body)).toBe(201);
    const counterCode = (sold.body.membership as { code: string }).code;
    const p = parent.page;

    await s.step(parent, "chooses Aina for the session next month: the form says her membership ends before it, with where to renew, and booking is refused with the same reason", async () => {
      await p.goto(slotLink(club.venueId, "swimming", pool, later.date, later.hour));
      await p.getByRole("button", { name: /^Book · RM/ }).waitFor();
      await forChildren(p, ["Aina"], ["Aina"]);
      const said = p.getByRole("alert").filter({ hasText: `Members only on ${later.date}` });
      await said.getByText(`Aina's membership ends on ${ends}, before this session on ${later.date}.`).waitFor();
      await said.getByRole("link", { name: "Renew or buy a membership" }).waitFor();
      expect(await fitsScreen(p)).toBeLessThanOrEqual(1);
      await p.getByRole("button", { name: /^Book · RM/ }).click();
      await p.getByText(`This session is for members, and Aina's membership here ends on ${ends}, before the session on ${later.date}. Renew it, then book.`).waitFor();
    });

    await s.step(parent, "follows the renewal link to the venue's plans; the junior plan for Aina starts the day after her membership ends; pays through the gateway stand-in", async () => {
      await p.getByRole("alert").getByRole("link", { name: "Renew or buy a membership" }).click();
      const row = p.locator("li").filter({ hasText: "Junior swim" });
      await row.getByRole("button", { name: /^Join · RM30/ }).click();
      await row.getByRole("radio", { name: "Aina" }).check();
      await row.getByRole("button", { name: "See the price and dates" }).click();
      await row.getByText(new RegExp(`^Junior swim for Aina: from ${dayAhead(4)} to \\d{4}-\\d{2}-\\d{2}\\.$`)).waitFor();
      await row.getByRole("button", { name: "Pay RM30" }).click();
      await payOnStandIn(p, "RM30.00", /Junior swim for Aina/);
      await p.getByText("Aina is a member").waitFor({ timeout: 20_000 });
      await p.getByText(new RegExp(`^Aina's membership MB-[A-Z0-9-]+ at ${club.name} runs from ${dayAhead(4)} to `)).waitFor();
    });

    const laterCode = await s.step(parent, "books Aina on the session next month: the form now says she is a member on its date, and it is booked", async () => {
      await p.goto(slotLink(club.venueId, "swimming", pool, later.date, later.hour));
      await p.getByRole("button", { name: /^Book · RM/ }).waitFor();
      await forChildren(p, ["Aina"], ["Aina"]);
      await p.getByRole("status").filter({ hasText: `Members only on ${later.date}` }).getByText(`Aina: a member on ${later.date}`).waitFor();
      await p.getByRole("button", { name: /^Book · RM/ }).click();
      await p.getByText("Booking confirmed!").waitFor({ timeout: 15_000 });
      return (await p.getByText(/MS-[A-Z0-9]{4,}/).first().textContent())!.match(/MS-[A-Z0-9]{4,}/)![0];
    });

    const manager = await s.actor("Manager");
    await s.step(manager, "cancels the membership sold at the counter; under Bookings, today's session for Aina is now a booking to decide, the one next month is not", async () => {
      const mp = manager.page;
      await staffSignIn(manager, club.manager.email);
      await mp.getByRole("button", { name: "Credit & passes", exact: true }).click();
      mp.once("dialog", (d) => void d.accept());
      await mp.locator("tr").filter({ hasText: counterCode }).getByRole("button", { name: "Cancel", exact: true }).click();
      await mp.getByText(`${counterCode} cancelled.`, { exact: false }).waitFor();
      await mp.getByRole("button", { name: "Bookings", exact: true }).click();
      const flags = mp.locator("section").filter({ has: mp.getByRole("heading", { name: "Bookings to decide: a membership no longer covers them" }) });
      await flags.locator("li").filter({ hasText: todayCode }).getByText(/Aina .* membership cancelled/).waitFor();
      expect(await flags.locator("li").filter({ hasText: laterCode }).count()).toBe(0);
    });

    await s.step(parent, "at the pool, scans Aina's check-in code: refused, her membership was cancelled, check in at the desk", async () => {
      await p.goto(`${url}/account`);
      const card = bookingCard(p, todayCode).last();
      await card.getByRole("button", { name: /Show check-in code/ }).click();
      const src = await card.getByRole("img").getAttribute("src");
      const token = new URL(src!, url).searchParams.get("token");
      await p.goto(`${url}/checkin/${token}`);
      await p.getByRole("heading", { name: "Couldn't check you in" }).waitFor();
      await p.getByText("This session is for members, and Aina's membership here was cancelled. Check in at the desk: staff will decide.").waitFor();
      expect(await fitsScreen(p)).toBeLessThanOrEqual(1);
    });

    const desk = await s.actor("Desk");
    await s.step(desk, "at the desk, checks Aina's booking in: warned that her membership was cancelled, and does not admit her", async () => {
      const dp = desk.page;
      const seen: string[] = [];
      dp.on("dialog", (d) => {
        seen.push(d.message());
        void d.dismiss();
      });
      await staffSignIn(desk, club.desk.email);
      await dp.getByLabel("Day to show").fill(soon.date);
      const row = dp.locator("tr").filter({ hasText: todayCode });
      await row.getByRole("button", { name: "check in", exact: true }).click();
      await expect.poll(() => seen.length).toBe(1);
      expect(seen[0]).toContain("This session is for members. Before you check them in:");
      expect(seen[0]).toContain("Aina's membership was cancelled.");
      await row.getByRole("button", { name: "check in", exact: true }).waitFor();
    });

    await s.step(manager, "at the desk, checks her in all the same and says why: checked in, the decision kept", async () => {
      const mp = manager.page;
      const seen = answerDialogs(mp, "Membership renewal paid at the counter today; receipt to follow.");
      await mp.getByLabel("Day to show").fill(soon.date);
      const row = mp.locator("tr").filter({ hasText: todayCode });
      await row.getByRole("button", { name: "check in", exact: true }).click();
      await row.getByRole("button", { name: /^in / }).waitFor();
      expect(seen[0]).toContain("Admit them all the same? Your decision is recorded.");
      expect(seen[1]).toBe("Why are you admitting them? (kept with the check-in)");
      const log = (await mgrApi.api("GET", `/api/admin/activity?venueId=${club.venueId}`)).body as { actions?: { action: string; detail: string }[] };
      expect(JSON.stringify(log)).toContain("Admitted Aina (membership cancelled");
    });

    await s.step(manager, "marks the flag done, saying she was admitted", async () => {
      const mp = manager.page;
      const flags = mp.locator("section").filter({ has: mp.getByRole("heading", { name: "Bookings to decide: a membership no longer covers them" }) });
      await flags.locator("li").filter({ hasText: todayCode }).getByRole("button", { name: "Done" }).click();
      await gone(flags.locator("li").filter({ hasText: todayCode }));
    });
  });
});

// ------------------------------------------------------------------ Family X

describe.skipIf(gateway === null)("whom a family membership covers", () => {
  scenario("Family X: a child taken off a family membership cannot be replaced mid-term, and the mother is told why; she buys the next term naming the new list; a manager corrects a child entered wrongly, with a reason", async (s) => {
    const owner = await signInOwner(await s.actor("Owner"));
    const club = await venueOf(owner, "Kelab Renang Keluarga", "pool");
    const mgrApi = await staffApi(await s.actor("Manager API"), club.manager.email);
    await paysOnline(owner, club.venueId);
    const members = await mgrApi.api("POST", "/api/admin/venue-access", { venueId: club.venueId, action: "settings", access: "members", listed: true, note: "" });
    expect(members.status, JSON.stringify(members.body)).toBe(200);
    // A family plan for two, with nobody put on in place of another during a term (the default).
    const plan = await mgrApi.api("POST", "/api/admin/membership-plans", { venueId: club.venueId, name: "Family swim", months: 1, price: 80, offeredFor: "family", familyLimit: 2 });
    expect(plan.status, JSON.stringify(plan.body)).toBeLessThan(300);
    const {
      parent: mother,
      kids: [, , chloe, dina],
    } = await family(s, "Mother", ["Amani", "Bella", "Chloe", "Dina"], "phone");
    const p = mother.page;
    const row = p.locator("li").filter({ hasText: "Family swim" });
    const familyCard = (code: string) => p.locator("div").filter({ has: p.getByText(new RegExp(`^Family membership ${code}, until `)) }).last();

    const current = await s.step(mother, "buys the family plan for Amani and Bella (Bella ticked by mistake for Chloe) through the gateway stand-in", async () => {
      await p.goto(`${url}/venue/${club.venueId}`);
      await row.getByRole("button", { name: /^Join · RM80/ }).click();
      await row.getByRole("checkbox", { name: "Amani" }).check();
      await row.getByRole("checkbox", { name: "Bella" }).check();
      await row.getByRole("button", { name: "See the price and dates" }).click();
      await row.getByText(/^Family swim for Me, Amani, Bella: from /).waitFor();
      await row.getByRole("button", { name: "Pay RM80" }).click();
      await payOnStandIn(p, "RM80.00", /Family swim for Mother Tester, Amani, Bella/);
      await p.getByText("You're a member").waitFor({ timeout: 20_000 });
      const said = (await p.getByText(/^Membership MB-[A-Z0-9-]+ at /).textContent())!;
      return { code: said.match(/MB-[A-Z0-9-]+/)![0], until: said.match(/to (\d{4}-\d{2}-\d{2})/)![1] };
    });

    await s.step(mother, "takes Amani off, who has stopped swimming: saved, and no place is left this term for anybody new, said why; no one can be added", async () => {
      await p.goto(`${url}/venue/${club.venueId}`);
      const card = familyCard(current.code);
      await card.getByRole("button", { name: "Take Amani off" }).click();
      await card.getByText("Saved.").waitFor();
      await card.getByText("No places left this term for anybody new: taking somebody off does not give one back. You can name them for the next term.").waitFor();
      expect(await card.getByRole("button", { name: /^Add / }).count()).toBe(0);
      expect(await fitsScreen(p)).toBeLessThanOrEqual(1);
    });
    // Asked all the same (the API, as the page would), Dina is refused with the reason.
    const refused = await mother.api("PATCH", "/api/my/membership", { membershipId: (await membershipId(mgrApi, club.venueId, current.code)), covers: [dina.id, ...(await covered(mgrApi, club.venueId, current.code))] });
    expect([refused.status >= 400, refused.body.code]).toEqual([true, "MBO_NO_PLACES_LEFT"]);

    await s.step(mother, "names Chloe and Dina for the next term by renewing the plan now: it starts the day after this one ends", async () => {
      await row.getByRole("button", { name: /^Renew · RM80/ }).click();
      await row.getByRole("checkbox", { name: "Chloe" }).check();
      await row.getByRole("checkbox", { name: "Dina" }).check();
      const from = dayAfter(current.until);
      await row.getByRole("button", { name: "See the price and dates" }).click();
      await row.getByText(new RegExp(`^Family swim for Me, Chloe, Dina: from ${from} to `)).waitFor();
      await row.getByRole("button", { name: "Pay RM80" }).click();
      await payOnStandIn(p, "RM80.00", /Family swim for Mother Tester, Chloe, Dina/);
      await p.getByText("You're a member").waitFor({ timeout: 20_000 });
      await p.getByText(new RegExp(`^Membership MB-[A-Z0-9-]+ at ${club.name} runs from ${from} to `)).waitFor();
    });

    const manager = await s.actor("Manager");
    await s.step(manager, "at the counter, corrects the current membership: Bella was entered wrongly for Chloe; with the reason, using no place; its history shows each change", async () => {
      const mp = manager.page;
      await staffSignIn(manager, club.manager.email);
      await mp.getByRole("button", { name: "Credit & passes", exact: true }).click();
      const line = mp.locator("tr").filter({ hasText: current.code });
      await line.getByText("Who it covered").click();
      await line.getByText("Places this term: 2 used of 2").waitFor();
      await line.getByText(/Amani: taken off/).waitFor();
      await line.getByLabel("Take off").selectOption({ label: "Bella" });
      await line.getByRole("button", { name: "For somebody on this number (a child)?" }).click();
      await line.getByRole("radio", { name: /^Chloe/ }).check();
      await line.getByLabel("Why (required)").fill("Bella was ticked by mistake when buying; the swimmer is Chloe.");
      await line.getByRole("button", { name: "Correct", exact: true }).click();
      await line.getByText("Corrected. It is in the activity log.").waitFor();
      await line.getByText(/Bella: taken off as a correction/).waitFor();
      await line.getByText(/Chloe: put on as a correction/).waitFor();
      await line.getByText("Places this term: 2 used of 2").waitFor();
    });
    expect(await covered(mgrApi, club.venueId, current.code)).toEqual([chloe.id]);

    await s.step(mother, "sees this term's membership covering Chloe, and the next term's Chloe and Dina", async () => {
      await p.goto(`${url}/venue/${club.venueId}`);
      const card = familyCard(current.code);
      await card.getByRole("button", { name: "Take Chloe off" }).waitFor();
      expect(await card.getByRole("button", { name: /Take (Amani|Bella) off/ }).count()).toBe(0);
    });
  });
});

/** The day after an ISO date. */
const dayAfter = (iso: string) => new Date(Date.parse(`${iso}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** A membership on the venue's list, by its code: its id. */
async function membershipId(staff: Actor, venueId: number, code: string): Promise<number> {
  const list = (await staff.api("GET", `/api/admin/memberships?venueId=${venueId}`)).body.memberships as { id: number; code: string }[];
  return list.find((m) => m.code === code)!.id;
}

/** Whom a membership covers now, by participant id. */
async function covered(staff: Actor, venueId: number, code: string): Promise<number[]> {
  const list = (await staff.api("GET", `/api/admin/memberships?venueId=${venueId}`)).body.memberships as { code: string; covers?: { id: number }[] }[];
  return (list.find((m) => m.code === code)?.covers ?? []).map((c) => c.id).sort((a, b) => a - b);
}

// ------------------------------------------------------------------ Places Y

describe.skipIf(gateway === null)("one person off a booking held by a deposit", () => {
  scenario("Places Y: a deposit paid online for three children's places; taking one off comes off the balance, the next off the balance and the deposit, each said before she confirms", async (s) => {
    const owner = await signInOwner(await s.actor("Owner"));
    const club = await venueOf(owner, "Kolam Deposit", "pool");
    const pool = club.courtIds[0];
    const mgrApi = await staffApi(await s.actor("Manager API"), club.manager.email);
    await paysOnline(owner, club.venueId);
    // Online bookings held until paid, with a 50% deposit allowed (setup).
    const hold = await mgrApi.api("POST", "/api/admin/hold-policy", { venueId: club.venueId, on: true, minutes: 30, depositPercent: 50 });
    expect(hold.status, JSON.stringify(hold.body)).toBe(200);
    const { parent: mother } = await family(s, "Mother", ["Amani", "Bella", "Chloe"]);
    const slot = await freeSlot({ sport: "swimming", venueId: club.venueId, fromDay: 4, toDay: 9, hours: [14, 15, 16, 17] });
    const p = mother.page;

    const code = await s.step(mother, "books a place for each of her three children, RM30, and pays the 50% deposit, RM15, through the gateway stand-in", async () => {
      await p.goto(slotLink(club.venueId, "swimming", pool, slot.date, slot.hour));
      await p.getByRole("button", { name: /^Book · RM/ }).waitFor();
      await forChildren(p, ["Amani", "Bella", "Chloe"], ["Amani", "Bella", "Chloe"]);
      await p.getByRole("button", { name: "Book · RM30" }).click();
      await p.getByText("Held for you: pay to confirm").waitFor({ timeout: 15_000 });
      const booked = (await p.getByText(/MS-[A-Z0-9]{4,}/).first().textContent())!.match(/MS-[A-Z0-9]{4,}/)![0];
      await p.getByText("The rest, RM15.00, is paid at the venue.").waitFor();
      await p.getByRole("button", { name: "Pay a 50% deposit now: RM15.00" }).click();
      await payOnStandIn(p, "RM15.00", new RegExp(booked));
      await p.getByText("Payment received").waitFor({ timeout: 20_000 });
      return booked;
    });
    const money = async () => {
      const mine = (await mother.api("GET", "/api/my/bookings")).body.bookings as { code: string; totalPrice: number; depositPaid?: number; status: string }[];
      const b = mine.find((x) => x.code === code)!;
      return { total: b.totalPrice, deposit: b.depositPaid ?? 0, status: b.status };
    };
    expect(await money()).toEqual({ total: 30, deposit: 15, status: "confirmed" });

    const takeOff = async (name: string, line: string) => {
      await p.goto(`${url}/account`);
      const card = bookingCard(p, code);
      await card.getByRole("button", { name: "Take somebody off" }).click();
      const who = card.getByRole("region", { name: "Who is taking part" });
      const li = who.locator("li").filter({ hasText: name });
      await li.getByText(line, { exact: true }).waitFor();
      let asked = "";
      p.once("dialog", (d) => {
        asked = d.message();
        void d.accept();
      });
      await li.getByRole("button", { name: "Take off" }).click();
      await p.getByText(`${name} is off the booking. ${line}`).waitFor();
      expect(asked).toBe(`Take ${name} off this booking? Everybody else stays booked. ${line}`);
    };

    await s.step(mother, "takes Chloe off: before confirming she is told RM10 less to pay, nothing back yet, since RM15 of the RM30 is still owed", async () => {
      await takeOff("Chloe", "RM10 less to pay.");
    });
    expect(await money()).toEqual({ total: 20, deposit: 15, status: "confirmed" });

    await s.step(mother, "takes Bella off: before confirming she is told RM5 less to pay and RM5 of the deposit back to the card it was paid with", async () => {
      await takeOff("Bella", "RM5 less to pay. RM5 of the deposit goes back to the card or account it was paid with.");
    });
    expect(await money()).toEqual({ total: 10, deposit: 10, status: "confirmed" });
  });
});

// ------------------------------------------------------------------ Malay Z

describe.skipIf(!serverLog)("times in Malay", () => {
  scenario("Malay Z: a booking made in Bahasa Malaysia from 11 to noon is confirmed by an email in Malay, 11:00 PG to 12:00 PTG, whose link opens My booking in Malay", async (s) => {
    const customer = await s.actor("Customer");
    const slot = await freeSlot({ hours: [11] });
    const p = customer.page;

    const code = await s.step(customer, "switches the site to Bahasa Malaysia and books 11:00 PG on the venue page with her email", async () => {
      await p.goto(`${url}/venue/${slot.venueId}?date=${slot.date}&sport=badminton&court=${slot.courtId}&hour=${slot.hour}&duration=1`);
      await p.getByTitle("Bahasa Malaysia", { exact: true }).first().click();
      await p.getByRole("button", { name: /^Tempah · RM/ }).waitFor();
      await p.getByLabel("Nama", { exact: true }).fill("Siti Tester");
      await p.getByLabel("Telefon", { exact: true }).fill(customer.phone);
      await p.getByLabel("E-mel (untuk kod + kalendar)").fill(customer.email);
      await p.getByRole("button", { name: /^Tempah · RM/ }).click();
      await p.getByText("Tempahan disahkan!").waitFor({ timeout: 15_000 });
      return (await p.getByText(/MS-[A-Z0-9]{4,}/).first().textContent())!.match(/MS-[A-Z0-9]{4,}/)![0];
    });

    const mail = await s.step(customer, "receives the confirmation in Malay: 11:00 PG hingga 12:00 PTG, never AM or PM", async () => {
      const m = await emailed(customer.email, new RegExp(`^Tempahan ${code} disahkan — `));
      expect(m.text).toMatch(/^Hai Siti, tempahan anda telah disahkan\./);
      expect(m.text).toContain(`Kod: ${code}`);
      expect(m.text).toContain("11:00 PG hingga 12:00 PTG");
      expect(m.text).not.toMatch(/\b(AM|PM)\b/);
      return m;
    });

    await s.step(customer, "opens the email's link in a fresh browser: My booking in Malay, without choosing it", async () => {
      const link = linkIn(mail, /^\/my-booking$/);
      expect(new URL(link).searchParams.get("lang")).toBe("ms");
      await customer.context.clearCookies();
      await p.goto(link);
      await p.getByRole("button", { name: "Cari tempahan saya" }).waitFor();
    });
  });
});
