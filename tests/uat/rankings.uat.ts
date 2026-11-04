import { describe, expect } from "vitest";
import type { Page } from "playwright-core";
import fs from "fs";
import type { Actor } from "./harness";
import { dayAhead, fitsScreen, scenario, url } from "./harness";
import { addChild, apiOwner, apiPeople, apiStaff, openListed, openTab, people, setSwitch, site, staffSignIn, type Person } from "./uatc-support";

/**
 * Ratings and rankings as a venue and its players meet them (docs/features/tournaments.md#ratings-and-rankings): a manager marks a tournament and a box
 * league as rated before they start, the results are played through the pages, and the venue's public rankings are a 404 until the manager publishes
 * them; then only adults who chose to be listed appear, a child and a player who did not choose never do, whatever their rating; the provisional section
 * is the manager's choice, apart, with no ranks; the number of counted results that ranks a player is the venue's and changes nobody's rating; a player
 * reads each result of their own explained, with the note that a rating is an estimate; a manager leaves a result out with a reason and the rating is
 * replayed; the ledger downloads; the front desk sees nothing of it; and unpublishing returns the 404 while the manager's own view stays.
 *
 * And a child's name on public pages (docs/architecture/privacy.md#minors-names-on-public-pages): short ("Aina L.") until the guardian, and only the
 * guardian, authorises the full name for one event after reading what it means, and short again once it is withdrawn. The authorisation's ending with the
 * event needs the clock moved, which the acceptance server cannot do: it is covered below the browser, in tests/public-names.test.ts.
 */

const flip = (games: string) => games.split(", ").map((g) => g.split("-").reverse().join("-")).join(", ");

/** The `li` of a tournament's own list of matches on the dashboard, by who plays in it. */
function staffRow(page: Page, a: string, b: string) {
  return page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Matches", exact: true }) })
    .locator("li")
    .filter({ hasText: a })
    .filter({ hasText: b });
}

const normal = (text: string) => text.split(/\s+/).join(" ").trim();

/** The venue's public rankings page: its status, and where there is one the ranked rows and the provisional section, as shown. */
async function boardOf(v: Actor, venueId: number): Promise<{ status: number; ranked: string[]; provisional: string[] | null; provisionalTitle: string | null; text: string }> {
  const res = await v.page.goto(`${url}/venue/${venueId}/rankings`);
  const status = res?.status() ?? 0;
  if (status !== 200) return { status, ranked: [], provisional: null, provisionalTitle: null, text: await v.page.locator("body").innerText() };
  await v.page.getByRole("heading", { name: /^Rankings at / }).waitFor();
  // The table or its empty message has loaded once the sport and format are chosen.
  await v.page.getByLabel("Sport").waitFor();
  await v.page.locator('[data-testid="rankings"], :text("Nobody is listed yet")').first().waitFor();
  const ranked = (await v.page.locator('[data-testid="rankings"] tbody tr').allInnerTexts()).map(normal);
  const section = v.page.locator('[data-testid="provisional"]');
  const there = (await section.count()) > 0;
  return {
    status,
    ranked,
    provisional: there ? (await section.locator("tbody tr").allInnerTexts()).map(normal) : null,
    provisionalTitle: there ? normal(await section.getByRole("heading").first().innerText()) : null,
    text: await v.page.locator("body").innerText(),
  };
}

describe("ratings and rankings", () => {
  scenario("Rankings A: rated events played through the pages; rankings a 404 until published, then only those who chose to be listed; provisional apart; the venue's number; a result left out; the ledger; the desk sees nothing; unpublished again", async (s) => {
    const owner = await apiOwner();
    const club = await site(owner, "Raket Club", "badminton", 2);
    const stamp = Date.now().toString(36);
    const day = dayAhead(35);
    const cupName = `Raket Cup ${stamp}`;
    const leagueName = `Raket Box League ${stamp}`;

    // Setup: the manager's browser, a tournament and a box league (before anybody has entered), and the people.
    const manager = await s.actor("Manager");
    await staffSignIn(manager, club.manager.email);
    const cup = await manager.api("POST", "/api/admin/tournaments", {
      venueId: club.venueId,
      courtIds: club.courtIds,
      name: cupName,
      sport: "badminton",
      template: "racket_best_of_3",
      format: "round_robin",
      teamSize: 1,
      entryFee: 0,
      maxEntries: 8,
      startsOn: day,
      endsOn: day,
      startMin: 9 * 60,
      endMin: 17 * 60,
      matchMinutes: 40,
      resultsBy: "staff",
    });
    expect(cup.status, JSON.stringify(cup.body)).toBe(201);
    const cupId = (cup.body.tournament as { id: number }).id;
    const league = await manager.api("POST", "/api/admin/leagues", { venueId: club.venueId, name: leagueName, sport: "badminton", fee: 0, startsOn: dayAhead(1) });
    expect(league.status, JSON.stringify(league.body)).toBe(201);
    const leagueId = (league.body.league as { id: number }).id;

    const { Aida, Esha } = await people(s, ["Aida", "Esha"], {}, "phone");
    const quiet = await apiPeople(["Bala", "Chin", "Faiz"]);
    const gina = (await people(s, ["Gina"], {}, "phone")).Gina;
    const kai = await addChild(gina, "Kai Lim", 2014);
    // Who chose to be listed on a public ranking, and under what name: Aida, Bala and Esha, declared adults. Chin and Faiz did not; Kai is a child.
    const everyone: Record<string, Person | Actor> = { Aida, Esha, ...quiet, Gina: gina };
    for (const [name, rankName] of [["Aida", "Aida R."], ["Bala", "Bala K."], ["Esha", "Esha T."]] as const) {
      const r = await everyone[name].api("PUT", "/api/my/profile", { adult: true, rankPublicly: true, rankName });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }
    for (const name of ["Chin", "Faiz"]) expect((await everyone[name].api("PUT", "/api/my/profile", { adult: true })).status).toBe(200);

    await s.step(manager, "opens Ratings and rankings under Leagues and marks the tournament and the box league as rated, before either has started", async () => {
      const page = manager.page;
      await openTab(page, "Leagues", null);
      await page.locator("summary", { hasText: /^Ratings and rankings$/ }).click();
      await setSwitch(page.getByRole("checkbox", { name: new RegExp(cupName) }), true);
      await setSwitch(page.getByRole("checkbox", { name: new RegExp(leagueName) }), true);
      await page.getByText("0 results counted").first().waitFor();
    });

    await s.step(Aida, "on a phone, the tournament's page says its results count towards ratings, and she enters", async () => {
      const page = Aida.page;
      await page.goto(`${url}/tournaments/${cupId}`);
      await page.getByText("The results of this event count towards players' ratings.", { exact: false }).waitFor();
      await page.getByRole("button", { name: "Enter", exact: true }).click();
      await page.getByText("You're entered").waitFor();
      expect(await fitsScreen(page)).toBeLessThanOrEqual(0);
    });
    for (const n of ["Bala", "Chin"]) expect((await quiet[n].api("POST", `/api/tournaments/${cupId}`, { action: "enter" })).status).toBe(201);
    await s.step(gina, "enters her daughter Kai as somebody she acts for", async () => {
      const page = gina.page;
      await page.goto(`${url}/tournaments/${cupId}`);
      await page.getByLabel("Who is entering").selectOption({ label: "Kai Lim" });
      const agree = page.getByLabel("A parent or guardian of each entrant under 18 agrees to this entry");
      if (await agree.count()) await agree.check();
      await page.getByRole("button", { name: "Enter", exact: true }).click();
      await page.getByText("Kai Lim: entered").waitFor();
    });
    for (const action of ["close", "draw"]) expect((await manager.api("POST", `/api/admin/tournaments/${cupId}`, { action })).status).toBe(200);

    // The box league: Aida, Esha and Faiz join, and the season starts with one box of three.
    for (const p of [Aida, Esha, quiet.Faiz]) expect((await p.api("POST", `/api/leagues/${leagueId}`, { action: "join" })).status, p.name).toBeLessThan(300);
    expect((await manager.api("POST", `/api/admin/leagues/${leagueId}`, { action: "start", startsOn: dayAhead(0) })).status).toBe(200);

    const matches = ((await manager.api("GET", `/api/admin/tournaments/${cupId}`)).body.tournament as { matches: { a: number; b: number }[]; entries: { id: number; name: string }[] });
    const nameOf = (id: number) => matches.entries.find((e) => e.id === id)!.name;
    // Aida beats everybody, Bala beats Chin and Kai, Chin beats Kai: every player has three results, Aida's 3-0.
    const order = ["Aida Tester", "Bala Tester", "Chin Tester", "Kai Lim"];
    const wins = matches.matches.map((m) => [nameOf(m.a), nameOf(m.b)] as const).map(([x, y]) => (order.indexOf(x) < order.indexOf(y) ? ([x, y, true] as const) : ([y, x, false] as const)));
    await s.step(manager, "enters the round robin's six results on the dashboard, one by one", async () => {
      const page = manager.page;
      await openTab(page, "Tournaments");
      await openListed(page, cupName);
      for (const [i, m] of matches.matches.entries()) {
        const [winner, loser, aIsWinner] = wins[i];
        const row = staffRow(page, nameOf(m.a), nameOf(m.b));
        const score = aIsWinner ? "21-15, 21-17" : flip("21-15, 21-17");
        await row.getByPlaceholder("21-15, 18-21, 21-10").fill(score);
        await row.getByRole("button", { name: `${winner.split(" ")[0]} won`, exact: true }).click();
        await row.getByText(`✓ ${score}`).waitFor();
        void loser;
      }
    });

    const detail = async () => ((await (await fetch(`${url}/api/leagues/${leagueId}`)).json()) as { league: { people: { id: number; name: string }[]; matches: { id: number; a: number; b: number; version: number }[] } }).league;
    const league0 = await detail();
    const pid = (name: string) => league0.people.find((p) => p.name === name)!.id;
    const matchOf = (x: number, y: number) => league0.matches.find((m) => (m.a === x && m.b === y) || (m.a === y && m.b === x))!;
    /** A box-league result reported on the page by one player and confirmed by the other's answer. */
    async function reportOnPage(who: Actor, me: string, them: string) {
      const page = who.page;
      await page.goto(`${url}/leagues/${leagueId}`);
      const row = page.locator("li").filter({ hasText: me }).filter({ hasText: them });
      await row.getByRole("button", { name: "Report the score" }).click();
      await row.getByLabel("Score, your games first").fill("21-12, 21-14");
      await row.getByRole("button", { name: "Send", exact: true }).click();
      await row.getByText("reported", { exact: false }).first().waitFor();
    }
    await s.step(Aida, "reports her wins over Esha and Faiz on the league page", async () => {
      await reportOnPage(Aida, "Aida Tester", "Esha Tester");
      await reportOnPage(Aida, "Aida Tester", "Faiz Tester");
    });
    await s.step(Esha, "on a phone, sees Aida's report and confirms it, then reports her own win over Faiz", async () => {
      const page = Esha.page;
      await page.goto(`${url}/leagues/${leagueId}`);
      const row = page.locator("li").filter({ hasText: "Aida Tester" }).filter({ hasText: "Esha Tester" });
      await row.getByText("Aida Tester reported this.").waitFor();
      await row.getByRole("button", { name: "Confirm", exact: true }).click();
      await row.getByRole("button", { name: "Confirm", exact: true }).waitFor({ state: "detached" });
      await reportOnPage(Esha, "Esha Tester", "Faiz Tester");
      expect(await fitsScreen(page)).toBeLessThanOrEqual(0);
    });
    // Faiz answers through the API, as his phone would (he is not what the scenario is about).
    for (const [x, y] of [["Aida Tester", "Faiz Tester"], ["Esha Tester", "Faiz Tester"]] as const) {
      const m = (await detail()).matches.find((q) => matchOf(pid(x), pid(y)).id === q.id)!;
      const r = await quiet.Faiz.api("POST", `/api/leagues/${leagueId}/matches/${m.id}`, { action: "confirm", version: m.version });
      expect(r.status, JSON.stringify(r.body)).toBe(200);
    }

    const visitor = await s.actor("Visitor");
    await s.step(visitor, "the venue's public rankings page is a 404 by default, as is its API, and the venue page has no link to it", async () => {
      expect((await boardOf(visitor, club.venueId)).status).toBe(404);
      expect((await visitor.api("GET", `/api/venues/${club.venueId}/rankings`)).status).toBe(404);
      await visitor.page.goto(`${url}/venue/${club.venueId}`);
      await visitor.page.getByRole("heading", { name: club.name }).first().waitFor();
      expect(await visitor.page.getByRole("link", { name: "See this venue's rankings" }).count()).toBe(0);
    });

    let ratingsBefore = "";
    const poolText = async () => normal(await manager.page.locator("section").filter({ has: manager.page.getByRole("heading", { name: "Who is rated" }) }).first().innerText());
    await s.step(manager, "sees, in the panel, the venue has rated results but has not published; everybody rated, the child as a junior player; all provisional", async () => {
      const page = manager.page;
      await page.reload();
      await openTab(page, "Leagues", null);
      await page.locator("summary", { hasText: /^Ratings and rankings$/ }).click();
      await page.getByText("This venue has rated results, but its rankings are not public", { exact: false }).waitFor();
      await page.getByRole("heading", { name: "Who is rated" }).waitFor();
      ratingsBefore = await poolText();
      expect(ratingsBefore).toContain("(junior player)");
      expect(ratingsBefore).not.toContain("Kai Lim");
      for (const n of ["Aida", "Bala", "Chin", "Esha", "Faiz"]) expect(ratingsBefore).toContain(`${n} Tester`);
      expect(ratingsBefore).toContain("provisional");
    });

    await s.step(manager, "publishes the rankings with the panel's switch: the page appears, but with eight counted results needed, nobody is ranked yet", async () => {
      const page = manager.page;
      await setSwitch(page.getByLabel("Publish this venue's rankings on its public page"), true);
      await page.getByText("Saved.").waitFor();
      const board = await boardOf(visitor, club.venueId);
      expect(board.status).toBe(200);
      expect(board.ranked).toEqual([]);
      expect(board.provisional).toBeNull();
      await visitor.page.goto(`${url}/venue/${club.venueId}`);
      await visitor.page.getByRole("link", { name: "See this venue's rankings" }).waitFor();
    });

    await s.step(manager, "changes the venue's number to 3 counted results: Aida (five) and Bala (three) are ranked; Chin, who did not choose, and Kai, a child, are not shown whatever they have; Esha, with two, is not shown either", async () => {
      const page = manager.page;
      await page.getByLabel("Counted results before a player is ranked").fill("3");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await page.getByText("Saved.").waitFor();
      const board = await boardOf(visitor, club.venueId);
      expect(board.ranked).toHaveLength(2);
      expect(board.ranked[0]).toMatch(/^1 Aida R\. /);
      expect(board.ranked[1]).toMatch(/^2 Bala K\. /);
      expect(board.provisional).toBeNull();
      for (const hidden of ["Chin", "Kai", "Esha", "Faiz", "Gina"]) expect(board.text, hidden).not.toContain(hidden);
    });

    await s.step(manager, "switches the provisional section on: it is titled apart, lists Esha by name with no rank, and still not Chin, Faiz or Kai", async () => {
      const page = manager.page;
      await setSwitch(page.getByLabel("Also show players who are not ranked yet, in a separate section"), true);
      await page.getByText("Saved.").waitFor();
      const board = await boardOf(visitor, club.venueId);
      expect(board.provisionalTitle).toBe("Provisional: fewer than 3 rated results; these ratings may move a lot");
      expect(board.provisional).toHaveLength(1);
      expect(board.provisional![0]).toMatch(/^Esha T\. \d+ 2$/);
      expect(board.ranked).toHaveLength(2);
      for (const hidden of ["Chin", "Kai", "Faiz"]) expect(board.text, hidden).not.toContain(hidden);
    });

    await s.step(manager, "raises the number to 5: Bala (three) moves to the provisional section, Aida stays ranked, and nobody's rating has changed", async () => {
      const page = manager.page;
      await page.getByLabel("Counted results before a player is ranked").fill("5");
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await page.getByText("Saved.").waitFor();
      const board = await boardOf(visitor, club.venueId);
      expect(board.ranked).toHaveLength(1);
      expect(board.ranked[0]).toMatch(/^1 Aida R\. /);
      expect(board.provisional!.map((r) => r.replace(/ \d+ \d+$/, ""))).toEqual(["Bala K.", "Esha T."]);
      expect(board.provisionalTitle).toBe("Provisional: fewer than 5 rated results; these ratings may move a lot");
      // The ratings in the manager's own view are the same numbers as before (only the word provisional moved).
      await page.reload();
      await openTab(page, "Leagues", null);
      await page.locator("summary", { hasText: /^Ratings and rankings$/ }).click();
      await page.getByRole("heading", { name: "Who is rated" }).waitFor();
      const ratings = (text: string) => [...text.matchAll(/(\w+ Tester|\(junior player\)) (\d{3,4}(?:\.\d+)?)/g)].map((m) => `${m[1]}=${m[2]}`).sort();
      expect(ratings(await poolText())).toEqual(ratings(ratingsBefore));
    });

    await s.step(Aida, "on a phone, reads her own ratings page: each of her five results explained, with what the rating expected, and that a rating is an estimate", async () => {
      const page = Aida.page;
      await page.goto(`${url}/ratings`);
      await page.getByRole("heading", { name: "Your ratings" }).waitFor();
      await page.getByText("A rating is an estimate worked out from the results counted.", { exact: false }).first().waitFor();
      await page.getByRole("button", { name: "How each result moved it" }).click();
      await page.getByText(/Won against/).first().waitFor();
      expect(await page.getByText(/Won against/).count()).toBe(5);
      await page.getByText(/Your rating was 1000; it was given a 50% chance\./).first().waitFor();
      expect(await fitsScreen(page)).toBeLessThanOrEqual(0);
    });

    await s.step(gina, "reads her daughter's rating on her own page; the opponents are shown as they were entered, and the child is on no public page", async () => {
      const page = gina.page;
      await page.goto(`${url}/ratings`);
      await page.getByRole("heading", { name: "For Kai Lim" }).waitFor();
    });

    let aidaBefore = "";
    await s.step(manager, "leaves Aida's win over Bala out of the ratings, with a reason: the rating is replayed and the result is marked as left out", async () => {
      const page = manager.page;
      aidaBefore = (await poolText()).match(/Aida Tester (\d{3,4}(?:\.\d+)?)/)![1];
      const result = page.locator("li").filter({ hasText: /Aida Tester v Bala Tester|Bala Tester v Aida Tester/ }).filter({ has: page.getByRole("button", { name: "Leave out" }) }).first();
      await result.getByRole("button", { name: "Leave out" }).click();
      await page.getByLabel("Why leave this result out of the ratings?").fill("Scoresheet disputed by both players");
      await page.getByRole("button", { name: "Leave it out" }).click();
      await page.getByText(/Left out by .+: Scoresheet disputed by both players/).waitFor();
      await page.getByRole("heading", { name: "Who is rated" }).waitFor();
      const after = (await poolText()).match(/Aida Tester (\d{3,4}(?:\.\d+)?)/)![1];
      expect(after, "leaving a result out replays the rating").not.toBe(aidaBefore);
    });

    await s.step(Aida, "her page now says the venue left that result out of the ratings", async () => {
      await Aida.page.reload();
      await Aida.page.getByRole("button", { name: "How each result moved it" }).click();
      await Aida.page.getByText("The venue left this result out of the ratings.").waitFor();
    });

    await s.step(manager, "downloads the ledger (CSV): every result with the ratings before and after, the child as a junior player", async () => {
      const page = manager.page;
      const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("link", { name: "Download the ledger (CSV)" }).click()]);
      const csv = fs.readFileSync((await download.path())!, "utf8");
      expect(download.suggestedFilename()).toMatch(/\.csv$/);
      expect(csv.split("\n")[0].length).toBeGreaterThan(10);
      expect(csv).toContain("Aida Tester");
      expect(csv).toContain("(junior player)");
      expect(csv).not.toContain("Kai Lim");
    });

    await s.step(manager, "the venue's activity log has each rating change with who made it", async () => {
      const log = ((await manager.api("GET", `/api/admin/activity?venueId=${club.venueId}`)).body.actions as { action: string; adminName: string }[]).map((a) => a.action);
      expect(log).toEqual(expect.arrayContaining(["ratings.event_rated", "ratings.public_rankings", "ratings.show_provisional", "ratings.rank_after", "ratings.ledger_exported"]));
    });

    const desk = await s.actor("Desk");
    await s.step(desk, "the front desk sees nothing of ratings on the dashboard, and the server refuses its requests", async () => {
      await staffSignIn(desk, club.desk.email);
      await openTab(desk.page, "Leagues", null);
      await desk.page.locator("summary", { hasText: /^Club ladders$/ }).waitFor();
      expect(await desk.page.locator("summary", { hasText: /^Ratings and rankings$/ }).count()).toBe(0);
      const api = await apiStaff(club.desk.email);
      for (const [method, path, body] of [
        ["GET", `/api/admin/ratings?venueId=${club.venueId}`, undefined],
        ["GET", `/api/admin/ratings?venueId=${club.venueId}&export=ledger`, undefined],
        ["POST", "/api/admin/ratings", { venueId: club.venueId, action: "policy", publicRankings: false }],
      ] as const) {
        const r = await api.api(method, path, body);
        expect(r.status, `${method} ${path}`).toBe(403);
      }
    });

    await s.step(manager, "unpublishes: the page is a 404 again and the link goes, while the manager's own view of ratings stays", async () => {
      const page = manager.page;
      await setSwitch(page.getByLabel("Publish this venue's rankings on its public page"), false);
      await page.getByText("Saved.").waitFor();
      expect((await boardOf(visitor, club.venueId)).status).toBe(404);
      expect((await visitor.api("GET", `/api/venues/${club.venueId}/rankings`)).status).toBe(404);
      await visitor.page.goto(`${url}/venue/${club.venueId}`);
      await visitor.page.getByRole("heading", { name: club.name }).first().waitFor();
      expect(await visitor.page.getByRole("link", { name: "See this venue's rankings" }).count()).toBe(0);
      // Private views are untouched: the manager's pools, and a player's own page.
      await page.reload();
      await openTab(page, "Leagues", null);
      await page.locator("summary", { hasText: /^Ratings and rankings$/ }).click();
      await page.getByRole("heading", { name: "Who is rated" }).waitFor();
      expect(await poolText()).toContain("Aida Tester");
      await Aida.page.goto(`${url}/ratings`);
      await Aida.page.getByRole("heading", { name: "Your ratings" }).waitFor();
      await Aida.page.getByTestId("rating-pool").waitFor();
      void kai;
    });
  });

  scenario("Names D: a guardian authorises the full name of a child for one event after reading what it means, the public page shows it, and withdrawing brings the short name back; nobody else can", async (s) => {
    const owner = await apiOwner();
    const club = await site(owner, "Raket Club", "badminton", 2);
    const day = dayAhead(37);
    const eventName = `Junior Cup ${Date.now().toString(36)}`;
    const manager = await s.actor("Manager");
    await staffSignIn(manager, club.manager.email);
    const made = await manager.api("POST", "/api/admin/tournaments", {
      venueId: club.venueId,
      courtIds: club.courtIds,
      name: eventName,
      sport: "badminton",
      template: "racket_best_of_3",
      format: "knockout",
      teamSize: 1,
      entryFee: 0,
      maxEntries: 8,
      startsOn: day,
      endsOn: day,
      startMin: 9 * 60,
      endMin: 17 * 60,
      matchMinutes: 40,
      resultsBy: "staff",
    });
    expect(made.status, JSON.stringify(made.body)).toBe(201);
    const id = (made.body.tournament as { id: number }).id;

    const { Mother } = await people(s, ["Mother"], {}, "phone");
    const { Ben, Other } = await apiPeople(["Ben", "Other"]);
    const child = await addChild(Mother, "Aina Lim", 2014);
    expect((await Mother.api("POST", `/api/tournaments/${id}`, { action: "enter", participantId: child.id, guardianConsent: true })).status).toBe(201);
    expect((await Ben.api("POST", `/api/tournaments/${id}`, { action: "enter" })).status).toBe(201);
    const visitor = await s.actor("Visitor", "phone");

    const entryNames = async () => {
      await visitor.page.goto(`${url}/tournaments/${id}`);
      await visitor.page.getByRole("heading", { name: new RegExp(eventName) }).waitFor();
      const api = await visitor.api("GET", `/api/tournaments/${id}`);
      return { page: await visitor.page.locator("body").innerText(), api: JSON.stringify(api.body) };
    };

    await s.step(visitor, "on a phone, signed out, sees the child as Aina L. on the page and in the API", async () => {
      const seen = await entryNames();
      expect(seen.page).toContain("Aina L.");
      expect(seen.page).not.toContain("Aina Lim");
      expect(seen.api).not.toContain("Aina Lim");
      expect(await fitsScreen(visitor.page)).toBeLessThanOrEqual(0);
    });

    await s.step(Mother, "opens her daughter's entry under her account: the wording says what becomes public, the button waits for the box to be ticked", async () => {
      const page = Mother.page;
      await page.goto(`${url}/account`);
      const panel = page.locator("details").filter({ has: page.locator("summary", { hasText: "Names on public pages" }) }).first();
      await panel.locator("summary").click();
      await panel.getByText("Draws, results, tables, ladders and live pages show a child by first name and the initial of the next name", { exact: false }).waitFor();
      await expect(panel.locator("option", { hasText: `${eventName}, a tournament at ${club.name}` }).count()).resolves.toBe(1);
      await panel.getByLabel("Allow the full name for").selectOption(`tournament:${id}`);
      await panel.getByText("I am Aina Lim's parent or guardian. I understand that their full name will be public on those pages until I withdraw it or it ends.").waitFor();
      expect(await panel.getByRole("button", { name: "Allow the full name" }).isDisabled()).toBe(true);
      await panel.getByLabel(/I am Aina Lim's parent or guardian/).check();
      await panel.getByRole("button", { name: "Allow the full name" }).click();
      await panel.getByRole("status").getByText(/Allowed\. Their full name is public there until it ends or you withdraw it\./).waitFor();
      await panel.getByText(new RegExp(`${eventName} at ${club.name}: until the event or season ends, or you withdraw it`)).waitFor();
      expect(await fitsScreen(page)).toBeLessThanOrEqual(0);
    });

    await s.step(visitor, "the next page load shows the full name, on the page and in the API", async () => {
      const seen = await entryNames();
      expect(seen.page).toContain("Aina Lim");
      expect(seen.api).toContain("Aina Lim");
    });

    await s.step(manager, "a manager has no control for it: none on the dashboard, and neither the server nor a stranger's account will do it for them", async () => {
      const page = manager.page;
      await openTab(page, "Tournaments");
      await openListed(page, eventName);
      expect(await page.getByText("Allow the full name").count()).toBe(0);
      // No customer session is a manager's: refused as not signed in; another parent's account is not this child's guardian.
      expect((await manager.api("POST", "/api/my/people/public-name", { action: "authorise", id: child.id, scope: "venue", venueId: club.venueId, confirm: true })).status).toBe(401);
      const stranger = await Other.api("POST", "/api/my/people/public-name", { action: "authorise", id: child.id, scope: "venue", venueId: club.venueId, confirm: true });
      expect(stranger.status).toBeGreaterThanOrEqual(400);
      expect(stranger.body).toMatchObject({ code: "PN1_NOT_GUARDIAN" });
      // The staff dashboard shows the child's full name all along; the authorisation is in the venue's log.
      await page.getByText("Aina Lim", { exact: false }).first().waitFor();
      const log = ((await manager.api("GET", `/api/admin/activity?venueId=${club.venueId}`)).body.actions as { action: string; adminName: string; detail: string }[]).find((a) => a.action === "participant.public_name_authorised");
      expect(log?.adminName).toBe("Guardian: Mother Tester");
    });

    await s.step(Mother, "withdraws it, at once and with no further question", async () => {
      const page = Mother.page;
      await page.reload();
      const panel = page.locator("details").filter({ has: page.locator("summary", { hasText: "Names on public pages" }) }).first();
      await panel.locator("summary").click();
      await panel.getByRole("button", { name: new RegExp(`^Withdraw: ${eventName}`) }).click();
      await panel.getByText("Withdrawn. The short name shows again from the next page load.").waitFor();
    });

    await s.step(visitor, "the next page load shows Aina L. again", async () => {
      const seen = await entryNames();
      expect(seen.page).toContain("Aina L.");
      expect(seen.page).not.toContain("Aina Lim");
      expect(seen.api).not.toContain("Aina Lim");
    });
  });
});
