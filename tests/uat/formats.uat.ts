import { describe, expect, vi } from "vitest";
import type { Locator, Page } from "playwright-core";
import { dayAhead, fitsScreen, scenario, signInOwner, signUp, url, type Actor } from "./harness";
import {
  accounts,
  drainOutbox,
  enterAll,
  enterOnDashboard,
  firstName,
  formatsVenue,
  nameOf,
  openTournament,
  playable,
  players,
  publicDetail,
  seed,
  staffDetail,
  staffOnTournaments,
  staffRow,
  straightWin,
  tournamentNamed,
  type Detail,
  type Match,
} from "./formats-support";

// Signing up a field of players and entering a whole event on the dashboard takes minutes on a machine that is busy.
vi.setConfig({ testTimeout: 900_000 });

/**
 * The newer tournament formats, run by their organisers with the players and the public each in a browser of their own:
 * a double elimination (the winners' bracket, the losers' bracket, the grand final and its reset, a correction after play
 * has begun that moves two routes at once, the final places); a straight knockout with a consolation draw and the advanced
 * feed-in option, which says what it costs and waits to be confirmed (a draw the held time cannot hold is refused,
 * nothing changed); and a Swiss event (pairings from the standings, no rematch, the bye, tie-breaks, a round closed with a
 * match undecided, a correction that keeps the pairings or pairs again).
 *
 * Each scenario has a venue of its own with badminton courts, made by the platform's owner with its manager and front
 * desk (setup, not the subject), so the court time it holds touches no other scenario's. The format is chosen, the draw
 * made and the results entered on the dashboard's own pages; players and entries are made through the API where they are
 * not what the scenario is about.
 */

/** A different pair of scores every time, so a match played twice between the same two can be told apart on a list. */
let scoreN = 9;
function games(): string[] {
  scoreN = scoreN >= 18 ? 10 : scoreN + 1;
  return [`21-${scoreN}`, `21-${scoreN + 1}`];
}

/** The next match to play, entered on the dashboard with the winner `choose` names; undefined when none is left. */
async function playNext(manager: Actor, id: number, choose: (m: Match, d: Detail) => number, filter?: (m: Match) => boolean): Promise<{ m: Match; d: Detail; winner: number } | undefined> {
  const d = await staffDetail(manager, id);
  const m = playable(d, filter);
  if (!m) return undefined;
  const winner = choose(m, d);
  await enterOnDashboard(manager.page, nameOf(d, m.a), nameOf(d, m.b), straightWin(m, winner, games()), nameOf(d, winner));
  return { m, d, winner };
}

/** The tournament form's own fields. */
const setUpForm = (page: Page) => page.locator("form").filter({ has: page.getByRole("heading", { name: "Set up a tournament", exact: true }) });

/** The set-up form filled in as an organiser fills it: everything else as the sport's template starts it (every court, 9 AM to 6 PM, free). */
async function fillSetUp(form: Locator, o: { name: string; format: string; maxEntries: number; date: string; minutes: number; courts?: string[]; from?: string; until?: string; rounds?: number }): Promise<void> {
  await form.getByLabel("Name", { exact: true }).fill(o.name);
  await form.locator("label").filter({ hasText: /^Format/ }).locator("select").selectOption({ label: o.format });
  await form.getByLabel(/^Entry fee/).fill("0");
  await form.getByLabel("Most entries").fill(String(o.maxEntries));
  await form.getByLabel("First day").fill(o.date);
  await form.getByLabel("Last day").fill(o.date);
  await form.getByLabel("Each match (minutes)").fill(String(o.minutes));
  if (o.from) await form.getByLabel("From", { exact: true }).fill(o.from);
  if (o.until) await form.getByLabel("Until", { exact: true }).fill(o.until);
  for (const c of o.courts ?? []) await form.getByLabel(c, { exact: true }).check();
  if (o.rounds !== undefined) await form.getByLabel("Rounds", { exact: true }).fill(String(o.rounds));
}

/** Entries closed and the draw made from the tournament's own page (from the dashboard's list, or back from another tournament). */
async function closeAndDraw(page: Page, name: string): Promise<void> {
  await openTournament(page, name);
  await page.getByRole("button", { name: "Close entries" }).click();
  await page.getByRole("button", { name: "Make the draw" }).click();
  await page.getByRole("heading", { name: new RegExp(`${name} · drawn`) }).waitFor();
}

describe("tournament formats, run by their organisers", () => {
  scenario("Formats A: a double elimination, a player's loss and where they play next, the grand final and its reset, a correction replayed on both routes", async (s) => {
    const owner = await signInOwner(await s.actor("Owner"));
    const venue = await formatsVenue(owner, "Dewan Double", { courts: 3 });
    const organiser = await s.actor("Organiser");
    const date = dayAhead(41);
    const name = `Double Cup ${date}`;

    await s.step(organiser, "signs in and sets up a double elimination: the losers' bracket, the grand final and the reset have their own lengths, and the reset is on", async () => {
      await staffOnTournaments(organiser, venue.manager.email);
      const form = setUpForm(organiser.page);
      await form.getByLabel("Name", { exact: true }).fill(name);
      await form.locator("label").filter({ hasText: /^Format/ }).locator("select").selectOption({ label: "Double elimination" });
      await form.getByLabel(/^Entry fee/).fill("0");
      await form.getByLabel("Most entries").fill("8");
      await form.getByLabel("First day").fill(date);
      await form.getByLabel("Last day").fill(date);
      await form.getByLabel("Each match (minutes)").fill("40");
      const lengths = form.locator("details").filter({ hasText: "Match lengths by stage" }).first();
      await lengths.getByText("Match lengths by stage").click();
      for (const stage of ["Losers' bracket", "Grand final", "Reset"]) await lengths.getByLabel(stage, { exact: true }).waitFor();
      expect(await lengths.getByLabel("Play the grand final again if the losers' bracket's champion wins it (the reset)").isChecked()).toBe(true);
      // No consolation draw and no third-place match here: the losers' final decides third.
      expect(await lengths.getByLabel("Consolation draw for first-round losers").count()).toBe(0);
      await form.getByRole("button", { name: "Set it up and hold the courts" }).click();
      await organiser.page.locator("li").filter({ hasText: name }).getByRole("button", { name: "Open", exact: true }).waitFor();
    });
    const id = (await (async () => {
      const list = await organiser.api("GET", `/api/admin/tournaments?venueId=${venue.venueId}`);
      return (list.body.tournaments as { id: number; name: string }[]).find((t) => t.name === name)!.id;
    })());

    // Six entries: Amir, on his phone, enters on the page; the others are made and entered through the API (setup).
    const amir = await signUp(await s.actor("Amir", "phone"));
    await s.step(amir, "enters on the tournament's page", async () => {
      await amir.page.goto(`${url}/tournaments/${id}`);
      await amir.page.getByRole("button", { name: "Enter" }).click();
      await amir.page.getByText("You're entered").waitFor();
      expect(await fitsScreen(amir.page)).toBeLessThanOrEqual(0);
    });
    await players(s, ["Bala", "Chen", "Devi", "Esa", "Farid"], id);
    // The two top seeds take the byes, so that Amir plays a first match whatever the lot says.
    await seed(organiser, id, "Bala Tester", 1);
    await seed(organiser, id, "Chen Tester", 2);

    await s.step(organiser, "closes entries and makes the draw", async () => {
      await organiser.page.reload();
      await organiser.page.getByRole("button", { name: "Tournaments", exact: true }).click();
      await openTournament(organiser.page, name);
      await organiser.page.getByRole("button", { name: "Close entries" }).click();
      await organiser.page.getByRole("button", { name: "Make the draw" }).click();
      await organiser.page.getByRole("heading", { name: new RegExp(`${name} · drawn`) }).waitFor();
      const d = await staffDetail(organiser, id);
      // 6 entries: five winners' matches, four losers' matches and the grand final (2n-2) and the reset.
      expect(d.matches.filter((m) => m.status !== "bye").length).toBe(11);
    });

    const visitor = await s.actor("Visitor", "phone");
    await s.step(visitor, "opens the public bracket page on a phone: three brackets, each its own section, scrolling across rather than widening the page", async () => {
      await visitor.page.goto(`${url}/tournaments/${id}`);
      for (const title of ["Winners' bracket", "Losers' bracket"]) await visitor.page.getByRole("heading", { name: title, exact: true }).waitFor();
      await visitor.page.getByRole("heading", { name: "Grand final", exact: true }).waitFor();
      await visitor.page.getByText("Played again only if the losers' bracket's finalist wins the grand final.").waitFor();
      expect(await fitsScreen(visitor.page)).toBeLessThanOrEqual(0);
      const winners = visitor.page.locator("section").filter({ has: visitor.page.getByRole("heading", { name: "Winners' bracket", exact: true }) }).locator("div.overflow-x-auto");
      const widths = await winners.evaluate((el) => ({ inner: el.scrollWidth, outer: el.clientWidth }));
      expect(widths.inner, "the winners' bracket is wider than the screen, and scrolls inside its own section").toBeGreaterThan(widths.outer);
    });

    // The first round: Amir loses.
    const amirEntry = (await staffDetail(organiser, id)).entries.find((e) => e.name === "Amir Tester")!.id;
    await s.step(organiser, "enters the first round on the dashboard: Amir loses", async () => {
      for (let n = 0; n < 2; n++) {
        const done = await playNext(organiser, id, (m) => (m.a === amirEntry ? m.b! : m.b === amirEntry ? m.a! : m.a!), (m) => m.bracket === "winners" && m.round === 1);
        expect(done, "two first-round matches are played").toBeDefined();
      }
      expect(await playNext(organiser, id, (m) => m.a!, (m) => m.bracket === "winners" && m.round === 1)).toBeUndefined();
    });

    await s.step(amir, "sees on his phone where he plays next: the losers' bracket, with its date, time and court", async () => {
      await amir.page.goto(`${url}/tournaments/${id}`);
      const row = amir.page.locator("li").filter({ hasText: "Amir Tester" }).filter({ hasText: /Losers' (round \d|final)/ });
      await row.first().waitFor();
      const text = (await row.first().textContent()) ?? "";
      expect(text).toContain(date);
      expect(text).toMatch(/Court \d/);
      // The losers' bracket section lists him, and he is not in the winners' bracket's later rounds.
      const losers = amir.page.locator("section").filter({ has: amir.page.getByRole("heading", { name: "Losers' bracket", exact: true }) });
      await losers.getByText("Amir Tester").first().waitFor();
      expect(await fitsScreen(amir.page)).toBeLessThanOrEqual(0);
    });

    await s.step(organiser, "enters the winners' semi-finals: the winners' route has begun", async () => {
      for (;;) {
        const done = await playNext(organiser, id, (m) => m.a!, (m) => m.bracket === "winners" && m.round === 2);
        if (!done) break;
      }
      const d = await staffDetail(organiser, id);
      expect(d.matches.filter((m) => m.bracket === "winners" && m.round === 2 && m.status === "done")).toHaveLength(2);
    });

    // The scoresheet of Amir's first match turns out to have the names the wrong way round.
    const first = (await staffDetail(organiser, id)).matches.find((m) => m.bracket === "winners" && m.round === 1 && (m.a === amirEntry || m.b === amirEntry))!;
    const opponent = (first.a === amirEntry ? first.b : first.a)!;
    await s.step(organiser, "corrects Amir's first match after the winners' route has moved on: refused as a plain result, and the review shows both routes", async () => {
      const d = await staffDetail(organiser, id);
      const row = organiser.page.locator("section").filter({ has: organiser.page.getByRole("heading", { name: "Matches", exact: true }) }).locator("li").filter({ hasText: "Amir Tester" }).filter({ hasText: nameOf(d, opponent) }).filter({ hasText: "✓" }).first();
      await row.getByPlaceholder("21-15, 18-21, 21-10").fill(straightWin(first, amirEntry, ["21-17", "21-19"]));
      await row.getByRole("button", { name: "Amir won", exact: true }).click();
      const review = organiser.page.getByRole("region", { name: "Correction" });
      await review.getByRole("heading", { name: "The knockout has begun: review this correction (Amir Tester won)" }).waitFor();
      await review.getByText("Not safely: settle these by hand first", { exact: false }).waitFor();
      expect(await review.getByRole("button", { name: "Put into the knockout" }).isDisabled()).toBe(true);
      await review.getByText("This match's record only", { exact: true }).waitFor();
      // Nothing has changed yet.
      expect((await staffDetail(organiser, id)).matches.find((m) => m.id === first.id)!.winner).toBe(opponent);
    });

    await s.step(organiser, "corrects the record only, with a reason: two routes are under review, one for each of the two it moved", async () => {
      const review = organiser.page.getByRole("region", { name: "Correction" });
      await review.getByLabel("Why (kept with the correction)").fill("Referee's scoresheet: the names were swapped");
      await review.getByRole("button", { name: "Record only" }).click();
      await organiser.page.getByRole("heading", { name: "What that changed" }).waitFor();
      const issues = organiser.page.getByRole("region", { name: "Progression to resolve" });
      await issues.first().waitFor();
      expect(await issues.count()).toBe(2);
      await issues.getByRole("heading", { name: `Under review: ${nameOf(await staffDetail(organiser, id), opponent)} went on in place of Amir Tester` }).waitFor();
      await issues.getByRole("heading", { name: `Under review: Amir Tester went on in place of ${nameOf(await staffDetail(organiser, id), opponent)}` }).waitFor();
      expect((await staffDetail(organiser, id)).status).toBe("drawn");
    });

    await s.step(visitor, "sees the tournament under review, and the correction noted, on the public page", async () => {
      await visitor.page.reload();
      await visitor.page.getByText("Some results are under review by the organiser: the outcome is not final yet.").waitFor();
      await visitor.page.getByText("A result was corrected after the knockout began, by the organiser.").waitFor();
      expect(await fitsScreen(visitor.page)).toBeLessThanOrEqual(0);
    });

    await s.step(organiser, "replays both routes together: each match is given a court and a time, and the right player is in each head of a chain", async () => {
      const panels = organiser.page.getByRole("region", { name: "Progression to resolve" });
      const panel = panels.first();
      await panel.getByText("The other route of the same correction is replayed with this one", { exact: false }).waitFor();
      const courts = panel.locator('select[aria-label^="Court for "]');
      const count = await courts.count();
      expect(count).toBeGreaterThan(0);
      // After the day's own matches, one after another on the first court.
      for (let i = 0; i < count; i++) {
        await courts.nth(i).selectOption({ index: 1 });
        await panel.locator('input[aria-label^="Date for "]').nth(i).fill(date);
        const minute = 14 * 60 + 40 * i;
        await panel.locator('input[aria-label^="Time for "]').nth(i).fill(`${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`);
      }
      await panel.getByLabel("Why (kept with the resolution)").fill("Both players agreed to replay from the corrected result");
      await panel.getByRole("button", { name: "Replay", exact: true }).click();
      await organiser.page.getByRole("heading", { name: "What that changed" }).waitFor();
      await organiser.page.getByText(/replayed/i).first().waitFor();
      const d = await staffDetail(organiser, id);
      expect(d.issues.map((i) => i.status).sort()).toEqual(["replayed", "replayed"]);
      expect(d.status).toBe("drawn");
    });

    // The rest is played as it comes: the losers' champion wins the grand final.
    const choose = (m: Match, d: Detail): number => {
      if (m.bracket === "grand" && m.round === 1) {
        const final = d.matches.filter((x) => x.bracket === "winners").sort((x, y) => y.round - x.round)[0];
        return m.a === final.winner ? m.b! : m.a!;
      }
      return m.a!;
    };
    await s.step(organiser, "plays on to the grand final", async () => {
      for (;;) {
        const done = await playNext(organiser, id, choose, (m) => m.bracket !== "grand");
        if (!done) break;
      }
      const d = await staffDetail(organiser, id);
      const grand = d.matches.find((m) => m.bracket === "grand" && m.round === 1)!;
      expect(grand.a, "both finalists are known").not.toBeNull();
      expect(grand.b).not.toBeNull();
      const reset = d.matches.find((m) => m.bracket === "grand" && m.round === 2)!;
      expect(reset.a === null && reset.b === null, "the reset has nobody in it yet").toBe(true);
    });

    await s.step(visitor, "reads that the reset is played only if the losers' bracket's finalist wins the grand final", async () => {
      await visitor.page.reload();
      await visitor.page.getByText("Played again only if the losers' bracket's finalist wins the grand final.").waitFor();
    });

    await s.step(organiser, "enters the grand final: the losers' champion wins it, and the reset appears with both of them in it", async () => {
      const done = await playNext(organiser, id, choose, (m) => m.bracket === "grand" && m.round === 1);
      expect(done).toBeDefined();
      const d = await staffDetail(organiser, id);
      const reset = d.matches.find((m) => m.bracket === "grand" && m.round === 2)!;
      expect(reset.status).toBe("scheduled");
      expect(new Set([reset.a, reset.b])).toEqual(new Set([done!.m.a, done!.m.b]));
      expect(d.status).toBe("drawn");
      await organiser.page.getByRole("heading", { name: new RegExp(`${name} · drawn`) }).waitFor();
    });

    await s.step(organiser, "enters the reset: its winner is champion, and the tournament finishes", async () => {
      const done = await playNext(organiser, id, (m) => m.b!, (m) => m.bracket === "grand" && m.round === 2);
      expect(done).toBeDefined();
      await organiser.page.getByRole("heading", { name: new RegExp(`${name} · finished`) }).waitFor();
      const places = organiser.page.locator("section").filter({ has: organiser.page.getByRole("heading", { name: "Final places", exact: true }) });
      await places.waitFor();
      const d = await staffDetail(organiser, id);
      // Everybody who was in the draw has a place, once.
      const listed = (await places.locator("li").allTextContents()).join(" ");
      for (const e of d.entries) expect(listed, `${e.name} has a place`).toContain(e.name);
      expect(d.placings).toHaveLength(6);
    });

    await s.step(amir, "sees on his phone the final places, and the champion", async () => {
      await amir.page.reload();
      const d = await publicDetail(id);
      const champion = nameOf(d, d.placings!.find((p) => p.place === 1)!.entryId);
      await amir.page.getByText(`Winner: ${champion}`).waitFor();
      const places = amir.page.locator("section").filter({ has: amir.page.getByRole("heading", { name: "Final places", exact: true }) });
      await places.waitFor();
      for (const e of d.entries) await places.getByText(e.name).waitFor();
      expect(await fitsScreen(amir.page)).toBeLessThanOrEqual(0);
    });
    // What this scenario queued for its players is sent, so that nothing stands in front of the sign-up emails of the scenarios after it.
    await drainOutbox(organiser, venue.venueId);
  });

  scenario("Formats B: a knockout with a consolation draw; the advanced feed-in option says what it costs and waits to be confirmed; a draw the held time cannot hold is refused; a whole event played", async (s) => {
    const owner = await signInOwner(await s.actor("Owner"));
    const venue = await formatsVenue(owner, "Dewan Saguhati", { courts: 3 });
    const organiser = await s.actor("Organiser");
    const people = await accounts(s, ["Amir", "Bala", "Chen", "Devi", "Esa", "Farid", "Gita", "Hana"]);
    const visitor = await s.actor("Visitor", "phone");
    const page = organiser.page;
    const stamp = Date.now().toString(36).slice(-4);
    const nameC = `Consolation Cup ${stamp}`;
    const nameX = `Short Cup ${stamp}`;
    const nameY = `Feed-in Cup ${stamp}`;
    const bracketsFieldset = () => page.locator("fieldset").filter({ has: page.locator("legend", { hasText: "Brackets" }) });
    const ticked = (label: string) => bracketsFieldset().getByLabel(label);
    const consolationLabel = "Consolation draw for first-round losers";
    const feedInLabel = "Advanced: feed-in consolation, for every loser but the runner-up";

    // ---------------------------------------------------------- the first-round consolation draw
    await s.step(organiser, "signs in and sets up a knockout with a consolation draw for first-round losers", async () => {
      await staffOnTournaments(organiser, venue.manager.email);
      const form = setUpForm(page);
      await fillSetUp(form, { name: nameC, format: "Knockout", maxEntries: 8, date: dayAhead(44), minutes: 30 });
      const lengths = form.locator("details").filter({ hasText: "Match lengths by stage" }).first();
      await lengths.getByText("Match lengths by stage").click();
      await lengths.getByLabel(consolationLabel).check();
      // The ordinary consolation draw is the default one: the advanced option is offered, unticked, and says nothing of its cost.
      await lengths.getByLabel(feedInLabel).waitFor();
      expect(await lengths.getByLabel(feedInLabel).isChecked()).toBe(false);
      expect(await lengths.getByRole("group", { name: "What the feed-in consolation draw adds" }).count()).toBe(0);
      await lengths.getByText("Those who lose a first-round match that is played", { exact: false }).waitFor();
      await form.getByRole("button", { name: "Set it up and hold the courts" }).click();
      await page.locator("li").filter({ hasText: nameC }).getByRole("button", { name: "Open", exact: true }).waitFor();
    });
    const idC = await tournamentNamed(organiser, venue.venueId, nameC);
    await enterAll(people.slice(0, 6), idC);

    await s.step(organiser, "closes entries and makes the draw", async () => {
      await closeAndDraw(page, nameC);
      const d = await staffDetail(organiser, idC);
      // Six entries in an eight-line draw: two byes, two first-round matches, and the losers' consolation final.
      expect(d.matches.filter((m) => m.bracket === "main" && m.round === 1 && m.status === "scheduled")).toHaveLength(2);
      expect(d.matches.filter((m) => m.bracket === "consolation")).toHaveLength(1);
    });

    await s.step(visitor, "reads on his phone that those who lose their first match play on in the consolation draw", async () => {
      await visitor.page.goto(`${url}/tournaments/${idC}`);
      await visitor.page.getByRole("heading", { name: "Consolation draw", exact: true }).waitFor();
      await visitor.page.getByText("Players who lose their first match play on here.").waitFor();
      expect(await fitsScreen(visitor.page)).toBeLessThanOrEqual(0);
    });

    let losers: number[] = [];
    await s.step(organiser, "enters the first round: the two who lose go to the consolation final, a player with a bye who loses later does not", async () => {
      const before = await staffDetail(organiser, idC);
      const first = before.matches.filter((m) => m.bracket === "main" && m.round === 1 && m.status === "scheduled");
      losers = first.map((m) => m.b!);
      for (let n = 0; n < 2; n++) expect(await playNext(organiser, idC, (m) => m.a!, (m) => m.bracket === "main" && m.round === 1)).toBeDefined();
      const d = await staffDetail(organiser, idC);
      const consolation = d.matches.find((m) => m.bracket === "consolation")!;
      expect(new Set([consolation.a, consolation.b])).toEqual(new Set(losers));
    });

    await s.step(organiser, "plays the rest; the consolation final's two are the first-round losers and nobody else", async () => {
      for (;;) if (!(await playNext(organiser, idC, (m) => m.a!))) break;
      await page.getByRole("heading", { name: new RegExp(`${nameC} · finished`) }).waitFor();
      const d = await staffDetail(organiser, idC);
      const consolation = d.matches.filter((m) => m.bracket === "consolation");
      expect(consolation).toHaveLength(1);
      expect(new Set([consolation[0].a, consolation[0].b])).toEqual(new Set(losers));
      const places = page.locator("section").filter({ has: page.getByRole("heading", { name: "Final places", exact: true }) });
      const listed = (await places.locator("li").allTextContents()).join(" ");
      for (const e of d.entries) expect(listed, `${e.name} has a place`).toContain(e.name);
      expect(d.placings).toHaveLength(6);
    });

    // ---------------------------------------------------------- the advanced feed-in option on a tournament of one court
    await s.step(organiser, "sets up a short cup of one court for two hours, with the ordinary consolation draw", async () => {
      await page.getByRole("button", { name: /^← |Back to/ }).first().click();
      const form = setUpForm(page);
      await fillSetUp(form, { name: nameX, format: "Knockout", maxEntries: 8, date: dayAhead(45), minutes: 30, courts: ["Court 1"], from: "09:00", until: "11:00" });
      const lengths = form.locator("details").filter({ hasText: "Match lengths by stage" }).first();
      await lengths.getByText("Match lengths by stage").click();
      await lengths.getByLabel(consolationLabel).check();
      await form.getByRole("button", { name: "Set it up and hold the courts" }).click();
      await page.locator("li").filter({ hasText: nameX }).getByRole("button", { name: "Open", exact: true }).waitFor();
    });
    const idX = await tournamentNamed(organiser, venue.venueId, nameX);
    await enterAll(people, idX);

    await s.step(organiser, "ticks the advanced feed-in option on the tournament: what it adds is shown, with the court time held falling short, and nothing is saved until it is confirmed", async () => {
      await page.reload();
      await page.getByRole("button", { name: "Tournaments", exact: true }).click();
      await openTournament(page, nameX);
      await ticked(feedInLabel).click();
      const box = bracketsFieldset().getByRole("group", { name: "What the feed-in consolation draw adds" });
      await box.getByText("What it adds, for 8 entries").waitFor();
      await box.getByText("Main draw: 7 matches").waitFor();
      await box.getByText("Consolation draw: 5 matches").waitFor();
      await box.getByText("In all: 12 matches").waitFor();
      await box.getByText("This adds 5 matches and about 2.5 court hours.").waitFor();
      await box.getByText(/The court time held, 2 hours, is less than the 6 hours these matches need/).waitFor();
      // Declined: still the ordinary consolation draw.
      await bracketsFieldset().getByRole("button", { name: "Keep it as it is" }).click();
      expect(await ticked(feedInLabel).isChecked()).toBe(false);
      const rules = (await organiser.api("GET", `/api/admin/tournaments/${idX}`)).body.tournament as { rules: { bracket: { consolationMode?: string } } };
      expect(rules.rules.bracket.consolationMode ?? "first_round").toBe("first_round");
    });

    await s.step(organiser, "is refused by the server too when the choice comes without the confirmation, saying what it adds", async () => {
      const tn = (await organiser.api("GET", `/api/admin/tournaments/${idX}`)).body.tournament as { rules: { bracket: Record<string, unknown> } & Record<string, unknown> };
      const asked = await organiser.api("POST", `/api/admin/tournaments/${idX}`, { action: "rules", rules: { ...tn.rules, bracket: { ...tn.rules.bracket, consolationMode: "feed_in" } } });
      expect(asked.status).toBe(409);
      expect(asked.body.code).toBe("FEED_IN_CONFIRM");
      expect(String(asked.body.error)).toMatch(/5 matches/);
    });

    await s.step(organiser, "confirms it: 'this adds 5 matches and about 2.5 court hours', and it is saved", async () => {
      await ticked(feedInLabel).click();
      await bracketsFieldset().getByRole("button", { name: "Confirm: this adds 5 matches and about 2.5 court hours" }).click();
      await ticked(feedInLabel).waitFor();
      await page.waitForFunction(() => Array.from(document.querySelectorAll("fieldset input[type=checkbox]")).some((el) => (el.closest("label")?.textContent ?? "").startsWith("Advanced: feed-in") && (el as HTMLInputElement).checked));
      const tn = (await organiser.api("GET", `/api/admin/tournaments/${idX}`)).body.tournament as { rules: { bracket: { consolationMode: string } } };
      expect(tn.rules.bracket.consolationMode).toBe("feed_in");
    });

    await s.step(organiser, "closes entries and makes the draw: refused, with the reason, and nothing is changed", async () => {
      await page.getByRole("button", { name: "Close entries" }).click();
      await page.getByRole("button", { name: "Make the draw" }).click();
      const banner = page.locator("div.border-red-200").first();
      await banner.waitFor();
      expect((await banner.textContent()) ?? "").toMatch(/Not enough court time: \d+ of 12 matches do not fit in the hours held/);
      const d = await staffDetail(organiser, idX);
      expect(d.status).toBe("closed");
      expect(d.matches).toHaveLength(0);
      expect(d.entries.filter((e) => e.status === "entered")).toHaveLength(8);
      await page.getByRole("heading", { name: new RegExp(`${nameX} · closed`) }).waitFor();
    });

    // ---------------------------------------------------------- the feed-in option chosen on the set-up form, with the time to hold it
    await s.step(organiser, "sets up the feed-in cup on the form: the cost is shown first, and the form will not be sent without ticking that it was seen", async () => {
      await page.getByRole("button", { name: /^← |Back to/ }).first().click();
      const form = setUpForm(page);
      await fillSetUp(form, { name: nameY, format: "Knockout", maxEntries: 8, date: dayAhead(46), minutes: 30 });
      const lengths = form.locator("details").filter({ hasText: "Match lengths by stage" }).first();
      await lengths.getByText("Match lengths by stage").click();
      await lengths.getByLabel(consolationLabel).check();
      await lengths.getByLabel(feedInLabel).check();
      const box = lengths.getByRole("group", { name: "What the feed-in consolation draw adds" });
      await box.getByText("What it adds, for up to 8 entries (the most this tournament takes)").waitFor();
      await box.getByText("Main draw: 7 matches").waitFor();
      await box.getByText("Consolation draw: 5 matches").waitFor();
      await box.getByText("In all: 12 matches").waitFor();
      await box.getByText("This adds 5 matches and about 2.5 court hours.").waitFor();
      await box.getByText(/The court time held, 27 hours, is enough for the 6 hours of matches/).waitFor();
      // The knockout's own third-place match is not offered with it: the semi-finals' losers play on in the consolation draw.
      expect(await lengths.getByLabel(/^Third-place match/).isDisabled()).toBe(true);
      const confirm = lengths.getByLabel("I have seen this: it adds 5 matches and about 2.5 court hours");
      await form.getByRole("button", { name: "Set it up and hold the courts" }).click();
      expect(await confirm.evaluate((el) => (el as HTMLInputElement).validity.valueMissing), "the browser holds the form back").toBe(true);
      expect((await organiser.api("GET", `/api/admin/tournaments?venueId=${venue.venueId}`)).body.tournaments as { name: string }[]).not.toContainEqual(expect.objectContaining({ name: nameY }));
      await confirm.check();
      await form.getByRole("button", { name: "Set it up and hold the courts" }).click();
      await page.locator("li").filter({ hasText: nameY }).getByRole("button", { name: "Open", exact: true }).waitFor();
    });
    const idY = await tournamentNamed(organiser, venue.venueId, nameY);
    await enterAll(people, idY);

    await s.step(organiser, "closes entries and makes the draw: twelve matches, every one with a court and a time", async () => {
      await closeAndDraw(page, nameY);
      const d = await staffDetail(organiser, idY);
      const real = d.matches.filter((m) => m.status !== "bye");
      expect(real).toHaveLength(12);
      for (const m of real) expect(m.date !== null && m.minute !== null && m.courtId !== null, `match ${m.id} has a court and a time`).toBe(true);
    });

    await s.step(visitor, "reads on his phone that everybody who loses in the main draw, but in the final, plays on", async () => {
      await visitor.page.goto(`${url}/tournaments/${idY}`);
      await visitor.page.getByRole("heading", { name: "Consolation draw", exact: true }).waitFor();
      await visitor.page.getByText("Players who lose in the main draw, except in the final, play on here.").waitFor();
      expect(await fitsScreen(visitor.page)).toBeLessThanOrEqual(0);
    });

    await s.step(organiser, "plays the whole event of eight: twelve matches, and everybody has played at least two", async () => {
      let played = 0;
      for (;;) {
        if (!(await playNext(organiser, idY, (m) => m.a!))) break;
        played++;
      }
      expect(played).toBe(12);
      await page.getByRole("heading", { name: new RegExp(`${nameY} · finished`) }).waitFor();
      const d = await staffDetail(organiser, idY);
      for (const e of d.entries) expect(d.matches.filter((m) => m.status === "done" && (m.a === e.id || m.b === e.id)).length, `${e.name} played at least twice`).toBeGreaterThanOrEqual(2);
    });

    await s.step(organiser, "reads the final places: everybody has one, the champion and the runner-up of the main draw first", async () => {
      const d = await staffDetail(organiser, idY);
      const places = page.locator("section").filter({ has: page.getByRole("heading", { name: "Final places", exact: true }) });
      await places.waitFor();
      const listed = (await places.locator("li").allTextContents()).join(" ");
      for (const e of d.entries) expect(listed, `${e.name} has a place`).toContain(e.name);
      expect(d.placings).toHaveLength(8);
      const final = d.matches.filter((m) => m.bracket === "main").sort((x, y) => y.round - x.round)[0];
      const champion = final.winner!;
      expect(d.placings!.find((p) => p.place === 1)!.entryId).toBe(champion);
      expect(d.placings!.find((p) => p.place === 2)!.entryId).toBe(final.a === champion ? final.b : final.a);
    });

    await s.step(visitor, "sees the final places on his phone", async () => {
      await visitor.page.reload();
      const d = await publicDetail(idY);
      await visitor.page.getByText(`Winner: ${nameOf(d, d.placings!.find((p) => p.place === 1)!.entryId)}`).waitFor();
      const places = visitor.page.locator("section").filter({ has: visitor.page.getByRole("heading", { name: "Final places", exact: true }) });
      for (const e of d.entries) await places.getByText(e.name).waitFor();
      expect(await fitsScreen(visitor.page)).toBeLessThanOrEqual(0);
    });
    await drainOutbox(organiser, venue.venueId);
  });

  scenario("Formats C: a Swiss event, round 2 paired by itself with no rematch and the bye to the lowest, standings with tie-breaks, a round closed with a match undecided, a correction that keeps the pairings or pairs again", async (s) => {
    const owner = await signInOwner(await s.actor("Owner"));
    const venue = await formatsVenue(owner, "Dewan Swiss", { courts: 2 });
    const organiser = await s.actor("Organiser");
    const page = organiser.page;
    const date = dayAhead(47);
    const name = `Swiss Open ${date}`;
    const swissPanel = () => page.getByRole("region", { name: "Swiss rounds" });
    const rounds = (d: Detail, n: number) => d.matches.filter((m) => m.stage === "group" && m.round === n);
    const pairKey = (m: Match) => [m.a, m.b].sort().join("-");

    await s.step(organiser, "signs in and sets up a Swiss event: its rounds and the points for a bye are asked for, and left to the defaults", async () => {
      await staffOnTournaments(organiser, venue.manager.email);
      const form = setUpForm(page);
      await form.getByLabel("Name", { exact: true }).fill(name);
      await form.locator("label").filter({ hasText: /^Format/ }).locator("select").selectOption({ label: "Swiss (rounds paired from the standings)" });
      await form.getByLabel("Rounds", { exact: true }).waitFor();
      await form.getByLabel("Points for a bye", { exact: true }).waitFor();
      await fillSetUp(form, { name, format: "Swiss (rounds paired from the standings)", maxEntries: 8, date, minutes: 30 });
      await form.getByRole("button", { name: "Set it up and hold the courts" }).click();
      await page.locator("li").filter({ hasText: name }).getByRole("button", { name: "Open", exact: true }).waitFor();
    });
    const id = await tournamentNamed(organiser, venue.venueId, name);
    // Five players: one has a bye every round.
    const amir = await signUp(await s.actor("Amir", "phone"));
    const others = await players(s, ["Bala", "Chen", "Devi", "Esa"], id);
    void others;
    await amir.api("POST", `/api/tournaments/${id}`, { action: "enter" });

    await s.step(organiser, "closes entries and makes the draw: round 1 is paired, with a recorded seed, a bye and the court times", async () => {
      await closeAndDraw(page, name);
      await swissPanel().getByText("1 of 3 rounds paired").waitFor();
      const d = await staffDetail(organiser, id);
      expect(d.swiss!.seed, "the seed of the draw is recorded, so that the draw can be reproduced").toEqual(expect.any(Number));
      const first = rounds(d, 1);
      expect(first.filter((m) => m.status === "scheduled")).toHaveLength(2);
      expect(first.filter((m) => m.status === "bye")).toHaveLength(1);
      for (const m of first.filter((x) => x.status === "scheduled")) expect(m.date !== null && m.courtId !== null).toBe(true);
    });

    // Before any result the table is the order of the draw (the bye's point aside).
    const drawn = await staffDetail(organiser, id);
    const initial = drawn.swiss!.standings.map((l) => l.entryId);
    const bye1 = rounds(drawn, 1).find((m) => m.status === "bye")!.a!;
    await s.step(organiser, "enters round 1 on the dashboard: round 2 is paired the moment the last match is in", async () => {
      for (let n = 0; n < 2; n++) expect(await playNext(organiser, id, (m) => m.a!, (m) => m.round === 1)).toBeDefined();
      await swissPanel().getByText("2 of 3 rounds paired").waitFor();
    });

    await s.step(organiser, "reads round 2: nobody meets a first-round opponent again, and the bye goes to the lowest-ranked player without one", async () => {
      const d = await staffDetail(organiser, id);
      const first = rounds(d, 1);
      const second = rounds(d, 2);
      const met = new Set(first.filter((m) => m.status !== "bye").map(pairKey));
      for (const m of second.filter((x) => x.status !== "bye")) expect(met.has(pairKey(m)), `${nameOf(d, m.a)} v ${nameOf(d, m.b)} is a rematch`).toBe(false);
      const bye2 = second.find((m) => m.status === "bye")!.a!;
      expect(bye2, "nobody has a second bye").not.toBe(bye1);
      // After round 1: a win is a point, so is the bye; ties are broken by the order of the draw.
      const points = new Map(d.entries.map((e) => [e.id, 0]));
      for (const m of first) if (m.status === "bye") points.set(m.a!, (points.get(m.a!) ?? 0) + 1);
      else if (m.winner !== null) points.set(m.winner, (points.get(m.winner) ?? 0) + 1);
      const order = initial;
      const ranked = [...points.keys()].sort((x, y) => points.get(y)! - points.get(x)! || order.indexOf(x) - order.indexOf(y));
      expect(bye2).toBe([...ranked].reverse().find((e) => e !== bye1));
      expect(points.get(bye2)).toBe(0);
    });

    await s.step(amir, "reads the standings on his phone, ranked by points and then the published tie-breaks, and his pairing", async () => {
      await amir.page.goto(`${url}/tournaments/${id}`);
      await amir.page.getByRole("heading", { name: "Standings after 1 of 3 rounds" }).waitFor();
      await amir.page.getByText(/Ranked by points, then by Buchholz \(points of the opponents played\), median Buchholz, wins, set difference, point difference, who beat whom, then by the order of the draw\./).waitFor();
      const rows = await tableRows(amir.page, "Standings after");
      expect(rows.length).toBe(5);
      for (let i = 1; i < rows.length; i++) {
        expect(rows[i - 1].points, "points never rise down the table").toBeGreaterThanOrEqual(rows[i].points);
        if (rows[i - 1].points === rows[i].points) expect(rows[i - 1].buchholz, "level on points, the Buchholz decides").toBeGreaterThanOrEqual(rows[i].buchholz);
      }
      await amir.page.getByText("Round 2", { exact: false }).first().waitFor();
      expect(await fitsScreen(amir.page)).toBeLessThanOrEqual(0);
    });

    // A first-round scoresheet turns out wrong while round 2 has no result: the pairings may be made again.
    const firstRound = (d: Detail) => rounds(d, 1).filter((m) => m.status === "done");
    const flip = async (matchId: number, d: Detail): Promise<void> => {
      const m = d.matches.find((x) => x.id === matchId)!;
      const row = staffRow(page, nameOf(d, m.a), nameOf(d, m.b)).filter({ hasText: "✓" }).first();
      const other = m.winner === m.a ? m.b! : m.a!;
      await row.getByPlaceholder("21-15, 18-21, 21-10").fill(straightWin(m, other, ["21-17", "21-19"]));
      await row.getByRole("button", { name: `${firstName(nameOf(d, other))} won`, exact: true }).click();
    };
    const review = () => page.getByRole("region", { name: "Correction" });

    await s.step(organiser, "puts a first-round result right while round 2 has no result: reviewed, and the review offers to keep the pairings or pair again", async () => {
      const d = await staffDetail(organiser, id);
      await flip(firstRound(d)[0].id, d);
      await review().getByRole("heading", { name: /^The knockout has begun: review this correction/ }).waitFor();
      await review().getByRole("button", { name: "Pair the next round again" }).waitFor();
      await review().getByRole("button", { name: "Keep the pairings" }).waitFor();
      // With a reason given, both ways can be taken.
      await review().getByLabel("Why (kept with the correction)").fill("Referee's scoresheet: the first match went the other way");
      expect(await review().getByRole("button", { name: "Pair the next round again" }).isEnabled()).toBe(true);
      expect(await review().getByRole("button", { name: "Keep the pairings" }).isEnabled()).toBe(true);
      // Nothing has changed yet.
      expect((await staffDetail(organiser, id)).matches.find((m) => m.id === firstRound(d)[0].id)!.winner).toBe(firstRound(d)[0].winner);
    });

    await s.step(organiser, "pairs round 2 again from the corrected standings, with a reason: the pairings are replaced and no rule is broken", async () => {
      await review().getByLabel("Why (kept with the correction)").fill("Referee's scoresheet: the first match went the other way");
      await review().getByRole("button", { name: "Pair the next round again" }).click();
      await page.getByRole("heading", { name: "What that changed" }).waitFor();
      await swissPanel().getByText("2 of 3 rounds paired").waitFor();
      await page.getByText("is taken off: the round is paired again.", { exact: false }).first().waitFor();
      const d = await staffDetail(organiser, id);
      expect(d.corrections).toHaveLength(1);
      const met = new Set(rounds(d, 1).filter((m) => m.status !== "bye").map(pairKey));
      const second = rounds(d, 2).filter((m) => m.status === "scheduled" && m.a !== null);
      expect(second).toHaveLength(2);
      for (const m of second) expect(met.has(pairKey(m)), "no rematch after pairing again").toBe(false);
      expect(rounds(d, 2).filter((m) => m.status === "bye")).toHaveLength(1);
    });

    await s.step(organiser, "enters one match of round 2", async () => {
      expect(await playNext(organiser, id, (m) => m.a!, (m) => m.round === 2)).toBeDefined();
    });

    await s.step(organiser, "puts the other first-round result right now that round 2 has a result: pairing again is refused with the reason, and the pairings are kept", async () => {
      const before = await staffDetail(organiser, id);
      const second = rounds(before, 2).map((m) => `${m.id}:${m.a}:${m.b}`);
      const target = firstRound(before)[1];
      await flip(target.id, before);
      await review().getByRole("heading", { name: /^The knockout has begun: review this correction/ }).waitFor();
      expect(await review().getByRole("button", { name: "Pair the next round again" }).isDisabled()).toBe(true);
      await review().getByText("Not safely: settle these by hand first", { exact: false }).waitFor();
      await review().getByLabel("Why (kept with the correction)").fill("Referee's scoresheet: the second match went the other way");
      await review().getByRole("button", { name: "Keep the pairings" }).click();
      await page.getByRole("heading", { name: "What that changed" }).waitFor();
      const after = await staffDetail(organiser, id);
      expect(rounds(after, 2).map((m) => `${m.id}:${m.a}:${m.b}`)).toEqual(second);
      expect(after.corrections).toHaveLength(2);
      expect(after.matches.find((m) => m.id === target.id)!.winner).not.toBe(target.winner);
    });

    await s.step(organiser, "closes round 2 with the other match undecided: neither came; round 3 is paired, and nobody meets anybody again", async () => {
      await swissPanel().locator("summary").filter({ hasText: "Close round 2" }).click();
      const d = await staffDetail(organiser, id);
      const open = rounds(d, 2).find((m) => m.status === "scheduled")!;
      await swissPanel().getByLabel(`What happens to ${nameOf(d, open.a)} v ${nameOf(d, open.b)}`).selectOption({ label: "Neither came" });
      await swissPanel().getByRole("button", { name: "Close round 2" }).click();
      await swissPanel().getByText("3 of 3 rounds paired").waitFor();
      const after = await staffDetail(organiser, id);
      // Neither of the two came, and they count as having met.
      const met = new Set([...rounds(after, 1), ...rounds(after, 2)].filter((m) => m.status !== "bye" || m.b !== null).map(pairKey));
      const third = rounds(after, 3).filter((m) => m.status === "scheduled");
      expect(third).toHaveLength(2);
      for (const m of third) expect(met.has(pairKey(m)), `${nameOf(after, m.a)} v ${nameOf(after, m.b)} have met`).toBe(false);
      const byes = [...rounds(after, 1), ...rounds(after, 2), ...rounds(after, 3)].filter((m) => m.status === "bye" && m.b === null).map((m) => m.a);
      expect(new Set(byes).size, "nobody has two byes").toBe(byes.length);
    });

    await s.step(organiser, "enters round 3: the event finishes, and its standings are final", async () => {
      for (let n = 0; n < 2; n++) expect(await playNext(organiser, id, (m) => m.a!, (m) => m.round === 3)).toBeDefined();
      await page.getByRole("heading", { name: new RegExp(`${name} · finished`) }).waitFor();
    });

    await s.step(amir, "reads the final standings on his phone: three rounds, the winner, the tie-breaks that ranked them", async () => {
      await amir.page.reload();
      const d = await publicDetail(id);
      await amir.page.getByRole("heading", { name: "Standings after 3 of 3 rounds" }).waitFor();
      const champion = nameOf(d, d.swiss!.standings.find((l) => l.rank === 1)!.entryId);
      await amir.page.getByText(`Winner: ${champion}`).waitFor();
      const rows = await tableRows(amir.page, "Standings after");
      expect(rows.map((r) => r.name)).toContain(champion);
      for (let i = 1; i < rows.length; i++) expect(rows[i - 1].points).toBeGreaterThanOrEqual(rows[i].points);
      await amir.page.getByText("A result was corrected after the knockout began, by the organiser.").waitFor();
      expect(await fitsScreen(amir.page)).toBeLessThanOrEqual(0);
    });
    await drainOutbox(organiser, venue.venueId);
  });
});

/** The public Swiss table's rows: name, points and Buchholz, in the order shown. */
async function tableRows(page: Page, heading: string): Promise<{ name: string; points: number; buchholz: number }[]> {
  const table = page.locator("div").filter({ has: page.getByRole("heading", { name: new RegExp(`^${heading}`) }) }).locator("table").first();
  await table.waitFor();
  return table.locator("tbody tr").evaluateAll((trs) =>
    trs.map((tr) => {
      const cells = Array.from(tr.querySelectorAll("td")).map((td) => td.textContent ?? "");
      return { name: cells[1].replace(/\(.*\)/, "").trim(), points: Number(cells[cells.length - 2]), buchholz: Number(cells[cells.length - 1]) };
    })
  );
}
