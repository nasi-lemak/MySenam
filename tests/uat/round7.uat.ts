import fs from "fs";
import { describe, expect, inject } from "vitest";
import type { Dialog, Page } from "playwright-core";
import { dayAhead, fitsScreen, freeSlot, gone, rowAction, scenario, signInOwner, signUp, url, type Actor, type Scenario } from "./harness";
import { STAFF_PASSWORD, staffApi, staffSignIn } from "./families";

/**
 * Round 7's workflows as the people involved meet them, each in a browser of
 * their own, on a laptop or a phone:
 *
 * - **Invitations AA** (docs/features/booking.md#residents-inviting-their-own-guests):
 *   a resident withdraws a guest's emailed invitation after a confirm; the
 *   guest's link then answers as one run out does, and the address is told
 *   it was withdrawn, never by whom or why; the front desk cannot withdraw
 *   one, a manager can, with a reason kept in the activity log.
 * - **Invitations AB** (docs/features/matchmaking.md#invitations): a game's
 *   host and a group's organiser each withdraw an invitation sent by email;
 *   the roster says *withdrawn*, and the link is refused.
 * - **Coaches AC** (docs/features/programmes.md#paying-a-dearer-coachs-difference-online):
 *   a dearer coach's difference paid by the customer from the coach-change
 *   email's link, through **a stand-in for Billplz's sandbox**
 *   (tests/uat/gateway.ts: not Billplz), on a receipt of its own, shown paid
 *   online on the staff screen and in the day's figures; a second taken at
 *   the counter while no page is open, which the link then shows paid.
 * - **Suspension AD** (docs/features/pricing.md#suspending-a-membership): a
 *   manager suspends a membership for the coming week with a reason (the front desk
 *   cannot); the member is told on the account page and refused a members'
 *   session inside it; a booking already made is flagged and the desk is
 *   warned at check-in; reactivated, the member books.
 * - **Times AE** (docs/product/regions-and-tax.md): staff times in Malay and
 *   Chinese on the bookings, schedule and activity log; a customer arriving
 *   by a `?lang=ms` link keeps Malay on the next page.
 * - **Credit AF** (docs/features/programmes.md): a lesson paid from credit on
 *   the lesson form.
 * - **Accounts AG** (docs/features/payments-and-credit.md): a company account
 *   closed with credit waiting stays listed; a manager records the credit
 *   paid back by hand.
 * - **Counter AH** (docs/features/booking.md#the-same-policies-on-every-path,
 *   #manager-overrides): a manager lets managers override the house rules'
 *   limits; a number at its limit is refused at the counter in the counter's
 *   words; the desk is told to ask a manager; the manager overrides it with a
 *   reason, shown on the booking; a blocked number is refused, no override.
 *
 * Not here: e-invoice states on the staff screen (docs/integrations/myinvois.md).
 * The acceptance server has no stand-in for MyInvois, e-invoicing turns on
 * only with MyInvois credentials, and a document reaches a state only by
 * being sent to LHDN, so showing one would be a live call to LHDN's sandbox.
 * The states and actions are covered by tests/einvoice-records.test.ts and
 * the screen by its component test.
 *
 * Emails are read from the acceptance server's output (MYSENAM_SEND=log) and
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
    manager: { email: `r7-manager-${stamp}@uat.mysenam.test`, name: `${label} Manager` },
    desk: { email: `r7-desk-${stamp}@uat.mysenam.test`, name: `${label} Desk` },
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

/** Dialogs a person answers: confirms accepted, prompts answered with `answer`; each message kept. */
function answerDialogs(page: Page, answer: string): string[] {
  const seen: string[] = [];
  page.on("dialog", (d: Dialog) => {
    seen.push(d.message());
    void (d.type() === "prompt" ? d.accept(answer) : d.accept());
  });
  return seen;
}

/** The one confirm or prompt the next action raises: its message, accepted (a prompt with `answer`). */
function nextDialog(page: Page, answer?: string): () => string {
  let message = "";
  page.once("dialog", (d: Dialog) => {
    message = d.message();
    void (d.type() === "prompt" ? d.accept(answer ?? "") : d.accept());
  });
  return () => message;
}

/** The activity log of a venue, as its manager's API reads it (setup and checks, not the screen). */
async function activity(mgrApi: Actor, venueId: number): Promise<string> {
  return JSON.stringify((await mgrApi.api("GET", `/api/admin/activity?venueId=${venueId}`)).body);
}

// ------------------------------------------------------------------ Invitations AA

describe.skipIf(!serverLog)("withdrawing a resident's guest invitations", () => {
  scenario("Invitations AA: a resident withdraws a guest's emailed invitation after a confirm; the link then reads as one run out and the guest is told, never by whom; the front desk cannot withdraw one, a manager can with a reason", async (s) => {
    const owner = await signInOwner(await s.actor("Owner"));
    const condo = await venueOf(owner, "Kondo Seri", "pool");
    const mgrApi = await staffApi(await s.actor("Manager API"), condo.manager.email);
    // A free hour, found while the venue is still public (a private one is in no list).
    const slot = await freeSlot({ sport: "swimming", venueId: condo.venueId, fromDay: 1, toDay: 2, hours: [14, 15, 16, 17] });
    const resident = await signUp(await s.actor("Resident"));
    for (const body of [
      { action: "settings", access: "private", note: "Residents of Kondo Seri and their guests." },
      { action: "add", phone: resident.phone, name: "Resident Tester", label: "B-03-1", kind: "resident", account: resident.email },
      { action: "guests", perResident: 3, days: 3 },
    ]) {
      const r = await mgrApi.api("POST", "/api/admin/venue-access", { venueId: condo.venueId, ...body });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    // Aisyah has an account with the address her invitation goes to; Ben has none.
    const aisyah = await signUp(await s.actor("Aisyah", "phone"));
    const ben = await s.actor("Ben");
    const page = resident.page;
    const guests = page.locator("section").filter({ has: page.getByRole("heading", { name: "Your guests" }) });
    const card = guests.locator("div.rounded-xl").filter({ hasText: condo.name });
    const guestRow = (name: string) => card.locator("li").filter({ hasText: name });

    const invite = async (who: Actor, name: string) => {
      await card.getByRole("button", { name: "Invite a guest" }).click();
      await card.getByLabel("Their phone").fill(who.phone);
      await card.getByLabel("Name (optional)").fill(name);
      await card.getByLabel("Their email (optional)").fill(who.email);
      await card.getByLabel("Days").fill("3");
      await card.getByRole("button", { name: "Add guest" }).click();
      await card.getByText(/is on the list\. Invitation submitted/).waitFor();
    };
    const subject = new RegExp(`^Resident has invited you to ${condo.name}$`);

    await s.step(resident, "on his account page, invites Aisyah with her phone and email: listed as invitation sent, with a Withdraw invitation button", async () => {
      await page.goto(`${url}/account`);
      await card.getByText("0 of 3 guests · up to 3 days each").waitFor();
      await invite(aisyah, "Aisyah Rahman");
      await page.reload();
      await guestRow("Aisyah Rahman").getByText(/invitation sent, not yet accepted/).waitFor();
      await guestRow("Aisyah Rahman").getByRole("button", { name: "Withdraw invitation" }).waitFor();
    });
    const link = linkIn(await emailed(aisyah.email, subject), /^\/guest-invitation$/);

    await s.step(resident, "withdraws it: asked to confirm, told the link stops working; the guest stays on his list, marked invitation withdrawn", async () => {
      const asked = nextDialog(page);
      await guestRow("Aisyah Rahman").getByRole("button", { name: "Withdraw invitation" }).click();
      await guestRow("Aisyah Rahman").getByText(/Invitation withdrawn/).waitFor();
      expect(asked()).toBe(
        "Withdraw this invitation? Its link will stop working. If the email has already gone, the address it went to is told the invitation was withdrawn."
      );
      expect(await guestRow("Aisyah Rahman").getByText(/invitation sent, not yet accepted/).count()).toBe(0);
      expect(await guestRow("Aisyah Rahman").getByRole("button", { name: "Withdraw invitation" }).count()).toBe(0);
      await card.getByText("1 of 3 guests · up to 3 days each").waitFor();
    });

    const notice = await s.step(aisyah, "is emailed that the invitation was withdrawn, without who withdrew it or why", async () => {
      const m = await emailed(aisyah.email, new RegExp(`^Invitation withdrawn: ${condo.name}$`));
      expect(m.text).toContain(`The invitation emailed to you to be a guest at ${condo.name} has been withdrawn, so the link in it no longer works.`);
      expect(m.text).not.toMatch(/Resident|Tester|Manager/);
      return m;
    });

    const refusal = await s.step(aisyah, "opens the original link on her phone, signed in, and accepts: refused in the words a link that ran out gets", async () => {
      const p = aisyah.page;
      await p.goto(link);
      await p.getByRole("button", { name: "Accept invitation" }).click();
      const said = p.locator(`p[role="alert"]`);
      await said.waitFor();
      expect(await fitsScreen(p)).toBeLessThanOrEqual(1);
      return (await said.textContent())!;
    });
    expect(refusal).toBe(
      "This invitation cannot be used. It may have run out, been used or replaced, or been sent to another email address than this account's. Ask whoever invited you to send it again."
    );

    await s.step(aisyah, "a link that was never good (as one run out is to the app) reads exactly the same, word for word; she still cannot book", async () => {
      const p = aisyah.page;
      await p.goto(`${url}/guest-invitation?token=${"x".repeat(43)}`);
      await p.getByRole("button", { name: "Accept invitation" }).click();
      const said = p.locator(`p[role="alert"]`);
      await said.waitFor();
      expect(await said.textContent()).toBe(refusal);
      // The withdrawn invitation linked nothing: the private venue still refuses her online.
      const tried = await aisyah.api("POST", "/api/bookings", { courtId: condo.courtIds[0], sport: "swimming", date: slot.date, start: slot.hour * 60, end: slot.hour * 60 + 60, name: "Aisyah Rahman", phone: aisyah.phone });
      expect([tried.status, tried.body.code]).toEqual([409, "PRIVATE_VENUE"]);
    });

    await s.step(resident, "invites Ben the same way, with his email", async () => {
      await invite(ben, "Ben Lee");
      await page.reload();
      await guestRow("Ben Lee").getByText(/invitation sent, not yet accepted/).waitFor();
    });
    await emailed(ben.email, subject);

    const listed = (p: Page) => p.locator("tr").filter({ hasText: ben.phone });
    const openList = async (a: Actor, email: string) => {
      await staffSignIn(a, email);
      await a.page.getByRole("button", { name: "Venue details", exact: true }).first().click();
      await a.page.getByRole("button", { name: /^Who it is for/ }).click();
      await listed(a.page).getByTestId("guest-invitation").getByText("Invitation emailed, not yet accepted").waitFor();
    };

    const desk = await s.actor("Desk");
    await s.step(desk, "on the venue's list, tries to withdraw Ben's invitation, giving a reason: refused, a manager's to do; still pending", async () => {
      await openList(desk, condo.desk.email);
      const seen = answerDialogs(desk.page, "Guest asked us to cancel.");
      await listed(desk.page).getByRole("button", { name: "Withdraw invitation" }).click();
      // In the list's own editor (the online-payment panel further down says the same to the desk on its own).
      const editor = desk.page.locator("div").filter({ has: desk.page.getByText("Who can find and book this venue", { exact: true }) }).last();
      await editor.getByText("Front-desk accounts cannot change this. Ask a manager.").waitFor();
      expect(seen[0]).toContain("Withdraw the invitation emailed for Ben Lee?");
      await listed(desk.page).getByText("Invitation emailed, not yet accepted").waitFor();
    });

    const manager = await s.actor("Manager");
    await s.step(manager, "withdraws it from the list, saying why: withdrawn, and the reason is in the activity log", async () => {
      await openList(manager, condo.manager.email);
      const seen = answerDialogs(manager.page, "Unit B-03-1 asked us to cancel the visit.");
      await listed(manager.page).getByRole("button", { name: "Withdraw invitation" }).click();
      await manager.page.getByText("Invitation withdrawn.", { exact: true }).waitFor();
      expect(seen[0]).toBe(
        "Withdraw the invitation emailed for Ben Lee? Its link stops working; the guest stays on the list by their number. Say why (kept in the activity log):"
      );
      await listed(manager.page).getByTestId("guest-invitation").getByText("Invitation withdrawn").waitFor();
      expect(await listed(manager.page).getByRole("button", { name: "Withdraw invitation" }).count()).toBe(0);
      const log = await activity(mgrApi, condo.venueId);
      expect(log).toContain("guest_invitation.withdrawn");
      expect(log).toContain("Unit B-03-1 asked us to cancel the visit.");
    });

    await s.step(resident, "sees Ben still his guest, his invitation withdrawn; Ben is emailed the same short notice as Aisyah", async () => {
      await page.reload();
      await guestRow("Ben Lee").getByText(/Invitation withdrawn/).waitFor();
      const m = await emailed(ben.email, new RegExp(`^Invitation withdrawn: ${condo.name}$`));
      expect(m.text).toBe(notice.text);
      expect(m.text).not.toContain("B-03-1");
    });
  });
});

// ------------------------------------------------------------------ Invitations AB

const LEVEL = { sport: "badminton", level: "intermediate" };

describe.skipIf(!serverLog)("withdrawing a game's and a group's emailed invitations", () => {
  scenario("Invitations AB: a game's host withdraws an invitation sent by email and the row shows it withdrawn; a group's organiser does the same; each link is then refused and its address told", async (s) => {
    const host = await signUp(await s.actor("Host"), { profile: { adult: true }, level: LEVEL });
    const when = await freeSlot();
    const booked = await host.api("POST", "/api/bookings", { courtId: when.courtId, date: when.date, hours: [when.hour], name: "Host Tester", phone: host.phone });
    expect(booked.status, JSON.stringify(booked.body)).toBeLessThan(300);
    const opened = await host.api("POST", "/api/games", { bookingCode: (booked.body.booking as { code: string }).code, spots: 2, level: null, share: 5, autoAccept: false });
    expect(opened.status, JSON.stringify(opened.body)).toBe(201);
    const gameId = (opened.body.game as { id: number }).id;
    const friend = await signUp(await s.actor("Friend", "phone"), { profile: { adult: true, invitable: true } });
    const hp = host.page;
    const hosted = hp.getByTestId(`hosted-${gameId}`);

    await s.step(host, "on the games page, invites a friend by email: the roster shows invited by email, not yet accepted", async () => {
      await hp.goto(`${url}/games`);
      await hp.getByRole("heading", { name: "Find a game" }).waitFor();
      const tools = hp.getByTestId(`host-tools-${gameId}`);
      await tools.getByPlaceholder("Invite by email").fill(friend.email);
      await tools.getByRole("button", { name: "Invite", exact: true }).click();
      await hp.getByText("Invitation sent, if they can be invited.").waitFor();
      await hp.reload();
      await hosted.getByTestId("email-invite").getByText("Invited by email, not yet accepted").waitFor();
    });
    const gameLink = linkIn(await emailed(friend.email, /^Host invited you to a game: /), /^\/player-invitation$/);

    await s.step(host, "withdraws it after a confirm: the row now reads invited by email: withdrawn, with nothing left to withdraw", async () => {
      const asked = nextDialog(hp);
      await hosted.getByTestId("email-invite").getByRole("button", { name: "Withdraw invitation" }).click();
      await hp.getByText("Invitation withdrawn.", { exact: true }).waitFor();
      await hosted.getByTestId("email-invite").getByText("Invited by email: withdrawn").waitFor();
      expect(asked()).toMatch(/^Withdraw this invitation\? Its link will stop working\./);
      expect(await hosted.getByRole("button", { name: "Withdraw invitation" }).count()).toBe(0);
    });

    const refusal = await s.step(friend, "is emailed that it was withdrawn; opens the game's link on her phone and accepts: refused, as a link that ran out is", async () => {
      const m = await emailed(friend.email, /^Invitation withdrawn: /);
      expect(m.text).toContain("has been withdrawn, so the link in it no longer works. Nothing was booked or paid.");
      const p = friend.page;
      await p.goto(gameLink);
      await p.getByRole("button", { name: "Accept invitation" }).click();
      const said = p.locator(`p[role="alert"]`);
      await said.waitFor();
      expect(await fitsScreen(p)).toBeLessThanOrEqual(1);
      const players = ((await host.api("GET", `/api/games/${gameId}`)).body.game as { players?: { userId: number }[] } | undefined)?.players ?? [];
      expect(players.map((x) => x.userId)).not.toContain(friend.id);
      return (await said.textContent())!;
    });
    expect(refusal).toBe(
      "This invitation cannot be used. It may have run out, been used or replaced, or been sent to another email address than this account's. Ask whoever invited you to send it again."
    );

    const organiser = await signUp(await s.actor("Organiser"), { profile: { adult: true } });
    const started = await organiser.api("POST", "/api/groups", { name: `Thursday doubles ${stampOf()}`, sport: "badminton" });
    expect(started.status, JSON.stringify(started.body)).toBeLessThan(300);
    const groupId = (started.body.group as { id: number }).id;
    const gp = organiser.page;
    const roster = gp.getByTestId("roster");

    await s.step(organiser, "on the group's page, invites the friend by email: the roster shows invited by email, not yet accepted", async () => {
      await gp.goto(`${url}/games/groups/${groupId}`);
      await gp.getByPlaceholder("Invite by email").fill(friend.email);
      await gp.getByRole("button", { name: "Invite", exact: true }).click();
      await gp.getByText("Invitation sent, if they can be invited.").waitFor();
      await roster.getByTestId("email-invite").getByText("Invited by email, not yet accepted").waitFor();
    });
    const groupLink = linkIn(await emailed(friend.email, /^Organiser invited you to Thursday doubles /), /^\/player-invitation$/);

    await s.step(organiser, "withdraws it after a confirm: the roster reads invited by email: withdrawn", async () => {
      const asked = nextDialog(gp);
      await roster.getByTestId("email-invite").getByRole("button", { name: "Withdraw invitation" }).click();
      await roster.getByTestId("email-invite").getByText("Invited by email: withdrawn").waitFor();
      expect(asked()).toMatch(/^Withdraw this invitation\?/);
      expect(await roster.getByRole("button", { name: "Withdraw invitation" }).count()).toBe(0);
    });

    await s.step(friend, "is emailed that the group's invitation was withdrawn; its link is refused in the same words", async () => {
      const m = await emailed(friend.email, /^Invitation withdrawn: Thursday doubles /);
      expect(m.text).toMatch(/^The invitation emailed to you to join Thursday doubles \S+ has been withdrawn/);
      const p = friend.page;
      await p.goto(groupLink);
      await p.getByRole("button", { name: "Accept invitation" }).click();
      const said = p.locator(`p[role="alert"]`);
      await said.waitFor();
      expect(await said.textContent()).toBe(refusal);
      const mine = (await friend.api("GET", `/api/groups/${groupId}`)).body.group as { mine?: { status: string } | null } | undefined;
      expect(mine?.mine?.status ?? null).not.toBe("member");
    });
  });
});

// ------------------------------------------------------------------ Coaches AC

/** Coaches of tennis at a venue, each taking lessons 8 AM to 10 PM every day (setup by its manager): their ids by name. */
async function coachesAt(mgrApi: Actor, venueId: number, list: { name: string; rate: number }[]): Promise<Record<string, number>> {
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

/** A tennis lesson with Ana Lim at 10 AM, booked by the customer with her email and paid RM100 in cash at the desk (setup). */
async function paidLesson(customer: Actor, deskApi: Actor, venueId: number, coachId: number, date: string): Promise<string> {
  const booked = await customer.api("POST", "/api/bookings", {
    venueId,
    sport: "tennis",
    date,
    start: 10 * 60,
    end: 11 * 60,
    name: "Customer Tester",
    phone: customer.phone,
    email: customer.email,
    coachId,
  });
  expect(booked.status, JSON.stringify(booked.body)).toBe(201);
  const code = (booked.body.booking as { code: string }).code;
  const paid = await deskApi.api("POST", "/api/admin/payments", { code, paid: true, via: "cash" });
  expect(paid.status, JSON.stringify(paid.body)).toBe(200);
  return code;
}

/** The manager, on the dashboard's day list, gives a paid lesson to Ben Tan and adjusts the price: RM20 more owed. */
async function giveToBen(manager: Actor, customer: Actor, club: Venue, date: string, code: string) {
  const mp = manager.page;
  await mp.getByLabel("Day to show").fill(date);
  const row = mp.locator("tr").filter({ hasText: code });
  await rowAction(row, "Change time");
  await coachPick(mp).selectOption({ label: "Ben Tan" });
  const terms = mp.getByTestId("coach-terms");
  await terms.getByText("Ana Lim's fee for this lesson: RM80. Ben Tan's: RM100.").waitFor();
  await terms.getByText("Where the venue takes payment online, the customer can also pay it online, from the email or their booking page.").waitFor();
  await terms.getByRole("radio", { name: /^Adjust it: RM20 more owed by the customer/ }).check();
  const { courtId } = await myLesson(customer, code);
  await mp.getByRole("button", { name: /^10:00 AM–11:00 AM/ }).filter({ hasText: courtId === club.courtIds[0] ? "Court 1" : "Court 2" }).click();
  await mp.getByTestId("move-preview").getByRole("button", { name: "Confirm" }).click();
  await row.getByText(/Lesson with Ben Tan/).waitFor();
  return row;
}

/** The day's figures on the bookings tab: expected, collected and outstanding, as shown. */
async function dayFigures(page: Page): Promise<{ expected: string; collected: string; outstanding: string }> {
  const figure = async (label: string) =>
    (await page.locator("div.rounded-lg").filter({ hasText: new RegExp(`^${label}:`) }).first().locator("span.font-bold").textContent())!;
  return { expected: await figure("Expected"), collected: await figure("Collected"), outstanding: await figure("Outstanding") };
}

describe.skipIf(gateway === null || !serverLog)("paying a dearer coach's difference online", () => {
  scenario("Coaches AC: a paid lesson given to a dearer coach; the customer pays the RM20 difference online from the email's link, on a receipt of its own, shown paid online to staff and in the day's figures; a second taken at the counter while no page is open", async (s) => {
    const owner = await signInOwner(await s.actor("Owner"));
    const club = await venueOf(owner, "Kelab Tenis Bangsar", "tennis");
    await paysOnline(owner, club.venueId);
    const mgrApi = await staffApi(await s.actor("Manager API"), club.manager.email);
    const deskApi = await staffApi(await s.actor("Desk API"), club.desk.email);
    const coach = await coachesAt(mgrApi, club.venueId, [
      { name: "Ana Lim", rate: 80 },
      { name: "Ben Tan", rate: 100 },
    ]);
    const customer = await signUp(await s.actor("Customer", "phone"));
    const [first, second] = [dayAhead(4), dayAhead(5)];
    const lesson1 = await paidLesson(customer, deskApi, club.venueId, coach["Ana Lim"], first);
    const lesson2 = await paidLesson(customer, deskApi, club.venueId, coach["Ana Lim"], second);
    const manager = await s.actor("Manager");
    const mp = manager.page;

    await s.step(manager, "gives the first paid lesson to Ben Tan and adjusts the price: told the customer can pay the RM20 online too; the day owes RM20", async () => {
      await staffSignIn(manager, club.manager.email);
      const row = await giveToBen(manager, customer, club, first, lesson1);
      await row.getByRole("button", { name: "RM20 owed for Ben Tan's fee: take it" }).waitFor();
      expect(await dayFigures(mp)).toEqual({ expected: "RM120", collected: "RM100", outstanding: "RM20" });
    });

    const payLink = await s.step(customer, "receives the coach-change email: RM20 more owed, with a link to pay it online or pay at the venue", async () => {
      const m = await emailed(customer.email, new RegExp(`^Your lesson ${lesson1} is now with Ben Tan — `));
      expect(m.text).toContain("RM20 more is owed for the new coach's fee. Pay it online: ");
      expect(m.text).toContain("Or pay it at the venue.");
      return linkIn(m, /^\/coach-difference\/[^/]+$/);
    });

    const p = customer.page;
    await s.step(customer, "opens the link on her phone, signed out: the lesson, the RM20 and Pay RM20 online, or at the counter", async () => {
      await customer.context.clearCookies();
      await p.goto(payLink);
      await p.getByRole("heading", { name: `The difference for your new coach — ${club.name}` }).waitFor();
      await p.getByText(`Your lesson ${lesson1} is now with Ben Tan in place of Ana Lim, and the venue adjusted the price: RM20 more is owed for the new coach's fee.`).waitFor();
      await p.getByText("RM20 owed for Ben Tan's fee, since the venue changed your coach.").waitFor();
      await p.getByText("Or pay it at the venue's counter.").waitFor();
      expect(await fitsScreen(p)).toBeLessThanOrEqual(1);
    });

    await s.step(customer, "pays RM20 on the gateway stand-in's page: back on MySenam, told the difference is paid on a receipt of its own", async () => {
      await p.getByRole("button", { name: "Pay RM20 online" }).click();
      await payOnStandIn(p, "RM20.00", new RegExp(`coaching with Ben Tan in place of Ana Lim, the difference \\(${lesson1}\\)`));
      await p.getByText("Difference paid").waitFor({ timeout: 20_000 });
      await p.getByText(`Thank you. RM20 for the new coach's fee on ${lesson1} has been received, on a receipt of its own.`).waitFor();
      expect(await fitsScreen(p)).toBeLessThanOrEqual(1);
    });

    await s.step(customer, "on My booking, the lesson shows the RM20 paid online with its own receipt, for RM20 and Ben Tan; she is emailed the receipt", async () => {
      await p.goto(`${url}/my-booking`);
      await p.getByLabel("Booking code").fill(lesson1);
      await p.getByLabel("Phone number").fill(customer.phone);
      await p.getByRole("button", { name: "Find my booking" }).click();
      const paid = p.getByTestId("coach-difference").getByText("RM20 for Ben Tan's fee: paid online.");
      await paid.waitFor();
      expect(await p.getByRole("button", { name: /^Pay RM20 online/ }).count()).toBe(0);
      const href = await p.getByTestId("coach-difference").getByRole("link", { name: "Receipt ↗" }).getAttribute("href");
      await p.goto(new URL(href!, url).href);
      await p.getByText(/Ben Tan/).first().waitFor();
      const receipt = (await p.locator("body").textContent())!;
      expect(receipt).toContain("RM20");
      expect(receipt).not.toContain("RM100");
      // Queued in the outbox for its next run (the scheduler, off on the acceptance server, or staff opening the
      // venue's messages, which runs it): the messages list is opened, as staff would.
      expect((await mgrApi.api("GET", `/api/admin/messages?venueId=${club.venueId}`)).status).toBe(200);
      const mail = await emailed(customer.email, new RegExp(`^Received: RM20 for your lesson ${lesson1} — `));
      expect(mail.text).toContain("Nothing more is owed for it.");
    });
    // Signed in again (she paid signed out), to read her bookings.
    expect((await customer.api("POST", "/api/auth/login", { email: customer.email, password: customer.password })).status).toBe(200);
    expect(await myLesson(customer, lesson1)).toMatchObject({ coachId: coach["Ben Tan"], totalPrice: 100, paymentStatus: "paid" });

    await s.step(manager, "sees on the day's list the RM20 paid online beside the lesson, nothing left to take; the day's figures collect RM120", async () => {
      await mp.reload();
      await mp.getByLabel("Day to show").fill(first);
      const row = mp.locator("tr").filter({ hasText: lesson1 });
      await row.getByText(/✓ RM20 for Ben Tan's fee: paid \(Online/).waitFor();
      expect(await row.getByRole("button", { name: /owed for Ben Tan's fee/ }).count()).toBe(0);
      expect(await dayFigures(mp)).toEqual({ expected: "RM120", collected: "RM120", outstanding: "RM0" });
    });

    await s.step(manager, "gives the second lesson to Ben Tan the same way: RM20 owed, no page open", async () => {
      const row = await giveToBen(manager, customer, club, second, lesson2);
      await row.getByRole("button", { name: "RM20 owed for Ben Tan's fee: take it" }).waitFor();
    });
    const secondLink = linkIn(await emailed(customer.email, new RegExp(`^Your lesson ${lesson2} is now with Ben Tan — `)), /^\/coach-difference\/[^/]+$/);

    const desk = await s.actor("Desk");
    await s.step(desk, "the customer pays at the counter instead: the desk takes RM20 in cash, on a receipt of its own", async () => {
      await staffSignIn(desk, club.desk.email);
      await desk.page.getByLabel("Day to show").fill(second);
      const row = desk.page.locator("tr").filter({ hasText: lesson2 });
      await row.getByRole("button", { name: "RM20 owed for Ben Tan's fee: take it" }).click();
      await row.getByTitle("Cash", { exact: true }).click();
      await desk.page.getByText(`RM20 taken for ${lesson2}, on a receipt of its own.`).waitFor();
      await row.getByText(/✓ RM20 for Ben Tan's fee: paid \(Cash\)/).waitFor();
      expect(await dayFigures(desk.page)).toEqual({ expected: "RM120", collected: "RM120", outstanding: "RM0" });
    });

    await s.step(customer, "opens the second email's link: paid at the venue, with its receipt, and nothing to pay online", async () => {
      await p.goto(secondLink);
      await p.getByText("RM20 for Ben Tan's fee: paid at the venue.").waitFor();
      await p.getByRole("link", { name: "Receipt ↗" }).waitFor();
      expect(await p.getByRole("button", { name: /Pay RM20 online/ }).count()).toBe(0);
      expect(await fitsScreen(p)).toBeLessThanOrEqual(1);
    });
  });
});

// ------------------------------------------------------------------ Suspension AD

describe("suspending a membership", () => {
  scenario("Suspension AD: a manager suspends a member's membership for the coming week with a reason (the desk cannot); she sees it and is refused a members' session in it; her booking today is flagged, the desk warned at check-in; reactivated, she books", async (s) => {
    const owner = await signInOwner(await s.actor("Owner"));
    const club = await venueOf(owner, "Kelab Renang Damai", "pool");
    const pool = club.courtIds[0];
    const mgrApi = await staffApi(await s.actor("Manager API"), club.manager.email);
    const member = await signUp(await s.actor("Member", "phone"));
    // The coming week, from today to seven days on: today, since the desk can check a booking in only in the hour
    // before it starts. A session inside it, found while the venue is public; the pool open round the clock, so a
    // session within the hour can be checked in whenever this runs (setup).
    const [from, until] = [dayAhead(0), dayAhead(7)];
    const wanted = await freeSlot({ sport: "swimming", venueId: club.venueId, fromDay: 3, toDay: 6, hours: [14, 15, 16, 17] });
    const open = await owner.api("PATCH", `/api/admin/venues/${club.venueId}`, { openMin: 0, closeMin: 24 * 60 });
    expect(open.status, JSON.stringify(open.body)).toBe(200);
    const already = nextHour();
    // Members only; the member's own membership sold at the counter for two months (setup).
    const members = await mgrApi.api("POST", "/api/admin/venue-access", { venueId: club.venueId, action: "settings", access: "members", listed: true, note: "" });
    expect(members.status, JSON.stringify(members.body)).toBe(200);
    const sold = await mgrApi.api("POST", "/api/admin/memberships", {
      venueId: club.venueId,
      holderName: "Member Tester",
      holderPhone: member.phone,
      accountEmail: member.email,
      startsOn: dayAhead(0),
      expiresOn: dayAhead(60),
      price: 50,
      // No plan: a manager's price, with the reason, and how it was paid (round 8, X1-19 and X1-2).
      priceReason: "Two months, no plan for it",
      via: "cash",
    });
    expect(sold.status, JSON.stringify(sold.body)).toBe(201);
    const code = (sold.body.membership as { code: string }).code;
    // Her place on a session within the hour, booked as a member before anything is suspended (setup).
    const made = await member.api("POST", "/api/bookings", { courtId: pool, sport: "swimming", date: already.date, start: already.hour * 60, end: already.hour * 60 + 60, name: "Member Tester", phone: member.phone });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const bookedCode = (made.body.booking as { code: string }).code;
    const line = (p: Page) => p.locator("tr").filter({ hasText: code });
    const suspendIn = async (p: Page, reason: string) => {
      await p.getByRole("button", { name: "Credit & passes", exact: true }).click();
      await line(p).getByText("Suspend or reactivate").click();
      await line(p).getByText("Never suspended.").waitFor();
      await line(p).getByLabel("From", { exact: true }).fill(from);
      await line(p).getByLabel("Until (blank: until reactivated)").fill(until);
      await line(p).getByLabel("Reason", { exact: true }).fill(reason);
      await line(p).getByRole("button", { name: "Suspend", exact: true }).click();
    };

    const desk = await s.actor("Desk");
    await s.step(desk, "under Credit & passes, opens the membership's suspensions and tries to suspend it for the coming week: refused, a manager's to do", async () => {
      await staffSignIn(desk, club.desk.email);
      await suspendIn(desk.page, "Locker key not returned.");
      await line(desk.page).getByText("Front-desk accounts cannot change this. Ask a manager.").waitFor();
      expect(await line(desk.page).getByText(/^Suspended from/).count()).toBe(0);
    });

    const manager = await s.actor("Manager");
    await s.step(manager, "suspends it from today for a week, saying why: suspended, her booking today flagged; the history says who and why", async () => {
      await staffSignIn(manager, club.manager.email);
      await suspendIn(manager.page, "Unpaid locker fee: suspended until it is settled.");
      await line(manager.page).getByText("Suspended. 1 booking is flagged for you to review under Bookings.").waitFor();
      await line(manager.page).getByText(`Suspended from ${from} until ${until}`).first().waitFor();
      await line(manager.page).getByText(new RegExp(`^${from} to ${until} · suspended by Kelab Renang Damai Manager on \\d{4}-\\d{2}-\\d{2}: Unpaid locker fee`)).waitFor();
      expect(await activity(mgrApi, club.venueId)).toContain("membership.suspended");
    });

    const p = member.page;
    await s.step(member, "on her account page, on her phone: her membership suspended from today for a week, bookings already made not cancelled; and an email with the venue's reason", async () => {
      await p.goto(`${url}/account`);
      const mine = p.locator("section").filter({ has: p.getByRole("heading", { name: "Your memberships" }) });
      await mine.getByText(`Suspended from ${from} until ${until}`).waitFor();
      await mine.getByText("On those days it gives no member's price or members-only place, to you or anybody it covers. Bookings already made are not cancelled: the venue reviews them.").waitFor();
      expect(await fitsScreen(p)).toBeLessThanOrEqual(1);
      // The email is queued in the outbox for its next run (the scheduler, off on the acceptance server, or staff
      // opening the venue's messages, which runs it): the messages list is opened, as staff would.
      expect((await mgrApi.api("GET", `/api/admin/messages?venueId=${club.venueId}`)).status).toBe(200);
      if (serverLog) {
        const m = await emailed(member.email, new RegExp(`^Your membership at ${club.name} is suspended$`));
        expect(m.text).toContain(`from ${from} until ${until}`);
        expect(m.text).toContain("The venue's reason: Unpaid locker fee: suspended until it is settled.");
      }
    });

    await s.step(member, "chooses a members' session inside it: the form says her membership is suspended on its date, and booking is refused because she is suspended today, not asked to join", async () => {
      await p.goto(slotLink(club.venueId, "swimming", pool, wanted.date, wanted.hour));
      const said = p.getByRole("alert").filter({ hasText: `Members only on ${wanted.date}` });
      await said.getByText(`Your membership is suspended on ${wanted.date}.`).waitFor();
      expect(await fitsScreen(p)).toBeLessThanOrEqual(1);
      await p.getByRole("button", { name: /^Book · RM/ }).click();
      // Refused for today's suspension: reserving at a members-only venue is asked for the day it is booked.
      await p.getByRole("alert").filter({ hasText: `This session is for members, and your membership here is suspended on ${from}. Ask the venue.` }).waitFor();
      expect(await p.getByText("This venue is for members only. Ask the venue how to join").count()).toBe(0);
    });

    await s.step(manager, "under Bookings, the booking already made inside the suspension is listed to decide: membership suspended", async () => {
      const mp = manager.page;
      await mp.getByRole("button", { name: "Bookings", exact: true }).click();
      const flags = mp.locator("section").filter({ has: mp.getByRole("heading", { name: "Bookings to decide: a membership no longer covers them" }) });
      await flags.locator("li").filter({ hasText: bookedCode }).getByText(/membership suspended/).waitFor();
    });

    await s.step(desk, "checks her booking today in at the desk: warned her membership is suspended on that date, and does not admit her", async () => {
      const dp = desk.page;
      const seen: string[] = [];
      dp.on("dialog", (d) => {
        seen.push(d.message());
        void d.dismiss();
      });
      await dp.getByRole("button", { name: "Bookings", exact: true }).click();
      await dp.getByLabel("Day to show").fill(already.date);
      const row = dp.locator("tr").filter({ hasText: bookedCode });
      await row.getByRole("button", { name: "check in", exact: true }).click();
      await expect.poll(() => seen.length).toBe(1);
      expect(seen[0]).toContain("This session is for members. Before you check them in:");
      expect(seen[0]).toContain(`membership is suspended on ${already.date}.`);
      await row.getByRole("button", { name: "check in", exact: true }).waitFor();
    });

    await s.step(manager, "reactivates it, saying why: reactivated from today, the flagged booking left for staff to decide", async () => {
      const mp = manager.page;
      await mp.getByRole("button", { name: "Credit & passes", exact: true }).click();
      await line(mp).getByText("Suspend or reactivate").click();
      await line(mp).getByLabel("Why it is reactivated now").fill("Locker fee paid at the counter.");
      await line(mp).getByRole("button", { name: "Reactivate", exact: true }).click();
      await line(mp).getByText("Reactivated from today. Bookings flagged by the suspension stay for you to decide under Bookings.").waitFor();
      await line(mp).getByText(/reactivated by Kelab Renang Damai Manager on \d{4}-\d{2}-\d{2}: Locker fee paid at the counter\./).waitFor();
      expect(await activity(mgrApi, club.venueId)).toContain("membership.reactivated");
    });

    await s.step(member, "books the same members' session: the form says she is a member on its date, and it is booked; her account shows no suspension", async () => {
      await p.goto(slotLink(club.venueId, "swimming", pool, wanted.date, wanted.hour));
      await p.getByRole("status").filter({ hasText: `Members only on ${wanted.date}` }).getByText(`You: a member on ${wanted.date}`).waitFor();
      await p.getByRole("button", { name: /^Book · RM/ }).click();
      await p.getByText("Booking confirmed!").waitFor({ timeout: 15_000 });
      await p.goto(`${url}/account`);
      await p.getByText(/MS-[A-Z0-9]{4,}/).first().waitFor();
      expect(await p.getByText(/^Suspended from /).count()).toBe(0);
    });
  });
});

// ------------------------------------------------------------------ Times AE

describe("staff times in the staff language", () => {
  scenario("Times AE: a manager switches the dashboard to Malay, then Chinese, and reads the bookings, the schedule and the activity log's times in that language; a customer arriving by a ?lang=ms link keeps Malay on the next page", async (s) => {
    const owner = await signInOwner(await s.actor("Owner"));
    const club = await venueOf(owner, "Pusat Sukan Masa", "tennis");
    const mgrApi = await staffApi(await s.actor("Manager API"), club.manager.email);
    const customer = await signUp(await s.actor("Customer"));
    const slot = await freeSlot({ sport: "tennis", venueId: club.venueId, hours: [18] });
    const booked = await customer.api("POST", "/api/bookings", { courtId: slot.courtId, sport: "tennis", date: slot.date, start: 18 * 60, end: 19 * 60, name: "Customer Tester", phone: customer.phone });
    expect(booked.status, JSON.stringify(booked.body)).toBe(201);
    const code = (booked.body.booking as { code: string }).code;
    // Something in the activity log: the booking marked paid (setup).
    expect((await mgrApi.api("POST", "/api/admin/payments", { code, paid: true, via: "cash" })).status).toBe(200);
    const manager = await s.actor("Manager");
    const mp = manager.page;
    const row = () => mp.locator("tr").filter({ hasText: code });
    const loggedAt = () => mp.locator("tr").filter({ hasText: code }).locator("td").first();

    await s.step(manager, "signs in in English: the booking reads 6:00 PM – 7:00 PM", async () => {
      await staffSignIn(manager, club.manager.email);
      await mp.getByLabel("Day to show").fill(slot.date);
      await row().getByText(/6:00 PM\s*–\s*7:00 PM/).waitFor();
    });

    await s.step(manager, "switches the dashboard to Malay: the booking reads 6:00 PTG – 7:00 PTG, never PM", async () => {
      await mp.getByRole("button", { name: "ms" }).click();
      await mp.getByRole("button", { name: "Tempahan", exact: true }).first().waitFor();
      await mp.getByLabel("Hari untuk dipaparkan").fill(slot.date);
      await row().getByText(/6:00 PTG\s*–\s*7:00 PTG/).waitFor();
      expect(await row().textContent()).not.toMatch(/\b(AM|PM)\b/);
    });

    await s.step(manager, "opens the court schedule in Malay for that day: its hours headed 6 PTG, 9 PG and so on", async () => {
      await mp.getByRole("button", { name: "Jadual gelanggang", exact: true }).click();
      await mp.locator('input[type="date"]').first().fill(slot.date);
      await mp.locator("thead th").filter({ hasText: /^6 PTG$/ }).waitFor();
      await mp.locator("thead th").filter({ hasText: /^9 PG$/ }).first().waitFor();
      expect(await mp.locator("thead th").filter({ hasText: /PM|AM/ }).count()).toBe(0);
    });

    await s.step(manager, "opens the activity log under Laporan: the payment's time written PG or PTG", async () => {
      await mp.getByRole("button", { name: "Laporan", exact: true }).click();
      await mp.getByRole("heading", { name: "Aktiviti kakitangan" }).waitFor();
      await loggedAt().waitFor();
      expect(await loggedAt().textContent()).toMatch(/^\d{4}-\d{2}-\d{2} \d{1,2}:\d{2} (PG|PTG)$/);
    });

    await s.step(manager, "switches to Chinese: the log's time reads 上午 or 下午, the schedule 下午6, the booking 下午6:00 – 下午7:00", async () => {
      await mp.getByRole("button", { name: "中文" }).click();
      await mp.getByRole("button", { name: "报表", exact: true }).click();
      await mp.getByRole("heading", { name: "员工操作记录" }).waitFor();
      await expect.poll(async () => (await loggedAt().textContent()) ?? "").toMatch(/^\d{4}-\d{2}-\d{2} (上午|下午)\d{1,2}:\d{2}$/);
      await mp.getByRole("button", { name: "场地时间表", exact: true }).click();
      await mp.locator('input[type="date"]').first().fill(slot.date);
      await mp.locator("thead th").filter({ hasText: /^下午6$/ }).waitFor();
      await mp.getByRole("button", { name: "预订", exact: true }).first().click();
      await mp.getByLabel("显示日期").fill(slot.date);
      await row().getByText(/下午6:00\s*–\s*下午7:00/).waitFor();
    });

    const visitor = await s.actor("Visitor", "phone");
    const vp = visitor.page;
    await s.step(visitor, "opens a link with ?lang=ms in a browser that never chose a language: My booking in Malay", async () => {
      await vp.goto(`${url}/my-booking?lang=ms`);
      await vp.getByRole("button", { name: "Cari tempahan saya" }).waitFor();
      expect(await vp.locator("html").getAttribute("lang")).toBe("ms");
    });

    await s.step(visitor, "goes on to another page from there, with no ?lang in its address: still in Malay", async () => {
      await vp.goto(`${url}/games`);
      expect(new URL(vp.url()).searchParams.get("lang")).toBeNull();
      expect(await vp.locator("html").getAttribute("lang")).toBe("ms");
      await vp.getByRole("heading", { name: "Cari permainan" }).waitFor();
      expect(await fitsScreen(vp)).toBeLessThanOrEqual(1);
    });
  });
});

// ------------------------------------------------------------------ Credit AF

describe("a lesson paid from credit", () => {
  scenario("Credit AF: a customer with RM200 of credit books a lesson on the coach's page, ticks pay from credit, and is told it is paid from her credit", async (s) => {
    const owner = await signInOwner(await s.actor("Owner"));
    const club = await venueOf(owner, "Kelab Tenis Kredit", "tennis");
    const mgrApi = await staffApi(await s.actor("Manager API"), club.manager.email);
    const coach = await coachesAt(mgrApi, club.venueId, [{ name: "Ana Lim", rate: 80 }]);
    const customer = await signUp(await s.actor("Customer", "phone"));
    const topUp = await mgrApi.api("POST", "/api/admin/wallet", { userId: customer.id, amount: 200, venueId: club.venueId, reason: "Prepaid coaching", via: "cash" });
    expect(topUp.status, JSON.stringify(topUp.body)).toBe(201);
    const day = dayAhead(4);
    const p = customer.page;

    const code = await s.step(customer, "on Ana Lim's page, picks a day and 10 AM, ticks pay from her credit balance (RM200 available) and books: told it is paid from her credit", async () => {
      await p.goto(`${url}/venue/${club.venueId}/coach/${coach["Ana Lim"]}`);
      await p.getByLabel("Pick a day").selectOption(day);
      await p.getByRole("button", { name: "10:00 AM", exact: true }).click();
      await p.getByLabel("Name", { exact: true }).fill("Customer Tester");
      await p.getByLabel("Phone", { exact: true }).fill(customer.phone);
      await p.getByLabel(/^Pay from my credit balance \(RM200 available\)/).check();
      await p.getByRole("button", { name: "Book 60 min with Ana Lim at 10:00 AM" }).click();
      const done = p.getByText(/^Booked\. Your code is MS-[A-Z0-9]+/);
      await done.waitFor();
      await p.getByText("Paid from your credit balance.").waitFor();
      expect(await fitsScreen(p)).toBeLessThanOrEqual(1);
      return (await done.textContent())!.match(/MS-[A-Z0-9]+/)![0];
    });

    await s.step(customer, "the lesson is paid and RM100 (court and coach) has come off her credit", async () => {
      expect((await myLesson(customer, code)).paymentStatus).toBe("paid");
      expect((await customer.api("GET", `/api/my/wallet?venueId=${club.venueId}`)).body.balance).toBe(100);
    });
  });
});

// ------------------------------------------------------------------ Accounts AG

/** The next whole hour at the venue (Malaysia), and its day. */
function nextHour(): { date: string; hour: number } {
  const now = new Date(Date.now() + 8 * 3_600_000);
  const hour = now.getUTCHours() + 1;
  return hour < 24 ? { date: now.toISOString().slice(0, 10), hour } : { date: new Date(now.getTime() + 86_400_000).toISOString().slice(0, 10), hour: hour - 24 };
}

/** A company account at the venue with RM10 of credit waiting: three places today charged to it, invoiced, one taken off (setup). */
async function accountWithCredit(s: Scenario, owner: Actor, mgrApi: Actor, club: Venue, name: string): Promise<number> {
  const hours = await owner.api("PATCH", `/api/admin/venues/${club.venueId}`, { openMin: 0, closeMin: 24 * 60 });
  expect(hours.status, JSON.stringify(hours.body)).toBe(200);
  const opened = await mgrApi.api("POST", "/api/admin/accounts", { venueId: club.venueId, name, email: `sk-${stampOf()}@school.uat.mysenam.test`, termsDays: 30 });
  expect(opened.status, JSON.stringify(opened.body)).toBeLessThan(300);
  const accountId = (opened.body.account as { id: number }).id;
  const teacher = await signUp(await s.actor("Teacher"));
  const soon = nextHour();
  const booked = await teacher.api("POST", "/api/bookings", { courtId: club.courtIds[0], sport: "swimming", date: soon.date, start: soon.hour * 60, end: soon.hour * 60 + 60, name: "Cikgu Lim", phone: teacher.phone, players: 3 });
  expect(booked.status, JSON.stringify(booked.body)).toBe(201);
  const booking = booked.body.booking as { id: number; code: string; totalPrice: number };
  expect(booking.totalPrice).toBe(30);
  const charged = await mgrApi.api("POST", "/api/admin/accounts/charge", { bookingId: booking.id, accountId });
  expect(charged.status, JSON.stringify(charged.body)).toBe(200);
  const invoiced = await mgrApi.api("POST", "/api/admin/accounts/invoices", { accountId, period: soon.date.slice(0, 7) });
  expect(invoiced.status, JSON.stringify(invoiced.body)).toBeLessThan(300);
  const off = await mgrApi.api("POST", "/api/admin/bookings/withdraw", { code: booking.code, unnamed: 1, reason: "One pupil off sick." });
  expect(off.status, JSON.stringify(off.body)).toBe(200);
  return accountId;
}

describe("an account's credit paid back by hand", () => {
  scenario("Accounts AG: a manager closes a school's account that holds RM10 of credit; it stays listed, marked closed, with the credit; the desk cannot record it, the manager records it paid back by hand and it is gone", async (s) => {
    const owner = await signInOwner(await s.actor("Owner"));
    const club = await venueOf(owner, "Kolam Sekolah", "pool");
    const mgrApi = await staffApi(await s.actor("Manager API"), club.manager.email);
    const school = `SK Taman Tun ${stampOf()}`;
    const accountId = await accountWithCredit(s, owner, mgrApi, club, school);
    const manager = await s.actor("Manager");
    const mp = manager.page;
    const card = () => mp.locator("li").filter({ hasText: school });

    await s.step(manager, "under Credit & passes, sees the school's account with RM10 of credit for the next invoice, and closes it after a confirm", async () => {
      await staffSignIn(manager, club.manager.email);
      await mp.getByRole("button", { name: "Credit & passes", exact: true }).click();
      await card().getByText("credit for the next invoice").waitFor();
      expect(await card().textContent()).toContain("credit for the next invoice RM10");
      const asked = nextDialog(mp);
      await card().getByRole("button", { name: "Close", exact: true }).click();
      await card().getByText("closed", { exact: true }).waitFor();
      expect(asked()).toBe(`Close ${school}'s account? Nobody can book on it after this; what is on it is still invoiced.`);
    });

    await s.step(manager, "the closed account is still listed for its credit, with only Paid back by hand left to do", async () => {
      await mp.reload();
      await mp.getByRole("button", { name: "Credit & passes", exact: true }).click();
      await card().getByText("closed", { exact: true }).waitFor();
      await card().getByRole("button", { name: "Paid back by hand" }).waitFor();
      expect(await card().getByRole("button", { name: "Close", exact: true }).count()).toBe(0);
    });
    // The front desk may not record it (the API, as the button would ask).
    const deskApi = await staffApi(await s.actor("Desk API"), club.desk.email);
    const refused = await deskApi.api("POST", "/api/admin/accounts/credits", { venueId: club.venueId, accountId, note: "x" });
    expect([refused.status, refused.body.code]).toEqual([403, "MANAGER_ONLY"]);

    await s.step(manager, "records the RM10 paid back by hand, writing down the transfer: told it will not come off an invoice, and the account leaves the list", async () => {
      const asked = nextDialog(mp, "DuitNow transfer ref 8812");
      await card().getByRole("button", { name: "Paid back by hand" }).click();
      await mp.getByText(`Recorded RM10 paid back to ${school} by hand. It will not come off an invoice.`).waitFor();
      expect(asked()).toBe(
        `Has the RM10 of credit on ${school} been paid back by hand (a bank transfer, say)? It will then never come off an invoice. Write down how, to find it again:`
      );
      await gone(card());
      expect(await activity(mgrApi, club.venueId)).toContain("account.credit_settled");
    });
  });
});

// ------------------------------------------------------------------ Counter AH

describe("the venue's policies at the counter, and a manager's override", () => {
  scenario("Counter AH: managers may override the house rules' limits; a number at its limit is refused at the counter, the desk told to ask a manager, the manager overrides with a reason; a blocked number has no override", async (s) => {
    const owner = await signInOwner(await s.actor("Owner"));
    const club = await venueOf(owner, "Kelab Tenis Kaunter", "tennis");
    const mgrApi = await staffApi(await s.actor("Manager API"), club.manager.email);
    // One booking at a time for each person or household (setup).
    const rules = await mgrApi.api("POST", "/api/admin/house-rules", { venueId: club.venueId, upcoming: 1 });
    expect(rules.status, JSON.stringify(rules.body)).toBe(200);
    // A regular with one booking already, made online; other free hours for the counter (setup).
    const regular = await signUp(await s.actor("Regular"));
    const first = await freeSlot({ sport: "tennis", venueId: club.venueId, fromDay: 3, toDay: 5 });
    const second = await freeSlot({ sport: "tennis", venueId: club.venueId, fromDay: 6, toDay: 9 });
    const blockedAt = await freeSlot({ sport: "tennis", venueId: club.venueId, fromDay: 6, toDay: 9 });
    const online = await regular.api("POST", "/api/bookings", { courtId: first.courtId, sport: "tennis", date: first.date, start: first.hour * 60, end: first.hour * 60 + 60, name: "Regular Tester", phone: regular.phone });
    expect(online.status, JSON.stringify(online.body)).toBe(201);
    const manager = await s.actor("Manager");
    const mp = manager.page;
    const refusal =
      "The house rules allow 1 upcoming bookings at a time for each person or household, and this number has that many. A manager may override this for one booking where the venue allows it.";

    /** At the counter: the venue's page with a staff session, the hour picked, the caller's name and number given, booked. */
    const counterBook = async (a: Actor, at: { courtId: number; date: string; hour: number }, name: string, phone: string) => {
      await a.page.goto(slotLink(club.venueId, "tennis", at.courtId, at.date, at.hour));
      await a.page.getByRole("button", { name: /^Book · RM/ }).waitFor();
      await a.page.getByLabel("Name", { exact: true }).fill(name);
      await a.page.getByLabel("Phone", { exact: true }).fill(phone);
      await a.page.getByRole("button", { name: /^Book · RM/ }).click();
    };

    await s.step(manager, "under Venue details, opens Manager overrides: every one off; turns on the house rules' limits", async () => {
      await staffSignIn(manager, club.manager.email);
      await mp.getByRole("button", { name: "Venue details", exact: true }).first().click();
      await mp.getByRole("button", { name: "Manager overrides", exact: true }).click();
      const box = mp.getByLabel("The house rules' limits (bookings at once, a week, a day)");
      await box.waitFor();
      expect(await box.isChecked()).toBe(false);
      expect(await mp.getByLabel("No-show strikes", { exact: true }).isChecked()).toBe(false);
      await box.click();
      await mp.getByText("Saved.", { exact: true }).waitFor();
      expect(await box.isChecked()).toBe(true);
    });

    const desk = await s.actor("Desk");
    await s.step(desk, "at the counter, books the regular by his number: refused in the counter's words, told to ask a manager, with no override to give", async () => {
      await staffSignIn(desk, club.desk.email);
      await counterBook(desk, second, "Regular Tester", regular.phone);
      await desk.page.getByText(refusal).waitFor();
      await desk.page.getByText("Ask a manager: this venue lets its managers override this for one booking.").waitFor();
      expect(await desk.page.getByRole("button", { name: "Override and book" }).count()).toBe(0);
      expect(await desk.page.getByText("Booking confirmed!").count()).toBe(0);
    });

    const code = await s.step(manager, "at the counter, the same: offered Override for this booking; with a reason, overrides it and the booking is made", async () => {
      await counterBook(manager, second, "Regular Tester", regular.phone);
      await mp.getByText(refusal).waitFor();
      await mp.getByText("Override for this booking").waitFor();
      const go = mp.getByRole("button", { name: "Override and book" });
      expect(await go.isDisabled()).toBe(true);
      await mp.getByLabel("Why (kept with the booking and in the activity log)").fill("League fixture moved by the venue; he plays both.");
      await go.click();
      await mp.getByText("Booking confirmed!").waitFor({ timeout: 15_000 });
      return (await mp.getByText(/MS-[A-Z0-9]{4,}/).first().textContent())!.match(/MS-[A-Z0-9]{4,}/)![0];
    });

    await s.step(manager, "under Bookings, the booking says who overrode which policy and why; the activity log has it", async () => {
      await mp.goto(`${url}/admin`);
      await mp.getByLabel("Day to show").fill(second.date);
      const row = mp.locator("tr").filter({ hasText: code });
      await row.getByText(`Overridden by ${club.manager.name}: house rules. Why: League fixture moved by the venue; he plays both.`).waitFor();
      expect(await activity(mgrApi, club.venueId)).toContain("booking.policy_overridden");
    });

    // A number the venue has blocked (setup: blocked by the manager, with the reason).
    const blocked = await mgrApi.api("POST", `/api/admin/venues/${club.venueId}/blocked-phones`, { phone: "0139990001", reason: "Repeated no-shows." });
    expect(blocked.status, JSON.stringify(blocked.body)).toBe(200);

    await s.step(manager, "at the counter, books the blocked number: refused even for a manager, pointed to the blocked numbers, with no override offered", async () => {
      await counterBook(manager, blockedAt, "Blocked Caller", "0139990001");
      await mp.getByText(/^The venue has blocked this number, so it cannot be booked, even by a manager\./).waitFor();
      expect(await mp.getByText("Override for this booking").count()).toBe(0);
      expect(await mp.getByRole("button", { name: "Override and book" }).count()).toBe(0);
      expect(await mp.getByText("Booking confirmed!").count()).toBe(0);
    });
  });
});
