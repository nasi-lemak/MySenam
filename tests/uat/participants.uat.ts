import { describe, expect } from "vitest";
import type { Locator, Page } from "playwright-core";
import { fitsScreen, freeSlot, gone, scenario, signInOwner, signUp, url, type Actor } from "./harness";
import {
  applyFor,
  archeryRange,
  confirmedCode,
  decideApi,
  family,
  laneLink,
  readable,
  reachable,
  staffApi,
  staffSignIn,
  tappable,
} from "./families";

/**
 * Children and other participants taking part apart from the account that
 * books and pays (ADR 0023; docs/features/booking.md#booking-for-somebody-else),
 * as a family, a venue's staff and a stranger meet it: two children on one
 * parent's account, each with their own approval, booking, waiting-list
 * place and door; a child registered and booked at the counter, with what
 * the front desk may not do and who did what on record; who may book what
 * on the search page, for each child and for nobody in particular; and the
 * same journeys on a phone.
 *
 * Each scenario has an archery range of its own (lanes that need the venue's
 * sign-off, taking applications online as a safety assessment), made by the
 * platform's owner with a manager and a front desk. Families and the
 * applications a scenario is not about go through the API; what it is about
 * goes through the pages.
 */

const APPLY = (venueId: number) => `${url}/account/approvals?venueId=${venueId}&sport=archery`;

/** The parent's application card for one child, on their approvals page. */
const card = (page: Page, name: string) => page.locator("li").filter({ hasText: `For ${name}` });

/** The front desk's list of applications waiting, one row per application. */
const waitingRow = (page: Page, name: string) =>
  page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Applications waiting for review" }) })
    .locator("li")
    .filter({ hasText: new RegExp(`for ${name}\\b`) });

/** A child applied for on the approvals page, by declaration. */
async function applyOnPage(page: Page, venueId: number, child: string) {
  await page.goto(APPLY(venueId));
  await page.getByLabel("Who is this application for?").selectOption({ label: child });
  await page.getByLabel(/range officer's calls/).check();
  await page.getByLabel(/have the authority to apply for them/).check();
  await page.getByRole("button", { name: "Send application" }).click();
  await page.getByText("Sent. The venue reviews it and you hear by email.").waitFor();
}

/** On the booking form: who is taking part, ticked as a parent would. */
async function takingPart(page: Page | Locator, who: { me: boolean; children: string[]; all: string[] }) {
  const me = page.getByLabel("Me", { exact: true });
  if ((await me.isChecked()) !== who.me) await me.click();
  for (const name of who.all) {
    const box = page.getByLabel(`${name} (booked by you)`);
    if ((await box.isChecked()) !== who.children.includes(name)) await box.click();
  }
}

/** What the door says for a booking, asked on My booking as the customer would. */
async function doorFor(page: Page, code: string, phone: string): Promise<string> {
  await page.goto(`${url}/my-booking`);
  await page.getByLabel("Booking code").fill(code);
  await page.getByLabel("Phone number").fill(phone);
  await page.getByRole("button", { name: "Find my booking" }).click();
  await page.getByRole("button", { name: "Show me the door code" }).click();
  const said = page.locator("p.text-red-700");
  await said.waitFor();
  return (await said.textContent())!.trim();
}

describe("participants: children apart from the account that books for them", () => {
  scenario("Participants A: a parent's two children, one approved and one not, keep their own status on the account, the booking form and the door", async (s) => {
    const owner = await signInOwner(await s.actor("Owner"));
    const range = await archeryRange(owner, "Panahan Damansara");
    const parent = await signUp(await s.actor("Parent"));
    const page = parent.page;

    await s.step(parent, "adds two children on their account page: same parent, same contact details, two people", async () => {
      await page.goto(`${url}/account`);
      const people = page.locator("section").filter({ has: page.getByRole("heading", { name: "People you manage" }) });
      await people.getByText("Nobody yet.").waitFor();
      for (const [name, year] of [
        ["Alya", "2014"],
        ["Bilal", "2016"],
      ]) {
        await people.getByLabel("First name, or what the family calls them").fill(name);
        await people.getByLabel("Birth year (only if an activity needs an age)").fill(year);
        await people.getByLabel(/^You are their/).selectOption("parent");
        await people.getByLabel(/^I am their parent, legal guardian/).check();
        await people.getByRole("button", { name: "Add", exact: true }).click();
        await people.locator("li").filter({ hasText: name }).waitFor();
      }
      await people.locator("li").filter({ hasText: "Alya" }).getByText(/born 2014 · parent/).waitFor();
      await people.locator("li").filter({ hasText: "Bilal" }).getByText(/born 2016 · parent/).waitFor();
      // Never discoverable, nothing else kept: said where they are added.
      await people.getByText(/no email, phone, photo, school or identity number is kept/).waitFor();
    });

    await s.step(parent, "applies for each child on the venue's application form, declaring their authority", async () => {
      await applyOnPage(page, range.venueId, "Alya");
      await applyOnPage(page, range.venueId, "Bilal");
      await card(page, "Alya").getByText("Waiting for review").waitFor();
      await card(page, "Bilal").getByText("Waiting for review").waitFor();
    });

    const manager = await s.actor("Manager");
    await s.step(manager, "sees two applications, each for its child and by the same declared parent, and approves Alya's only", async () => {
      await staffSignIn(manager, range.manager.email);
      for (const name of ["Alya", "Bilal"])
        await waitingRow(manager.page, name).getByText(`Applied by ${parent.name} Tester (declared parent) for ${name}`).waitFor();
      await waitingRow(manager.page, "Alya").getByRole("button", { name: "Approve", exact: true }).click();
      await gone(waitingRow(manager.page, "Alya"));
      await waitingRow(manager.page, "Bilal").getByText("Waiting for review").waitFor();
    });

    await s.step(parent, "finds Alya approved and Bilal still waiting on their approvals page", async () => {
      await page.goto(`${url}/account/approvals`);
      await card(page, "Alya").getByText("Approved", { exact: true }).waitFor();
      await card(page, "Bilal").getByText("Waiting for review").waitFor();
    });

    const first = await freeSlot({ sport: "archery", venueId: range.venueId, hours: [14, 15, 16, 17] });
    const alyaCode = await s.step(parent, "on the booking form, is refused a lane for Bilal and books it for Alya", async () => {
      await page.goto(laneLink(range.venueId, first.courtId, first.date, first.hour));
      await page.getByRole("button", { name: /^Book · RM/ }).waitFor();
      await takingPart(page, { me: false, children: ["Bilal"], all: ["Alya", "Bilal"] });
      await page.getByRole("button", { name: /^Book · RM/ }).click();
      await page.getByText(/Bilal needs the venue's own sign-off for Archery first/).waitFor();
      await takingPart(page, { me: false, children: ["Alya"], all: ["Alya", "Bilal"] });
      await page.getByRole("button", { name: /^Book · RM/ }).click();
      return confirmedCode(page);
    });

    // The door: the lane left unstaffed in the afternoon with a code on its lock,
    // and both children shown round (setup, as the venue would have done).
    const venueSet = await owner.api("PATCH", `/api/admin/venues/${range.venueId}`, { staffedFrom: 8, staffedTo: 12 });
    expect(venueSet.status).toBe(200);
    for (const lane of range.laneIds) {
      const unmanned = await owner.api("PATCH", `/api/admin/courts/${lane}`, { unmanned: true, accessCode: "2468" });
      expect(unmanned.status).toBe(200);
    }
    const mgr = await staffApi(await s.actor("Manager API"), range.manager.email);
    for (const child of ["Alya", "Bilal"]) {
      const known = (await mgr.api("GET", `/api/admin/participants?venueId=${range.venueId}&phone=${encodeURIComponent(parent.phone)}`)).body.participants as { id: number; displayName: string }[];
      const id = known.find((p) => p.displayName === child)!.id;
      const inducted = await mgr.api("POST", "/api/admin/inductions", { venueId: range.venueId, phone: parent.phone, participantId: id });
      expect(inducted.status, JSON.stringify(inducted.body)).toBeLessThan(300);
    }

    const second = await freeSlot({ sport: "archery", venueId: range.venueId, hours: [14, 15, 16, 17, 18, 19] });
    const bilalCode = await s.step(manager, "books a lane for Bilal past the rules at the counter: a manager may, and it is recorded", async () => {
      const mp = manager.page;
      await mp.goto(laneLink(range.venueId, second.courtId, second.date, second.hour));
      await mp.getByRole("button", { name: /^Book · RM/ }).waitFor();
      await mp.getByLabel("Name", { exact: true }).fill(`${parent.name} Tester`);
      await mp.getByLabel("Phone", { exact: true }).fill(parent.phone);
      await mp.getByRole("button", { name: "For somebody on this number (a child)?" }).click();
      await mp.getByRole("checkbox", { name: /^Bilal/ }).check();
      await mp.getByLabel(/^Book outside this court's rules/).check();
      await mp.getByRole("button", { name: /^Book · RM/ }).click();
      return confirmedCode(mp);
    });

    await s.step(parent, "at the door, Alya's booking passes her approval and induction (only payment is left); Bilal's asks for his own sign-off", async () => {
      const alya = await doorFor(page, alyaCode, parent.phone);
      expect(alya).toMatch(/not paid yet/);
      expect(alya).not.toMatch(/sign-off/);
      const bilal = await doorFor(page, bilalCode, parent.phone);
      expect(bilal).toMatch(/needs a sign-off from the venue's staff before the door code is given/);
    });

    await s.step(manager, "sees each booking on the day under the child it is for, booked by the parent", async () => {
      const mp = manager.page;
      await mp.goto(`${url}/admin`);
      await mp.getByRole("button", { name: /sign out/i }).waitFor({ timeout: 15_000 });
      await mp.getByLabel("Day to show").fill(first.date);
      await mp.locator("tr").filter({ hasText: alyaCode }).getByText(`Alya · booked by ${parent.name} Tester`).first().waitFor();
      if (second.date !== first.date) await mp.getByLabel("Day to show").fill(second.date);
      await mp.locator("tr").filter({ hasText: bilalCode }).getByText(`Bilal · booked by ${parent.name} Tester`).first().waitFor();
    });
  });

  scenario("Participants B: a guardian books for a child and queues for a full lane; the place freed goes to the child still eligible, booked for her, never the parent", async (s) => {
    const owner = await signInOwner(await s.actor("Owner"));
    const range = await archeryRange(owner, "Panahan Subang", { lanes: 1 });
    const mgr = await staffApi(await s.actor("Manager"), range.manager.email);
    const { parent, kids } = await family(s, "Guardian", ["Alya", "Bilal"]);
    const page = parent.page;
    const applications: Record<string, number> = {};
    for (const child of kids) {
      applications[child.name] = await applyFor(parent, range.venueId, child);
      await decideApi(mgr, range.venueId, applications[child.name], "approve");
    }
    // Somebody else, signed off on their own account, has the lane at the hour the family wants.
    const stranger = await signUp(await s.actor("Stranger"));
    const signedOff = await mgr.api("POST", "/api/admin/sign-offs", { venueId: range.venueId, sport: "archery", name: `${stranger.name} Tester`, phone: stranger.phone, email: stranger.email });
    expect(signedOff.status, JSON.stringify(signedOff.body)).toBeLessThan(300);
    const lane = range.laneIds[0];
    const first = await freeSlot({ sport: "archery", venueId: range.venueId, fromDay: 3, toDay: 3, hours: [14, 15, 16] });
    const full = await freeSlot({ sport: "archery", venueId: range.venueId, fromDay: 4, toDay: 6, hours: [17, 18, 19] });
    const taken = await stranger.api("POST", "/api/bookings", { courtId: lane, sport: "archery", date: full.date, start: full.hour * 60, end: full.hour * 60 + 60, name: `${stranger.name} Tester`, phone: stranger.phone });
    expect(taken.status, JSON.stringify(taken.body)).toBeLessThan(300);
    const strangerCode = (taken.body.booking as { code: string }).code;

    const firstCode = await s.step(parent, "books a lane for Alya alone on the booking form", async () => {
      await page.goto(laneLink(range.venueId, lane, first.date, first.hour));
      await page.getByRole("button", { name: /^Book · RM/ }).waitFor();
      await takingPart(page, { me: false, children: ["Alya"], all: ["Alya", "Bilal"] });
      await page.getByRole("button", { name: /^Book · RM/ }).click();
      return confirmedCode(page);
    });

    /** The taken lane tapped, and who is to wait for it ticked in the waiting-list form. */
    const queue = async (who: { me: boolean; children: string[] }) => {
      await page.getByTitle("Taken — click to join the waitlist").click();
      const modal = page.locator("div.fixed.inset-0").filter({ hasText: "Lane 1" });
      await takingPart(modal, { ...who, all: ["Alya", "Bilal"] });
      await modal.getByRole("button", { name: "Join waitlist" }).click();
      return modal;
    };

    await s.step(parent, "finds the lane taken at the hour wanted, and may not queue for themself: they have no sign-off of their own", async () => {
      await page.goto(laneLink(range.venueId, lane, full.date, full.hour));
      await page.getByTitle("Taken — click to join the waitlist").waitFor();
      expect(await page.getByTitle("Taken — click to join the waitlist").count()).toBe(1);
      const modal = await queue({ me: true, children: [] });
      await modal.getByText(/Archery here needs a sign-off from the venue's staff first/).waitFor();
      await modal.getByRole("button", { name: "Cancel" }).click();
    });

    await s.step(parent, "queues Bilal and then Alya for it, each an entry of their own", async () => {
      for (const name of ["Bilal", "Alya"]) {
        const modal = await queue({ me: false, children: [name] });
        await modal.getByText("You're on the waitlist").waitFor();
        await modal.getByRole("button", { name: "Done" }).click();
      }
      await page.goto(`${url}/account`);
      const list = page.locator("section").filter({ has: page.getByRole("heading", { name: "Waitlist" }) });
      await list.locator("li").filter({ hasText: "For Bilal" }).getByText("Waiting for a place").waitFor();
      await list.locator("li").filter({ hasText: "For Alya" }).getByText("Waiting for a place").waitFor();
    });

    // While they wait, the venue takes Bilal's approval back (its own reason): he can no longer book it.
    await decideApi(mgr, range.venueId, applications.Bilal, "revoke", "Missed the range safety refresher");

    await s.step(stranger, "cancels their booking from their account, freeing the lane", async () => {
      await stranger.page.goto(`${url}/account`);
      stranger.page.once("dialog", (d) => void d.accept());
      await stranger.page.locator("div.rounded-xl").filter({ hasText: strangerCode }).getByRole("button", { name: "Cancel booking" }).click();
      await gone(stranger.page.locator("div.rounded-xl").filter({ hasText: strangerCode }).getByRole("button", { name: "Cancel booking" }));
    });

    const claimed = await s.step(parent, "is offered the place for Alya, not for Bilal ahead of her, whose approval was taken back; claims it, for Alya", async () => {
      await page.goto(`${url}/account`);
      const list = page.locator("section").filter({ has: page.getByRole("heading", { name: "Waitlist" }) });
      const forAlya = list.locator("li").filter({ hasText: "For Alya" });
      await forAlya.getByText(/A place is being held for you/).waitFor();
      await list.locator("li").filter({ hasText: "For Bilal" }).getByText("Waiting for a place").waitFor();
      await forAlya.getByRole("link", { name: "Claim place" }).click();
      await page.getByRole("button", { name: "Claim my place" }).click();
      await page.getByText("The place is yours").waitFor();
      await page.getByText("For Alya").waitFor();
      return (await page.getByText(/MS-[A-Z0-9]{4,}/).first().textContent())!.match(/MS-[A-Z0-9]{4,}/)![0];
    });

    await s.step(mgr, "sees the claimed booking on its day under Alya, booked by the guardian", async () => {
      await mgr.page.goto(`${url}/admin`);
      await mgr.page.getByRole("button", { name: /sign out/i }).waitFor({ timeout: 15_000 });
      await mgr.page.getByLabel("Day to show").fill(full.date);
      await mgr.page.locator("tr").filter({ hasText: claimed }).getByText(`Alya · booked by ${parent.name} Tester`).first().waitFor();
    });

    await s.step(parent, "finds both bookings on their account, each saying it is Alya's", async () => {
      await page.goto(`${url}/account`);
      for (const code of [firstCode, claimed]) await page.locator("div.rounded-xl").filter({ hasText: code }).getByText("For Alya").waitFor();
    });
  });

  scenario("Participants C: the front desk registers a walk-in's child and books her at the counter; what the desk may not do is refused, and the activity log says who did what for whom", async (s) => {
    const owner = await signInOwner(await s.actor("Owner"));
    const range = await archeryRange(owner, "Panahan Klang");
    const guardian = { name: "Puan Tan Mei Ling", phone: `012${String(Date.now()).slice(-7)}` };
    const slot = await freeSlot({ sport: "archery", venueId: range.venueId, hours: [14, 15, 16, 17] });
    const desk = await s.actor("Desk");
    const page = desk.page;
    page.on("dialog", (d) => void d.accept());

    /** The booking form at the counter, for the guardian in front of the desk, with the people on their number looked up. */
    const atCounter = async () => {
      await page.goto(laneLink(range.venueId, slot.courtId, slot.date, slot.hour));
      await page.getByRole("button", { name: /^Book · RM/ }).waitFor();
      await page.getByLabel("Name", { exact: true }).fill(guardian.name);
      await page.getByLabel("Phone", { exact: true }).fill(guardian.phone);
      await page.getByRole("button", { name: "For somebody on this number (a child)?" }).click();
    };

    await s.step(desk, "signs in at the counter, registers the guardian's daughter as somebody new on their number, with the guardian's declaration made to them", async () => {
      await staffSignIn(desk, range.desk.email);
      await atCounter();
      await page.getByText("Nobody this venue knows on this number.").waitFor();
      await page.getByRole("button", { name: "Add somebody new on this number" }).click();
      await page.getByPlaceholder("Their first name").fill("Mei");
      await page.getByPlaceholder("Birth year (optional)").fill("2015");
      await page.getByLabel("The guardian is their").selectOption({ label: "guardian is their parent" });
      await page.getByLabel(`${guardian.name} told me they are this person's parent`, { exact: false }).check();
      await page.getByRole("button", { name: "Add", exact: true }).click();
      // Added, and ticked as taking part: the guardian is named beside her, as declared.
      const mei = page.getByRole("checkbox", { name: /^Mei/ });
      await mei.waitFor();
      expect(await mei.isChecked()).toBe(true);
      await page.getByText(`guardian: ${guardian.name} (parent)`).waitFor();
    });

    await s.step(desk, "books the lane for Mei and is refused: she has no sign-off of her own, and the guardian's number is not hers", async () => {
      await page.getByRole("button", { name: /^Book · RM/ }).click();
      await page.getByText(/Mei needs the venue's own sign-off for Archery first/).waitFor();
    });

    const signOff = async (who: Actor) => {
      await who.page.getByRole("button", { name: "Courts & rates", exact: true }).click();
      const panel = who.page.locator("section").filter({ has: who.page.getByRole("heading", { name: "Staff sign-offs and certifications" }) });
      await panel.getByPlaceholder("Name").fill(guardian.name);
      await panel.locator('input[placeholder]').nth(1).fill(guardian.phone);
      await panel.getByLabel("For", { exact: true }).selectOption("archery");
      await panel.getByRole("button", { name: "For somebody on this number (a child)?" }).click();
      await panel.getByRole("radio", { name: /^Mei/ }).check();
      await panel.getByRole("button", { name: "Record", exact: true }).click();
      return panel;
    };

    await s.step(desk, "may not sign Mei off for archery, a safety assessment the desk was not delegated, nor reach the participants' corrections", async () => {
      await page.goto(`${url}/admin`);
      await page.getByRole("button", { name: /sign out/i }).waitFor({ timeout: 15_000 });
      const panel = await signOff(desk);
      await panel.getByText(/This is a safety assessment: a manager, a coach named for this activity, or staff delegated for it decides/).waitFor();
      expect(await panel.locator("li").filter({ hasText: "Mei" }).count()).toBe(0);
      await page.getByRole("button", { name: "Venue details", exact: true }).first().click();
      await page.getByRole("button", { name: /sign out/i }).waitFor();
      expect(await page.getByRole("heading", { name: "Participants: guardians and own logins" }).count()).toBe(0);
      const known = (await desk.api("GET", `/api/admin/participants?venueId=${range.venueId}&phone=${guardian.phone}`)).body.participants as { id: number }[];
      const correction = await desk.api("PATCH", `/api/admin/participants/${known[0].id}`, { venueId: range.venueId, action: "link", email: "someone@uat.mysenam.test", reason: "asked at the desk" });
      expect(correction.status).toBe(403);
    });

    const manager = await s.actor("Manager");
    await s.step(manager, "signs Mei off for archery under her own name, on her guardian's number", async () => {
      await staffSignIn(manager, range.manager.email);
      const panel = await signOff(manager);
      await panel.locator("li").filter({ hasText: "Mei (participant)" }).filter({ hasText: guardian.phone }).waitFor();
    });

    const code = await s.step(desk, "books the lane for Mei at the counter, now that she is signed off", async () => {
      await atCounter();
      const mei = page.getByRole("checkbox", { name: /^Mei/ });
      await mei.check();
      expect(await page.getByRole("checkbox", { name: "The number holder takes part too" }).isChecked()).toBe(false);
      await page.getByRole("button", { name: /^Book · RM/ }).click();
      return confirmedCode(page);
    });

    await s.step(manager, "finds the booking under Mei, booked by her guardian, and in the activity log who registered and booked her, and for whom", async () => {
      const mp = manager.page;
      // A fresh look at the dashboard, on its bookings tab.
      await mp.goto(`${url}/admin`);
      await mp.getByRole("button", { name: /sign out/i }).waitFor({ timeout: 15_000 });
      await mp.getByRole("button", { name: "Bookings", exact: true }).click();
      await mp.getByLabel("Day to show").fill(slot.date);
      await mp.locator("tr").filter({ hasText: code }).getByText(`Mei · booked by ${guardian.name}`).first().waitFor();
      await mp.getByRole("button", { name: "Reports", exact: true }).click();
      const log = mp.locator("section").filter({ has: mp.getByRole("heading", { name: "Staff activity" }) });
      const rows = log.locator("tbody tr");
      await rows.filter({ hasText: range.desk.name }).filter({ hasText: /Added Mei \(participant \d+\) at the counter/ }).getByText("Added a participant at the counter").waitFor();
      const booked = rows.filter({ hasText: code });
      await booked.filter({ hasText: range.desk.name }).getByText(new RegExp(`Booked at the counter for Mei \\(participant \\d+\\), with ${guardian.name} on ${guardian.phone}`)).waitFor();
      await booked.getByText("Booked for a participant at the counter", { exact: true }).waitFor();
      await rows.filter({ hasText: range.manager.name }).getByText(new RegExp(`Sign-off for Mei \\(participant \\d+, on ${guardian.phone}`)).waitFor();
      // The desk's refused attempt granted nothing and recorded no sign-off.
      expect(await rows.filter({ hasText: range.desk.name }).filter({ hasText: "Sign-off for" }).count()).toBe(0);
    });
  });

  scenario("Participants D: who may book an activity that needs approval, as search shows it for each child, both together, the parent, and somebody not signed in", async (s) => {
    const owner = await signInOwner(await s.actor("Owner"));
    const range = await archeryRange(owner, "Panahan Puchong");
    const mgr = await staffApi(await s.actor("Manager"), range.manager.email);
    const { parent, kids } = await family(s, "Guardian", ["Alya", "Bilal"]);
    const [alya, bilal] = kids;
    await decideApi(mgr, range.venueId, await applyFor(parent, range.venueId, alya), "approve");
    await applyFor(parent, range.venueId, bilal);
    const slot = await freeSlot({ sport: "archery", venueId: range.venueId, hours: [14, 15, 16, 17] });
    const search = `${url}/search?sport=archery&date=${slot.date}`;
    /** What the range's result says it needs, and for whom. */
    const badge = (page: Page) => page.locator("li").filter({ hasText: range.name }).first().locator("[data-needs]");
    const choose = async (page: Page, who: string) => page.getByTestId("taking-picker").getByRole("button", { name: who, exact: true }).click();

    const visitor = await s.actor("Visitor");
    await s.step(visitor, "not signed in, sees only that the lanes need the venue's sign-off, and is asked about nobody", async () => {
      await visitor.page.goto(search);
      await expect.poll(() => badge(visitor.page).textContent()).toBe("needs the venue's sign-off");
      expect(await badge(visitor.page).getAttribute("data-eligibility")).toBeNull();
      expect(await visitor.page.getByTestId("taking-picker").count()).toBe(0);
    });

    const page = parent.page;
    await s.step(parent, "signed in with nobody chosen, sees the same requirement, and is asked who is taking part", async () => {
      await page.goto(search);
      await page.getByTestId("taking-picker").waitFor();
      await page.getByText("Choose who is taking part to see whether they can book what needs the venue's approval.").waitFor();
      await expect.poll(() => badge(page).textContent()).toBe("needs the venue's sign-off");
    });

    await s.step(parent, "chooses Alya: approved", async () => {
      await choose(page, "Alya");
      await expect.poll(() => badge(page).textContent()).toBe("Alya: approved");
      expect(await badge(page).getAttribute("data-eligibility")).toBe("eligible");
    });

    await s.step(parent, "adds Bilal: each named with their own status, and the two together are not shown as able to book", async () => {
      await choose(page, "Bilal");
      await expect.poll(() => badge(page).textContent()).toBe("Alya: approved; Bilal: application pending");
      expect(await badge(page).getAttribute("data-eligibility")).toBe("not-all");
    });

    await s.step(parent, "chooses Bilal alone, then themself too: the parent's own status is their own, not a child's", async () => {
      await choose(page, "Alya");
      await expect.poll(() => badge(page).textContent()).toBe("Bilal: application pending");
      await choose(page, "Myself");
      await expect.poll(() => badge(page).textContent()).toBe("You: approval required; Bilal: application pending");
      expect(await badge(page).getAttribute("data-eligibility")).toBe("not-all");
    });

    await s.step(parent, "opens the venue from the result: its lanes say the same for the people chosen; choosing Alya alone there says approved", async () => {
      await page.locator("li").filter({ hasText: range.name }).first().getByRole("link", { name: "Book" }).click();
      await page.waitForURL(/\/venue\//);
      await expect.poll(() => page.locator("[data-needs]").first().textContent()).toBe("You: approval required; Bilal: application pending");
      await page.goto(search);
      await choose(page, "Myself");
      await choose(page, "Bilal");
      await choose(page, "Alya");
      await expect.poll(() => badge(page).textContent()).toBe("Alya: approved");
      await page.goto(laneLink(range.venueId, slot.courtId, slot.date, slot.hour));
      await expect.poll(() => page.locator("[data-needs]").first().textContent()).toBe("Alya: approved");
    });

    await s.step(parent, "signs out: the choice is forgotten, and search shows the requirement only", async () => {
      await parent.api("POST", "/api/auth/logout");
      await page.goto(search);
      await expect.poll(() => badge(page).textContent()).toBe("needs the venue's sign-off");
      expect(await page.getByTestId("taking-picker").count()).toBe(0);
    });
  });

  scenario("Participants F: on a phone, a parent adds a child, applies and books for her; every page fits, its controls are within reach and its text is readable", async (s) => {
    const owner = await signInOwner(await s.actor("Owner"));
    const range = await archeryRange(owner, "Panahan Shah Alam");
    const mgr = await staffApi(await s.actor("Manager"), range.manager.email);
    const parent = await signUp(await s.actor("Parent", "phone"));
    const page = parent.page;
    const fits = async () => expect(await fitsScreen(page)).toBeLessThanOrEqual(1);

    await s.step(parent, "adds Alya on the account page with taps", async () => {
      await page.goto(`${url}/account`);
      const people = page.locator("section").filter({ has: page.getByRole("heading", { name: "People you manage" }) });
      await people.getByText("Nobody yet.").waitFor();
      await fits();
      const name = people.getByLabel("First name, or what the family calls them");
      await tappable(page, name);
      await readable(people.getByText("First name, or what the family calls them"));
      await name.tap();
      await name.fill("Alya");
      await tappable(page, people.getByLabel(/^You are their/));
      const authority = people.locator("label").filter({ hasText: /^I am their parent, legal guardian/ });
      await tappable(page, authority);
      await readable(authority);
      await authority.tap();
      const add = people.getByRole("button", { name: "Add", exact: true });
      await tappable(page, add);
      await add.tap();
      await people.locator("li").filter({ hasText: "Alya" }).waitFor();
      await fits();
    });

    await s.step(parent, "applies for Alya on the application form, every control reachable", async () => {
      await page.goto(APPLY(range.venueId));
      const who = page.getByLabel("Who is this application for?");
      await tappable(page, who);
      await who.selectOption({ label: "Alya" });
      for (const declaration of [/range officer's calls/, /have the authority to apply for them/]) {
        const label = page.locator("label").filter({ hasText: declaration });
        await tappable(page, label);
        await readable(label);
        await label.tap();
      }
      await fits();
      const send = page.getByRole("button", { name: "Send application" });
      await tappable(page, send);
      await send.tap();
      await page.getByText("Sent. The venue reviews it and you hear by email.").waitFor();
      await readable(card(page, "Alya").getByText("Waiting for review"));
      await fits();
    });

    const requests = (await parent.api("GET", "/api/my/approvals")).body.requests as { id: number }[];
    await decideApi(mgr, range.venueId, requests[0].id, "approve");

    await s.step(parent, "reads Alya's approval on the approvals page", async () => {
      await page.goto(`${url}/account/approvals`);
      const approved = card(page, "Alya").getByText("Approved", { exact: true });
      await approved.waitFor();
      await readable(approved);
      await readable(card(page, "Alya").getByText("For Alya"));
      await fits();
    });

    const slot = await freeSlot({ sport: "archery", venueId: range.venueId, hours: [14, 15, 16, 17] });
    await s.step(parent, "on search, chooses Alya and reads her status on the range's result", async () => {
      await page.goto(`${url}/search?sport=archery&date=${slot.date}`);
      const chip = page.getByTestId("taking-picker").getByRole("button", { name: "Alya", exact: true });
      await tappable(page, chip);
      await chip.tap();
      const badge = page.locator("li").filter({ hasText: range.name }).first().locator("[data-needs]");
      await expect.poll(() => badge.textContent()).toBe("Alya: approved");
      await reachable(page, badge);
      await readable(badge);
      await fits();
    });

    const code = await s.step(parent, "books a lane for Alya with taps: who is taking part is within reach, and the booking says it is hers", async () => {
      await page.goto(laneLink(range.venueId, slot.courtId, slot.date, slot.hour));
      const book = page.getByRole("button", { name: /^Book · RM/ });
      await book.waitFor();
      await fits();
      for (const label of ["Me", "Alya (booked by you)"]) {
        const row = page.locator("fieldset label").filter({ hasText: label === "Me" ? /^Me$/ : label });
        await tappable(page, row);
        await readable(row);
        await row.tap();
      }
      expect(await page.getByLabel("Me", { exact: true }).isChecked()).toBe(false);
      expect(await page.getByLabel("Alya (booked by you)").isChecked()).toBe(true);
      await tappable(page, book);
      await book.tap();
      return confirmedCode(page);
    });

    await s.step(parent, "finds the booking on the account page, for Alya, which fits the screen", async () => {
      await page.goto(`${url}/account`);
      const booking = page.locator("div.rounded-xl").filter({ hasText: code });
      await readable(booking.getByText("For Alya"));
      await fits();
    });
  });
});
