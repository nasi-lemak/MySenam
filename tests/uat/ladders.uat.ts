import { describe, expect } from "vitest";
import type { Actor } from "./harness";
import { fitsScreen, freeSlot, scenario, url, dayAhead } from "./harness";
import { confirmedCode } from "./families";
import { addChild, apiOwner, apiStaff, canReadEmails, emailed, openTab, people, site, staffSignIn } from "./uatc-support";

/**
 * Club ladders as a venue and its players meet them (docs/features/tournaments.md#club-ladders): a manager sets a ladder up from the dashboard;
 * three adults join on their phones; one challenges within reach; the challenged accepts and no court is held (the venue's booking page still shows
 * it free); they book through the ordinary booking page and add the booking's code to the challenge; the booking cancelled drops from it with a notice;
 * the result is reported and confirmed and the ranks move; and through all of it the public ladder page shows the ranks and the confirmed results and
 * never a challenge in any state. A junior ladder is entered by guardians and shows other families' children short. A freeze, and a manager's override with a reason.
 */

/** What a challenge says about itself on a player's page, in every state: none of it may be on the public one. */
const CHALLENGE_WORDS = /waiting for an answer|accepted, to be played|reported, to be confirmed|disputed|declined|lapsed|struck by the venue|has challenged you|You challenged|Book a court|Court booked|Reach .+:|WhatsApp|suggests \d{4}/i;
const CHALLENGE_KEYS = /challenge|booking|dispute|proposed|agreed|awaiting|contact/i;

function keysOf(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) for (const v of value) keysOf(v, into);
  else if (value && typeof value === "object")
    for (const [k, v] of Object.entries(value)) {
      into.add(k);
      keysOf(v, into);
    }
  return into;
}

/** The public ladder, looked at by somebody signed out: the ranks as listed, and no sign of a challenge in the page or in the API's answer. */
async function publicLadder(v: Actor, id: number): Promise<{ ranks: string[]; results: string[]; text: string }> {
  await v.page.goto(`${url}/ladders/${id}`);
  await v.page.getByRole("heading", { name: "The ladder" }).waitFor();
  const text = await v.page.locator("body").innerText();
  expect(text, "a challenge shows on the public page").not.toMatch(CHALLENGE_WORDS);
  const api = await v.api("GET", `/api/ladders/${id}`);
  expect(api.status).toBe(200);
  const bad = [...keysOf(api.body)].filter((k) => CHALLENGE_KEYS.test(k));
  expect(bad, "the public answer carries a field about challenges").toEqual([]);
  const ranks = (await v.page.locator("ol > li").allInnerTexts()).map((x) => x.split(/\s+/).join(" ").trim());
  const results = (await v.page.getByRole("heading", { name: "Results", exact: true }).count())
    ? (await v.page.getByRole("heading", { name: "Results", exact: true }).locator("xpath=following-sibling::ul[1]/li").allInnerTexts()).map((x) => x.split(/\s+/).join(" ").trim())
    : [];
  return { ranks, results, text };
}

/** A ladder set up on the dashboard's Leagues tab by a manager already signed in; its id. */
async function setUpLadder(manager: Actor, club: { venueId: number }, name: string, audience: "adults" | "juniors"): Promise<number> {
  const page = manager.page;
  await openTab(page, "Leagues", null);
  await page.locator("summary", { hasText: /^Club ladders$/ }).click();
  const form = page.locator("form").filter({ has: page.getByRole("heading", { name: "Set up a ladder" }) });
  await form.getByLabel("Name", { exact: true }).fill(name);
  if (audience === "juniors") await form.locator("label", { hasText: "juniors (a guardian acts)" }).locator("select").selectOption({ label: "juniors (a guardian acts)" });
  await form.getByRole("button", { name: "Set up the ladder" }).click();
  await page.locator("li").filter({ hasText: name }).waitFor();
  const listed = (await manager.api("GET", `/api/admin/ladders?venueId=${club.venueId}`)).body.ladders as { id: number; name: string }[];
  return listed.find((l) => l.name === name)!.id;
}

describe("ladders", () => {
  scenario("Ladders A: a challenge accepted holds no court, is booked on the ordinary page, reported and confirmed; the public sees ranks and results, never a challenge; a freeze and a manager's override", async (s) => {
    const owner = await apiOwner();
    const club = await site(owner, "Raket Club", "badminton", 2);
    const ladderName = `Raket Club Ladder ${Date.now().toString(36)}`;
    const manager = await s.actor("Manager");
    const ladderId = await s.step(manager, "signs in and sets up an adult ladder from the Leagues tab", async () => {
      await staffSignIn(manager, club.manager.email);
      const id = await setUpLadder(manager, club, ladderName, "adults");
      await manager.page.locator("li").filter({ hasText: ladderName }).getByText("0 players").waitFor();
      return id;
    });

    const { Ravi, Siti, Tan } = await people(s, ["Ravi", "Siti", "Tan"], {}, "phone");
    const visitor = await s.actor("Visitor");
    const rankOf = (n: number, name: string) => `${n} ${name} Tester`;

    for (const [i, p] of [Ravi, Siti, Tan].entries()) {
      await s.step(p, `joins the ladder on their phone, saying they are 18 or over, at the bottom: ranked ${i + 1}`, async () => {
        await p.page.goto(`${url}/ladders/${ladderId}`);
        await p.page.getByLabel("I am 18 or over").check();
        await p.page.getByRole("button", { name: "Join at the bottom" }).click();
        await p.page.getByText(`${p.name} Tester: you are ranked ${i + 1}`).waitFor();
        expect(await fitsScreen(p.page)).toBeLessThanOrEqual(0);
      });
    }

    await s.step(visitor, "signed out, sees the three ranked and no challenge", async () => {
      const seen = await publicLadder(visitor, ladderId);
      expect(seen.ranks).toEqual([rankOf(1, "Ravi"), rankOf(2, "Siti"), rankOf(3, "Tan")]);
      expect(seen.results).toEqual([]);
    });

    const slot = await freeSlot({ venueId: club.venueId, hours: [18, 19, 20], fromDay: 4 });
    const hh = `${String(slot.hour).padStart(2, "0")}:00`;
    await s.step(Tan, "challenges Ravi, two places above, suggesting a day and time; told when Ravi has to answer", async () => {
      const page = Tan.page;
      const row = page.locator("li").filter({ hasText: "Ravi Tester" }).filter({ has: page.getByRole("button", { name: "Challenge", exact: true }) });
      await row.getByLabel("Suggest a day (optional): Ravi Tester").fill(slot.date);
      await row.getByLabel("Time: Ravi Tester").fill(hh);
      await row.getByRole("button", { name: "Challenge", exact: true }).click();
      await page.getByText(/You challenged Ravi Tester\. They answer by/).waitFor();
    });

    await s.step(visitor, "the pending challenge is nowhere on the public page or in what it is sent", async () => {
      expect((await publicLadder(visitor, ladderId)).ranks).toEqual([rankOf(1, "Ravi"), rankOf(2, "Siti"), rankOf(3, "Tan")]);
    });

    await s.step(Ravi, "on a phone, sees the challenge and accepts it", async () => {
      const page = Ravi.page;
      await page.reload();
      await page.getByText(/Tan Tester has challenged you\. Answer by/).waitFor();
      await page.getByRole("button", { name: "Accept", exact: true }).click();
      await page.getByText(/Accepted: arrange the match with Tan Tester and play it by/).waitFor();
      expect(await fitsScreen(page)).toBeLessThanOrEqual(0);
    });

    await s.step(Siti, "opens the venue's booking page for the same court and hour: it is free, nothing is held for the challenge", async () => {
      const page = Siti.page;
      await page.goto(`${url}/venue/${slot.venueId}?date=${slot.date}&sport=badminton&court=${slot.courtId}&hour=${slot.hour}&duration=1`);
      await page.getByLabel("Name").fill("Siti Tester");
      await page.getByLabel("Phone").fill(Siti.phone);
      await page.getByRole("button", { name: /^Book · RM/ }).waitFor();
      const free = await (await fetch(`${url}/api/availability?venueId=${slot.venueId}&date=${slot.date}&sport=badminton`)).json();
      const court = (free.availability as { court: { id: number }; starts: { minute: number }[] }[]).find((a) => a.court.id === slot.courtId)!;
      expect(court.starts.some((x) => x.minute === slot.hour * 60)).toBe(true);
    });

    await s.step(visitor, "the accepted challenge is not on the public page either", async () => {
      await publicLadder(visitor, ladderId);
    });

    const code = await s.step(Tan, "books that court on the ordinary booking page, as anybody does, and adds the booking's code to the challenge", async () => {
      const page = Tan.page;
      await page.goto(`${url}/venue/${slot.venueId}?date=${slot.date}&sport=badminton&court=${slot.courtId}&hour=${slot.hour}&duration=1`);
      await page.getByLabel("Name").fill("Tan Tester");
      await page.getByLabel("Phone").fill(Tan.phone);
      await page.getByRole("button", { name: /^Book · RM/ }).click();
      const booked = await confirmedCode(page);
      await page.goto(`${url}/ladders/${ladderId}`);
      await page.getByLabel("Booking code").fill(booked);
      await page.getByRole("button", { name: "Add the booking" }).click();
      await page.getByText(new RegExp(`Court booked: Court \\d, ${slot.date} ${hh}`)).waitFor();
      return booked;
    });

    await s.step(Ravi, "sees the court booked on the challenge", async () => {
      await Ravi.page.reload();
      await Ravi.page.getByText(new RegExp(`Court booked: Court \\d, ${slot.date} ${hh}`)).waitFor();
    });

    await s.step(visitor, "the booking on the challenge is not on the public page", async () => {
      const seen = await publicLadder(visitor, ladderId);
      expect(seen.text).not.toContain(code);
    });

    await s.step(Tan, "cancels the booking from their account: it drops off the challenge, which stands", async () => {
      const page = Tan.page;
      page.on("dialog", (d) => void d.accept());
      await page.goto(`${url}/account`);
      const row = page.locator("li, div").filter({ hasText: code }).filter({ has: page.getByRole("button", { name: "Cancel booking" }) }).last();
      await row.getByRole("button", { name: "Cancel booking" }).click();
      await page.getByText(/cancelled/i).first().waitFor();
      await page.goto(`${url}/ladders/${ladderId}`);
      await page.getByText("No court is held for a challenge.", { exact: false }).waitFor();
      expect(await page.getByText(/Court booked/).count()).toBe(0);
      await page.getByText(/Accepted: arrange the match with Ravi Tester/).waitFor();
    });

    if (canReadEmails()) {
      await s.step(Ravi, "is told, by email, that the booking for the challenge was cancelled and the challenge stands; so is Tan", async () => {
        const nudge = () => manager.api("GET", `/api/admin/messages?venueId=${club.venueId}`);
        for (const who of [Ravi, Tan]) {
          const mail = await emailed(who.email, /The booking for your challenge in .+ was cancelled/, { nudge });
          expect(mail.text).toContain("The challenge stands");
        }
      });
    }

    await s.step(Tan, "plays, and reports a win, their games first", async () => {
      const page = Tan.page;
      await page.reload();
      await page.getByLabel("Who won").selectOption({ label: "I won" });
      await page.getByLabel("Score (your games first)").fill("21-15, 21-17");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await page.getByText(/You reported I won 21-15, 21-17\. Waiting for Ravi Tester to confirm/).waitFor();
    });

    await s.step(visitor, "a reported result is not public until it is confirmed: ranks as they were, no result listed", async () => {
      const seen = await publicLadder(visitor, ladderId);
      expect(seen.ranks).toEqual([rankOf(1, "Ravi"), rankOf(2, "Siti"), rankOf(3, "Tan")]);
      expect(seen.results).toEqual([]);
    });

    await s.step(Ravi, "sees what Tan reported and confirms it: Ravi drops to second", async () => {
      const page = Ravi.page;
      await page.reload();
      await page.getByText(/Tan Tester reports: .+Confirm it, or say it is wrong\./).waitFor();
      await page.getByRole("button", { name: "Confirm", exact: true }).click();
      await page.getByText("Ravi Tester: you are ranked 2").waitFor();
    });

    await s.step(visitor, "the public ladder shows the new order and the confirmed result, winner first", async () => {
      const seen = await publicLadder(visitor, ladderId);
      expect(seen.ranks).toEqual([rankOf(1, "Tan"), rankOf(2, "Ravi"), rankOf(3, "Siti")]);
      expect(seen.results).toHaveLength(1);
      expect(seen.results[0]).toMatch(/Tan Tester beat Ravi Tester 21-15, 21-17$/);
    });

    await s.step(Siti, "challenges Ravi, who declines: free of any penalty, and not on the public page either", async () => {
      await Siti.page.goto(`${url}/ladders/${ladderId}`);
      const row = Siti.page.locator("li").filter({ hasText: "Ravi Tester" }).filter({ has: Siti.page.getByRole("button", { name: "Challenge", exact: true }) });
      await row.getByRole("button", { name: "Challenge", exact: true }).click();
      await Siti.page.getByText(/You challenged Ravi Tester/).waitFor();
      await Ravi.page.reload();
      await Ravi.page.getByText(/Siti Tester has challenged you/).waitFor();
      await Ravi.page.getByRole("button", { name: "Decline", exact: true }).click();
      await Ravi.page.getByText(/Siti Tester has challenged you/).waitFor({ state: "detached" });
      const seen = await publicLadder(visitor, ladderId);
      expect(seen.ranks).toEqual([rankOf(1, "Tan"), rankOf(2, "Ravi"), rankOf(3, "Siti")]);
    });

    await s.step(Siti, "freezes her place for ten days: it says so, and the public ladder shows the day it thaws", async () => {
      const page = Siti.page;
      await page.reload();
      await page.getByLabel("Freeze my place until").fill(dayAhead(10));
      await page.getByRole("button", { name: "Freeze", exact: true }).click();
      await page.getByText(/Your place is frozen until/).waitFor();
      const seen = await publicLadder(visitor, ladderId);
      expect(seen.ranks[2]).toContain(`frozen until ${dayAhead(10)}`);
    });

    await s.step(manager, "opens the ladder on the dashboard: every challenge in every state is there, with its result", async () => {
      const page = manager.page;
      await page.reload();
      await openTab(page, "Leagues", null);
      await page.locator("summary", { hasText: /^Club ladders$/ }).click();
      await page.locator("li").filter({ hasText: ladderName }).getByRole("button", { name: "Open", exact: true }).click();
      const challenges = page.locator("section").filter({ has: page.getByRole("heading", { name: "Challenges" }) });
      await challenges.getByText(/Tan Tester v Ravi Tester/).first().waitFor();
      await challenges.getByText(/confirmed 21-15, 21-17/).first().waitFor();
      await challenges.getByText(/Siti Tester v Ravi Tester/).first().waitFor();
      await challenges.getByText(/declined/).first().waitFor();
    });

    await s.step(manager, "moves Ravi to first place: refused without a reason, done with one, which is kept in the ledger", async () => {
      const page = manager.page;
      const row = page.locator("tr").filter({ hasText: "Ravi Tester" });
      await row.getByLabel("Move Ravi Tester to rank").fill("1");
      await row.getByRole("button", { name: "Move", exact: true }).click();
      await page.getByRole("alert").waitFor();
      await page.getByLabel("Reason for the next change", { exact: false }).fill("Reigning champion back from injury");
      await row.getByRole("button", { name: "Move", exact: true }).click();
      await page.locator("tbody tr").first().getByText("Ravi Tester").waitFor();
      await page.getByText("The ledger of this season").click();
      await page.getByText(/moved by the venue: Ravi Tester → 1 · Reigning champion back from injury/).waitFor();
      const seen = await publicLadder(visitor, ladderId);
      expect(seen.ranks.map((x) => x.replace(/ frozen.*/, ""))).toEqual([rankOf(1, "Ravi"), rankOf(2, "Tan"), rankOf(3, "Siti")]);
    });

    await s.step(manager, "the front desk may not move anybody: the server refuses it", async () => {
      const desk = await apiStaff(club.desk.email);
      const rows = ((await manager.api("GET", `/api/admin/ladders/${ladderId}`)).body.ladder as { rows: { playerId: number; name: string }[] }).rows;
      const siti = rows.find((r) => r.name === "Siti Tester")!;
      const refused = await desk.api("POST", `/api/admin/ladders/${ladderId}`, { action: "move", playerId: siti.playerId, rank: 1, reason: "Desk thinks so" });
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({ code: "MANAGER_ONLY" });
    });
  });

  scenario("Ladders B: a junior ladder is entered by guardians and shows other families' children short, staff and their own guardian the name as entered, and never a child's contact", async (s) => {
    const owner = await apiOwner();
    const club = await site(owner, "Junior Raket Club", "badminton", 2);
    const ladderName = `Junior Ladder ${Date.now().toString(36)}`;
    const manager = await s.actor("Manager");
    const ladderId = await s.step(manager, "sets up a ladder for juniors from the Leagues tab", async () => {
      await staffSignIn(manager, club.manager.email);
      return setUpLadder(manager, club, ladderName, "juniors");
    });

    const { Mother, Father } = await people(s, ["Mother", "Father"], {}, "phone");
    await addChild(Mother, "Aina Lim", 2014);
    await addChild(Father, "Bala Raj", 2013);
    const visitor = await s.actor("Visitor");

    for (const [i, [guardian, child]] of ([[Mother, "Aina Lim"], [Father, "Bala Raj"]] as const).entries()) {
      await s.step(guardian, `joins ${child} at the bottom of the junior ladder: ranked ${i + 1}`, async () => {
        const page = guardian.page;
        await page.goto(`${url}/ladders/${ladderId}`);
        await page.getByLabel("Who is joining").selectOption({ label: child });
        await page.getByRole("button", { name: "Join at the bottom" }).click();
        // On her own page the guardian's child is named as entered; every other child is first name and initial.
        await page.getByText(`${child}: you are ranked ${i + 1}`).waitFor();
        expect(await fitsScreen(page)).toBeLessThanOrEqual(0);
      });
    }

    await s.step(visitor, "signed out, sees the two children by first name and initial, never in full", async () => {
      const seen = await publicLadder(visitor, ladderId);
      expect(seen.ranks).toEqual(["1 Aina L.", "2 Bala R."]);
      expect(seen.text).not.toContain("Aina Lim");
      expect(seen.text).not.toContain("Bala Raj");
      const api = await visitor.api("GET", `/api/ladders/${ladderId}`);
      expect(JSON.stringify(api.body)).not.toMatch(/Aina Lim|Bala Raj/);
    });

    await s.step(Father, "challenges the child above, whom he sees only as Aina L.; the mother sees only Bala R., and each sees their own child in full", async () => {
      const page = Father.page;
      await page.reload();
      await page.getByText("Bala Raj: you are ranked 2").waitFor();
      const row = page.locator("li").filter({ hasText: "Aina L." }).filter({ has: page.getByRole("button", { name: "Challenge", exact: true }) });
      await row.getByRole("button", { name: "Challenge", exact: true }).click();
      await page.getByText(/You challenged Aina L\./).waitFor();
      expect(await page.locator("body").innerText()).not.toContain("Aina Lim");
      await Mother.page.reload();
      await Mother.page.getByText(/Bala R\. has challenged you/).waitFor();
      expect(await Mother.page.locator("body").innerText()).not.toContain("Bala Raj");
    });

    await s.step(Mother, "accepts for her daughter: no phone number or message link of the other child's family appears", async () => {
      const page = Mother.page;
      await page.getByRole("button", { name: "Accept", exact: true }).click();
      await page.getByText(/Accepted: arrange the match with Bala R\./).waitFor();
      expect(await page.locator('a[href^="tel:"], a[href*="wa.me"]').count()).toBe(0);
      expect(await page.locator("body").innerText()).not.toMatch(/Reach /);
      await publicLadder(visitor, ladderId);
    });

    await s.step(manager, "on the dashboard the ladder lists the children by the names entered, as staff run it, with each in the challenge; the public page still shows first name and initial", async () => {
      const page = manager.page;
      await page.reload();
      await openTab(page, "Leagues", null);
      await page.locator("summary", { hasText: /^Club ladders$/ }).click();
      await page.locator("li").filter({ hasText: ladderName }).getByRole("button", { name: "Open", exact: true }).click();
      await page.locator("tr").filter({ hasText: "Aina Lim" }).filter({ hasText: "in a challenge" }).waitFor();
      await page.locator("tr").filter({ hasText: "Bala Raj" }).filter({ hasText: "in a challenge" }).waitFor();
      expect(await publicLadder(visitor, ladderId).then((x) => x.text)).not.toMatch(/Aina Lim|Bala Raj/);
    });
  });
});
