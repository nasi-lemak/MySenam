import { describe, expect, inject, vi } from "vitest";
import type { Page } from "playwright-core";
import { dayAhead, fitsScreen, scenario, signInOwner, signUp, type Actor, type Device, type Scenario } from "./harness";
import { clockedServer, instantOfDay, rebase, type ClockedServer } from "./day-support";
import { enterOnDashboard, formatsVenue, nameOf, openTournament, seed, sentEmails, staffApi, staffDetail, staffOnTournaments, type Match } from "./formats-support";

/**
 * Tournament day, as an organiser, the front desk, the players, a customer and the public meet it, each in a browser of their
 * own: the *Now and next* board, check-ins, the next match announced once to each side (a child's notice to the guardian,
 * naming the other families' children short), a fixture called to a court a result freed, the court time held against
 * the venue's own booking page, the wait for players who do not come and what the manager decides (the front desk has no
 * button and is refused), and the public live page.
 *
 * A tournament has to start after today, so its day cannot be today on the main acceptance server: this scenario runs on a
 * second server of its own, the same build with its clock movable (tests/uat/day-support.ts), makes and draws the
 * tournament for a later day with the clock as it is, and then sets the clock to a few minutes before the day's first match.
 * The wait for the players is the real minute the tournament's own setting gives. Skipped against a deployment.
 */

// The wait for a called match to be given up is real minutes, and a whole day's players sign up first.
vi.setConfig({ testTimeout: 1_200_000 });

const serverLog = inject("uatServerLog");

const clock = (minute: number) => `${Math.floor(minute / 60) % 12 === 0 ? 12 : Math.floor(minute / 60) % 12}:${String(minute % 60).padStart(2, "0")} ${minute < 720 ? "AM" : "PM"}`;

/** The board of the tournament open on the dashboard, and a fixture on its list of those waiting, by who plays in it. */
const board = (page: Page) => page.getByRole("region", { name: "Now and next" });
const waiting = (page: Page, a: string, b: string) => board(page).locator("li").filter({ hasText: a }).filter({ hasText: b });
/** An entrant's row in the dashboard's list of entries. */
const entryRow = (page: Page, name: string) => page.locator("tr").filter({ hasText: name });

describe.skipIf(!serverLog)("tournament day", () => {
  scenario("Day 1: the board, check-ins, the next match announced once, a fixture called to a freed court, the court time held, a no-show decided, the live page", async (s) => {
    const server = await clockedServer(s.dir);
    try {
      await run(s, server);
    } finally {
      await server.stop();
    }
  });
});

async function run(s: Scenario, server: ClockedServer): Promise<void> {
  const base = server.base;
  const actor = async (name: string, device: Device = "desktop") => rebase(await s.actor(name, device), server);
  const owner = await signInOwner(await actor("Owner"));
  const venue = await formatsVenue(owner, "Dewan Hari", { courts: 2 });
  const organiser = await actor("Organiser");
  const desk = await actor("Desk");
  const mum = await signUp(await actor("Mum", "phone"));
  const bala = await actor("Bala", "phone");
  const people = [bala];
  for (const n of ["Chen", "Devi", "Esa", "Farid", "Gita", "Hana"]) people.push(await actor(n));
  // One after another: a sign-up takes a fraction of a second, and the acceptance servers' outbox (no scheduler) sends what a request queues as it goes.
  for (const p of people) await signUp(p);
  const customer = await signUp(await actor("Customer", "phone"));
  const visitor = await actor("Visitor", "phone");
  const page = organiser.page;
  const stamp = Date.now().toString(36).slice(-4);
  const name = `Day Cup ${stamp}`;
  // The day: tomorrow, from two in the afternoon, seven matches of 40 minutes on two courts.
  const day = dayAhead(1);
  const FIRST = 14 * 60;

  const child = await mum.api("POST", "/api/my/people", { displayName: "Aina Binti Lim", birthYear: new Date().getFullYear() - 11, relationship: "parent", authority: true });
  expect(child.status).toBeLessThan(300);
  const childId = (child.body.person as { id: number }).id;
  await staffApi(organiser, venue.manager.email);
  const made = await organiser.api("POST", "/api/admin/tournaments", {
    venueId: venue.venueId,
    courtIds: venue.courtIds,
    name,
    sport: "badminton",
    template: "racket_best_of_3",
    format: "knockout",
    teamSize: 1,
    entryFee: 0,
    maxEntries: 8,
    startsOn: day,
    endsOn: day,
    startMin: FIRST,
    endMin: 18 * 60,
    matchMinutes: 40,
    resultsBy: "staff",
  });
  expect(made.status, JSON.stringify(made.body)).toBe(201);
  const id = (made.body.tournament as { id: number }).id;
  expect((await mum.api("POST", `/api/tournaments/${id}`, { action: "enter", participantId: childId })).status).toBe(201);
  for (const p of people) expect((await p.api("POST", `/api/tournaments/${id}`, { action: "enter" })).status).toBe(201);
  // Bala the first seed takes the first line, Aina the second the last: so she plays in the second slot of the first round.
  await seed(organiser, id, "Bala Tester", 1);
  await seed(organiser, id, "Aina Binti Lim", 2);

  await s.step(organiser, "signs in, closes entries and makes the draw for tomorrow: seven matches on two courts", async () => {
    await staffOnTournaments(organiser, venue.manager.email, base);
    await openTournament(page, name);
    await page.getByRole("button", { name: "Close entries" }).click();
    await page.getByRole("button", { name: "Make the draw" }).click();
    await page.getByRole("heading", { name: new RegExp(`${name} · drawn`) }).waitFor();
    await board(page).waitFor();
    const d = await staffDetail(organiser, id);
    expect(d.matches.filter((m) => m.status !== "bye")).toHaveLength(7);
    for (const m of d.matches) expect(m.date).toBe(day);
  });

  // The day comes: twelve minutes before the first match.
  server.setNow(instantOfDay(day, FIRST - 12));

  const detail = () => staffDetail(organiser, id);
  const d0 = await detail();
  const ainaName = d0.entries.find((e) => e.name.startsWith("Aina"))!.name;
  const ainaId = d0.entries.find((e) => e.name === ainaName)!.id;
  const firstRound = d0.matches.filter((m) => m.round === 1 && m.status === "scheduled");
  const earliest = Math.min(...firstRound.map((m) => m.minute!));
  const early = firstRound.filter((m) => m.minute === earliest).sort((x, y) => x.position - y.position);
  const late = firstRound.filter((m) => m.minute !== earliest);
  const withAina = late.find((m) => m.a === ainaId || m.b === ainaId)!;
  expect(withAina, "Aina, the second seed, plays in the second slot of the first round").toBeDefined();
  const otherLate = late.find((m) => m.id !== withAina.id)!;
  const [played, noShow] = early;
  const byName = (entryName: string): Actor => people.find((p) => `${p.name} Tester` === entryName)!;
  const oppName = nameOf(d0, withAina.a === ainaId ? withAina.b : withAina.a);
  const [absentName, presentName] = [nameOf(d0, noShow.a), nameOf(d0, noShow.b)];
  const sides = (m: Match): [string, string] => [nameOf(d0, m.a), nameOf(d0, m.b)];
  const NEXT = /^Your match is next/;
  const CALLED = /^Come to the court now/;
  const MOVED = /^Your match has moved/;
  const score = (m: Match, winner: number) => (winner === m.a ? "21-12, 21-14" : "12-21, 14-21");

  // Messages are queued for the outbox's next run (the scheduler is off here); staff opening the venue's messages runs it, as here.
  const flush = async () => expect((await organiser.api("GET", `/api/admin/messages?venueId=${venue.venueId}`)).status).toBe(200);
  const mails = async (to: string, subject: RegExp) => {
    await flush();
    return sentEmails(server.output).filter((m) => m.to === to && subject.test(m.subject));
  };
  /** The emails to one address with this subject, once there are at least `count`. */
  const got = async (to: string, subject: RegExp, count = 1) => {
    const deadline = Date.now() + 30_000;
    for (;;) {
      const found = await mails(to, subject);
      if (found.length >= count) return found;
      if (Date.now() > deadline) throw new Error(`Expected ${count} email(s) to ${to} with a subject matching ${subject}, found ${found.length}`);
      await new Promise((r) => setTimeout(r, 500));
    }
  };

  /** Nothing the customer is offered starts inside a fixture's held minutes, on its court (the venue's own availability for the day). */
  const heldNotOffered = async (when: string) => {
    const d = await detail();
    const res = await customer.api("GET", `/api/availability?venueId=${venue.venueId}&date=${day}&sport=badminton`);
    const availability = res.body.availability as { court: { id: number }; starts: { minute: number; maxLength: number }[] }[];
    const held = d.matches.filter((m) => m.status === "scheduled" && m.minute !== null && m.courtId !== null);
    expect(held.length, when).toBeGreaterThan(0);
    for (const m of held) {
      const starts = availability.find((c) => c.court.id === m.courtId)?.starts ?? [];
      for (const st of starts) expect(st.minute < m.minute! + m.minutes && st.minute + st.maxLength > m.minute!, `${when}: court ${m.courtId} offered at ${clock(st.minute)} over match ${m.id}`).toBe(false);
    }
    return d;
  };

  await s.step(customer, "tries to book minutes the tournament holds: the venue's page does not offer them, and the booking is refused", async () => {
    const d = await heldNotOffered("after the draw");
    // The hour that holds the last minute of the last match of a court.
    const last = d.matches.filter((m) => m.status === "scheduled" && m.minute !== null).sort((x, y) => y.minute! + y.minutes - (x.minute! + x.minutes))[0];
    const hour = Math.floor((last.minute! + last.minutes - 1) / 60);
    await customer.page.goto(`${base}/venue/${venue.venueId}?date=${day}&sport=badminton&court=${last.courtId}&hour=${hour}&duration=1`);
    await customer.page.getByText(venue.name).first().waitFor();
    await customer.page.waitForLoadState("networkidle");
    // The grid shows the held hour as not available (a dash in place of a price, a button that cannot be pressed), and no booking form opens for it.
    const taken = customer.page.getByRole("button").filter({ hasText: /^—$/ }).first();
    await taken.waitFor();
    expect(await taken.isDisabled(), "the held hour cannot be chosen").toBe(true);
    expect(await customer.page.getByRole("button", { name: /^Book · RM/ }).count(), "no booking can be made over the held minutes").toBe(0);
    const refused = await customer.api("POST", "/api/bookings", { courtId: last.courtId, date: day, hours: [hour], name: `${customer.name} Tester`, phone: customer.phone });
    expect(refused.status).toBeGreaterThanOrEqual(400);
    expect(await fitsScreen(customer.page)).toBeLessThanOrEqual(0);
  });

  await s.step(desk, "signs in at the front desk: the board is there to read, with nobody checked in, and no button to call a match", async () => {
    await staffOnTournaments(desk, venue.desk.email, base);
    await openTournament(desk.page, name);
    await board(desk.page).waitFor();
    await board(desk.page).getByText("A manager calls matches to their courts and decides what happens when nobody comes.", { exact: false }).waitFor();
    await waiting(desk.page, absentName, presentName).getByText(`${absentName} is not checked in`, { exact: false }).waitFor();
    expect(await board(desk.page).getByRole("button", { name: "Call", exact: true }).count()).toBe(0);
    const called = await desk.api("POST", `/api/admin/tournaments/${id}/day`, { action: "call", matchId: noShow.id });
    expect(called.status).toBe(403);
    expect(called.body.code).toBe("MANAGER_ONLY");
  });

  await s.step(desk, "checks in the four players of the first slot", async () => {
    for (const n of [...sides(played), ...sides(noShow)]) {
      await entryRow(desk.page, n).getByRole("button", { name: "check in" }).click();
      await entryRow(desk.page, n).getByRole("button", { name: "✓ here" }).waitFor();
    }
  });

  await s.step(organiser, "checks in the rest: what stopped each fixture goes from the board, and it says Ready", async () => {
    await page.reload();
    await page.getByRole("button", { name: "Tournaments", exact: true }).click();
    await openTournament(page, name);
    await board(page).waitFor();
    await waiting(page, ainaName, oppName).getByText(`${ainaName} is not checked in`, { exact: false }).waitFor();
    for (const n of [...sides(withAina), ...sides(otherLate)]) {
      await entryRow(page, n).getByRole("button", { name: "check in" }).click();
      await entryRow(page, n).getByRole("button", { name: "✓ here" }).waitFor();
    }
    // The board refreshes by itself every 15 seconds: it says Ready for every first-round fixture.
    for (const m of [played, noShow, withAina, otherLate]) await waiting(page, ...sides(m)).getByText("Ready", { exact: true }).waitFor({ timeout: 40_000 });
  });

  await s.step(organiser, "sets a called match to wait one minute for its players", async () => {
    await board(page).locator("summary").filter({ hasText: "Day settings" }).click();
    await board(page).getByLabel("How long a called match waits for its players (minutes)").fill("1");
    await board(page).getByRole("button", { name: "Save", exact: true }).click();
    await board(page).getByText("Saved.").waitFor();
    expect(((await organiser.api("GET", `/api/admin/tournaments/${id}`)).body.tournament as { callWaitMinutes: number }).callWaitMinutes).toBe(1);
  });

  await s.step(organiser, "calls the two fixtures of the first slot to their courts ahead of their time", async () => {
    for (const m of [played, noShow]) await waiting(page, ...sides(m)).getByRole("button", { name: "Call", exact: true }).click();
    await board(page).getByText(/brought to Court \d at /).first().waitFor();
    await board(page).getByText("min left for the players to come", { exact: false }).first().waitFor();
    // What the customer is offered still keeps clear of every fixture, moved or not.
    await heldNotOffered("after two fixtures were brought forward");
  });

  await s.step(organiser, "marks the first match as started, and the front desk enters its result", async () => {
    const [a, b] = sides(played);
    const card = board(page).locator("div").filter({ hasText: a }).filter({ has: page.getByRole("button", { name: "Started" }) }).last();
    await card.getByRole("button", { name: "Started" }).click();
    await board(page).getByText("Playing", { exact: true }).first().waitFor();
    await enterOnDashboard(desk.page, a, b, score(played, played.a!), a);
  });

  await s.step(mum, "and the next matches are announced: Aina's, once, to her guardian, whose it is first; her opponent is told her short name", async () => {
    const toMum = (await got(mum.email, NEXT))[0];
    expect(toMum.text).toContain("This entry is for Aina Binti Lim.");
    expect(toMum.text).toContain(`against ${oppName}`);
    const toOpponent = (await got(byName(oppName).email, NEXT))[0];
    expect(toOpponent.text).toContain("Aina L.");
    expect(toOpponent.text).not.toContain("Aina Binti Lim");
    // The other second-slot fixture is announced to its two sides.
    for (const n of sides(otherLate)) expect(await got(byName(n).email, NEXT)).toHaveLength(1);
    // Those called are not "next": they were told they were called.
    for (const n of sides(noShow)) expect(await mails(byName(n).email, NEXT)).toHaveLength(0);
  });

  await s.step(organiser, "calls Aina's fixture to the court the first result freed: it is brought forward to it, and her guardian is called", async () => {
    const court = played.courtName!;
    await waiting(page, ainaName, oppName).locator("select").selectOption({ label: court });
    await board(page).getByText(new RegExp(`brought to ${court} at `)).first().waitFor();
    const toMum = (await got(mum.email, CALLED))[0];
    expect(toMum.text).toContain("This entry is for Aina Binti Lim.");
    const toOpponent = (await got(byName(oppName).email, CALLED))[0];
    expect(toOpponent.text).toContain("Aina L.");
    expect(toOpponent.text).not.toContain("Aina Binti Lim");
    await heldNotOffered("after Aina's fixture was brought forward");
  });

  await s.step(visitor, "opens the public live page on a phone: Aina by first name and initial, what is on each court, what is next, the result so far", async () => {
    await visitor.page.goto(`${base}/tournaments/${id}/live`);
    await visitor.page.getByRole("heading", { name: `Live: ${name}` }).waitFor();
    await visitor.page.getByText("Recent results").waitFor();
    await visitor.page.getByText(`${sides(played)[0]} won`).waitFor();
    await visitor.page.getByText("Called: please go to the court").first().waitFor();
    const text = (await visitor.page.locator("body").textContent()) ?? "";
    expect(text).toContain("Aina L.");
    expect(text).not.toContain("Binti");
    expect(text).not.toContain("Lim");
    await visitor.page.getByText("On court now").first().waitFor();
    await visitor.page.getByText("Next", { exact: true }).first().waitFor();
    expect(await fitsScreen(visitor.page)).toBeLessThanOrEqual(0);
  });

  await s.step(desk, "sees the wait run out on the board, and still has no button to decide it", async () => {
    // A called match waits one real minute for its players: the board's own refresh shows when it is over.
    await desk.page.reload();
    await desk.page.getByRole("button", { name: "Tournaments", exact: true }).click();
    await openTournament(desk.page, name);
    await board(desk.page).getByText("Nobody came in time. Decide:").first().waitFor({ timeout: 120_000 });
    for (const b of ["Swap in the next ready match", /^Wait \d+ more minutes/, /did not come: give the match to the other side/]) expect(await board(desk.page).getByRole("button", { name: b }).count()).toBe(0);
    const decided = await desk.api("POST", `/api/admin/tournaments/${id}/day`, { action: "decide", matchId: noShow.id, decision: { action: "wait" } });
    expect(decided.status).toBe(403);
    expect(decided.body.code).toBe("MANAGER_ONLY");
  });

  await s.step(organiser, "swaps in the next ready match: the other second-slot fixture takes the court, and the match nobody came to waits", async () => {
    const [a, b] = sides(noShow);
    const card = board(page).locator("div").filter({ hasText: a }).filter({ has: page.getByRole("button", { name: "Swap in the next ready match" }) }).last();
    await card.waitFor({ timeout: 60_000 });
    await card.getByRole("button", { name: "Swap in the next ready match" }).click();
    await board(page).getByText(/takes the court; .* waits\./).waitFor();
    // Its sides are told it has moved; the fixture that took the court calls its two.
    for (const n of [a, b]) await got(byName(n).email, MOVED);
    for (const n of sides(otherLate)) await got(byName(n).email, CALLED);
    await waiting(page, a, b).getByText("Ready", { exact: true }).waitFor({ timeout: 40_000 });
  });

  await s.step(organiser, "waits once more for Aina's fixture, nobody having come", async () => {
    const card = () => board(page).locator("div").filter({ hasText: ainaName }).filter({ has: page.getByRole("button", { name: /^Wait \d+ more minutes/ }) }).last();
    await card().waitFor({ timeout: 120_000 });
    await card().getByRole("button", { name: /^Wait \d+ more minutes/ }).click();
    await board(page).getByText("min left for the players to come", { exact: false }).first().waitFor();
    // Nobody is told again: the call stands.
    expect(await mails(mum.email, CALLED)).toHaveLength(1);
  });

  await s.step(organiser, "gives the other called match to the player who came: a walkover, recorded as any is", async () => {
    const absent = sides(otherLate)[0];
    const button = board(page).getByRole("button", { name: `${absent} did not come: give the match to the other side` });
    await button.waitFor({ timeout: 120_000 });
    await button.click();
    await board(page).getByText("walkover", { exact: false }).first().waitFor();
    const d = await detail();
    const result = d.matches.find((x) => x.id === otherLate.id)!;
    expect(result.status).toBe("walkover");
    expect(result.winner).toBe(otherLate.b);
    // The match was given away, not the player: nobody was taken out of the event.
    expect(d.entries.find((e) => e.id === otherLate.a)!.status).toBe("entered");
  });

  await s.step(visitor, "sees the walkover appear on the live page, which was left open, without reloading it", async () => {
    await visitor.page.getByText(/walkover/i).first().waitFor({ timeout: 60_000 });
    await visitor.page.getByText(`${sides(otherLate)[1]} won`).first().waitFor();
    const text = (await visitor.page.locator("body").textContent()) ?? "";
    expect(text).not.toContain("Binti");
    expect(await fitsScreen(visitor.page)).toBeLessThanOrEqual(0);
  });

  await s.step(bala, "opens the tournament on his phone: Aina by first name and initial in the draw, and the live board one tap away", async () => {
    await bala.page.goto(`${base}/tournaments/${id}`);
    await bala.page.getByRole("link", { name: "Live board" }).waitFor();
    await bala.page.locator("li").filter({ hasText: "Aina L." }).first().waitFor();
    expect(await bala.page.getByText("Binti").count()).toBe(0);
    expect(await fitsScreen(bala.page)).toBeLessThanOrEqual(0);
  });

  await s.step(mum, "has been told once about each fixture of Aina's, however many results and decisions came in", async () => {
    expect(await mails(mum.email, NEXT)).toHaveLength(1);
    expect(await mails(mum.email, CALLED)).toHaveLength(1);
    expect(await mails(byName(oppName).email, NEXT)).toHaveLength(1);
    expect(await mails(byName(oppName).email, CALLED)).toHaveLength(1);
    // The player given the walkover was told it was next once, and called once.
    const winner = sides(otherLate)[1];
    expect(await mails(byName(winner).email, NEXT)).toHaveLength(1);
    expect(await mails(byName(winner).email, CALLED)).toHaveLength(1);
  });
}
