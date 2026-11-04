import { describe, expect, inject } from "vitest";
import type { Locator, Page } from "playwright-core";
import { fitsScreen, scenario, signInOwner, url, type Actor, type Scenario } from "./harness";
import {
  adult,
  boardCells,
  clubVenue,
  dayOffset,
  emailed,
  enterLeague,
  makeFixtures,
  makeTeam,
  openLeaguesOfTeams,
  publicLeague,
  setUpLeague,
  staffApi,
  staffOnLeagues,
  startsOn,
  type LeagueFixture,
  type LeagueView,
  type MyTeam,
} from "./teams-support";

/**
 * Leagues of teams (docs/features/tournaments.md#team-leagues), run by a club and played by teams whose captains are on their
 * phones, each person in a browser of their own:
 *
 * - **Team league 1**: a manager sets a season up on the dashboard from the badminton template; three captains enter their
 *   teams (one gives a date it cannot play, one a home court); the manager gives the match nights and makes the fixture list,
 *   home and away with a bye each night; each fixture holds its court (the club's own booking page shows it taken); captains
 *   pick lineups (each side's own, until a result is in), one reports each game and the other confirms, and the table and the
 *   public page follow, naming teams and never a player; a manager moves a fixture, and the front desk can neither see the
 *   button nor do it.
 * - **Team league 2**: a reported result disputed, and settled by the front desk.
 * - **Team league 3**: forfeit requests: a captain asks, nothing changes; the front desk sees it and cannot confirm it; the
 *   manager confirms it (table, the fixture and its court hold) or declines a second with a reason, and the captains are told.
 *
 * Today's fixtures are the ones that can be reported (a result is reported from the fixture's date), so every league's first
 * match night is today; the other nights are weeks on. Each scenario has a club of its own, with its own courts. The scores,
 * ages and categories are the entrants' word, as always.
 */

const RUN = Date.now().toString(36);

interface Squad {
  name: string;
  captain: Actor;
  players: Actor[];
  team: MyTeam;
  /** The captain's and the players' first names, as a roster shows them. */
  people: string[];
}

/** Teams of adults, made the way the pages make them through the API (Teams 1 is where they are made on the pages). */
async function squads(s: Scenario, specs: { name: string; captain: string; players: string[] }[]): Promise<Squad[]> {
  const out: Squad[] = [];
  for (const spec of specs) {
    const captain = await adult(s, spec.captain, "phone");
    const players: Actor[] = [];
    for (const p of spec.players) players.push(await adult(s, p, "phone"));
    out.push({ name: spec.name, captain, players, team: await makeTeam(captain, spec.name, players), people: [spec.captain, ...spec.players] });
  }
  return out;
}

const THREE = (label: string) => [
  { name: `Smash Seksyen 7 ${label}`, captain: "Anwar", players: ["Amirul", "Azrin"] },
  { name: `Shuttle Kota Kemuning ${label}`, captain: "Bakri", players: ["Badrul", "Basyir"] },
  { name: `Raket Puchong ${label}`, captain: "Chong", players: ["Chandran"] },
];

/** Nobody is named but by team: no word of the page or the data is one of these people's names. */
function namesNone(text: string, names: string[]) {
  for (const n of names) expect(text, `${n} is named`).not.toMatch(new RegExp(`\\b${n}\\b`));
}

const said = (page: Page) => page.locator("body").innerText();

/** A day's section of the dashboard's fixture list. */
const night = (panel: Locator, date: string) => panel.locator("section").filter({ has: panel.page().getByRole("heading", { name: date, exact: true }) });

/** A fixture's row on the league page for captains and the public. */
const fixtureRow = (page: Page, home: string, away: string) => page.locator("li").filter({ hasText: `${home} v ${away}` }).first();

/** The league table on the public page, as rows of cells. */
async function tableOf(page: Page): Promise<Record<string, string[]>> {
  const table = page.locator("section").filter({ has: page.getByRole("heading", { name: "Table", exact: true }) });
  await table.waitFor();
  const rows = await table.locator("tbody tr").evaluateAll((trs) => trs.map((tr) => Array.from(tr.querySelectorAll("td")).map((td) => (td.textContent ?? "").trim())));
  return Object.fromEntries(rows.map((r) => [r[1].replace(/ \(withdrew\)$/, ""), r]));
}

/** The fixtures that matter as the public sees them: who, when, where, and in what state. */
const shape = (l: LeagueView) => l.fixtures.map((f) => `${f.id} ${f.date} ${f.startMin} ${f.courtId} ${f.home.name} v ${f.away.name} ${f.status}`);

describe.skipIf(!inject("uatServerLog"))("team leagues", () => {
  scenario("Team league 1: a manager sets a season up, three teams enter, fixtures hold courts, a result is reported and confirmed, the public sees teams and never players", async (s) => {
    const owner = await signInOwner(await s.actor("Platform"));
    const club = await clubVenue(owner, "Kelab Badminton Seksyen 7", 2);
    const [anwar, bakri, chong] = await squads(s, THREE(RUN));
    const everyone = [anwar, bakri, chong].flatMap((q) => q.people);
    const today = dayOffset(0);
    const leagueName = `Liga Seksyen 7 ${RUN}`;
    const manager = await s.actor("Manager");

    await s.step(manager, "signs in to the dashboard and sets up a league of teams from the badminton template: home and away, on both courts", async () => {
      await staffOnLeagues(manager, club.manager.email);
      const panel = await openLeaguesOfTeams(manager.page);
      await panel.getByText("No leagues of teams yet.").waitFor();
      const form = panel.locator("form").filter({ has: manager.page.getByRole("heading", { name: "Set up a league of teams" }) });
      await form.getByLabel("Name", { exact: true }).fill(leagueName);
      await form.getByLabel("Meetings").selectOption("2");
      await form.getByLabel("Season starts").fill(today);
      await form.getByLabel("Season ends").fill(dayOffset(120));
      await form.getByRole("checkbox", { name: "Court 1" }).check();
      await form.getByRole("checkbox", { name: "Court 2" }).check();
      // The sport's template says what a team match is made of, as data.
      await form.getByText(/A team match is singles 1, doubles 1, singles 2; \d+ minutes are held for each game\./).waitFor();
      await form.getByRole("button", { name: "Set up the league" }).click();
      await panel.locator("li").filter({ hasText: leagueName }).getByText("taking teams").waitFor();
    });
    const leagueId = ((await manager.api("GET", `/api/admin/team-leagues?venueId=${club.venueId}`)).body.leagues as { id: number; name: string }[]).find((l) => l.name === leagueName)!.id;
    const leaguePage = `${url}/team-leagues/${leagueId}`;

    const enter = async (q: Squad, extra: (form: Locator) => Promise<void> = async () => undefined) =>
      s.step(q.captain, `enters ${q.name} on their phone, picking who is on the roster`, async () => {
        const page = q.captain.page;
        await page.goto(leaguePage);
        await page.getByRole("heading", { name: leagueName }).waitFor();
        const form = page.locator("form").filter({ has: page.getByRole("heading", { name: "Enter a team you captain" }) });
        await form.getByRole("heading", { name: "Enter a team you captain" }).waitFor();
        for (const n of q.people) await form.getByLabel(n, { exact: true }).check();
        await extra(form);
        expect(await fitsScreen(page)).toBeLessThanOrEqual(0);
        await form.getByRole("button", { name: "Enter the team" }).click();
        await page.getByRole("heading", { name: `Your team: ${q.name}` }).waitFor();
      });
    await enter(anwar);
    await enter(bakri, async (form) => {
      // Bakri's team cannot play on the first night: today.
      await form.locator('textarea[name="blackouts"]').fill(today);
    });
    await enter(chong, async (form) => {
      await form.locator('select[name="homeCourt"]').selectOption({ label: "Court 2" });
    });

    const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
    await s.step(manager, "opens the league, sees the three teams with what they asked, gives the match nights and makes the fixture list", async () => {
      const panel = await openLeaguesOfTeams(manager.page);
      await panel.locator("li").filter({ hasText: leagueName }).getByRole("button", { name: "Open", exact: true }).click();
      await panel.getByRole("heading", { name: "Teams (3 of 12)" }).waitFor();
      await panel.locator("li").filter({ hasText: bakri.name }).getByText(`cannot play ${today}`).waitFor();
      await panel.locator("li").filter({ hasText: chong.name }).getByText("home court Court 2").waitFor();
      await panel.getByLabel("Weekday").selectOption(String(weekday));
      await panel.getByLabel("How many nights").fill("8");
      await panel.getByRole("button", { name: "Fill the nights" }).click();
      await panel.getByLabel("Night 8: date").waitFor();
      await panel.getByRole("button", { name: "Make the fixture list", exact: true }).click();
      await panel.getByText(/fixtures made/).first().waitFor();
      // Home and away among three teams: six fixtures, one a night, nobody twice in a night.
      await night(panel, today).locator("li").first().waitFor();
    });

    const league = await publicLeague(leagueId);
    await s.step(manager, "finds the list as it should be: every ordered pair once, none on a date a team gave away, Chong's home games on their court", async () => {
      expect(league.fixtures).toHaveLength(6);
      const pairs = league.fixtures.map((f) => `${f.home.name} > ${f.away.name}`);
      expect(new Set(pairs).size).toBe(6);
      const first = league.fixtures.filter((f) => f.date === today);
      expect(first).toHaveLength(1);
      expect([first[0].home.name, first[0].away.name].sort()).toEqual([anwar.name, chong.name].sort());
      for (const f of league.fixtures.filter((x) => x.home.name === chong.name)) expect(f.courtName).toBe("Court 2");
      // A fixture is listed on the dashboard with its court and time; its date's section names it.
      const panel = await openLeaguesOfTeams(manager.page);
      await night(panel, today).locator("li").filter({ hasText: `${first[0].home.name} v ${first[0].away.name}` }).getByText(/7:00 PM · Court \d · to play/).waitFor();
    });

    const todays = league.fixtures.find((f) => f.date === today)!;
    const later = league.fixtures.find((f) => f.date > today)!;
    const customer = await s.actor("Customer");
    await s.step(customer, "looks at the club's booking page for the second night: the league's court is taken for its games, the other court and the hour before are free", async () => {
      const mine = await boardCells(customer.page, club.venueId, later.date, later.courtName!);
      const other = league.courts.find((c) => c.id !== later.courtId)!;
      const elsewhere = await boardCells(customer.page, club.venueId, later.date, other.name);
      expect(mine.taken, "the league's court").toContain(later.startMin);
      // Every hour of the grid the games' minutes touch is taken, and no other.
      const touched = [...mine.taken, ...mine.free].filter((m) => m < later.startMin + later.minutes && m + 60 > later.startMin);
      expect(touched.length).toBeGreaterThanOrEqual(2);
      for (const m of touched) expect(mine.taken, `${m / 60}:00 is taken`).toContain(m);
      expect(mine.taken.filter((m) => !touched.includes(m))).toEqual([]);
      expect(mine.free, "the hour before").toContain(later.startMin - 60);
      expect(elsewhere.free).toContain(later.startMin);
      expect(elsewhere.taken).toEqual([]);
      expect(await startsOn(club.venueId, later.date, later.courtId!)).not.toContain(later.startMin);
      const refused = await customer.api("POST", "/api/bookings", { courtId: later.courtId, date: later.date, hours: [later.startMin / 60], name: "Customer Tester", phone: customer.phone });
      expect(refused.status).toBeGreaterThanOrEqual(400);
    });

    const bySide = (f: LeagueFixture) => {
      const home = [anwar, bakri, chong].find((q) => q.name === f.home.name)!;
      const away = [anwar, bakri, chong].find((q) => q.name === f.away.name)!;
      return { home, away };
    };
    const { home, away } = bySide(todays);
    const lineup = async (q: Squad, side: "home" | "away") =>
      s.step(q.captain, `picks the ${side} lineup from the roster: nobody over two games`, async () => {
        const page = q.captain.page;
        await page.goto(leaguePage);
        const row = fixtureRow(page, todays.home.name, todays.away.name);
        await row.waitFor();
        await row.getByRole("button", { name: "Games and lineup" }).click();
        const [first, second, third] = q.people;
        await row.getByLabel("Singles 1 1", { exact: true }).selectOption({ label: first });
        await row.getByLabel("Doubles 1 1", { exact: true }).selectOption({ label: second });
        await row.getByLabel("Doubles 1 2", { exact: true }).selectOption({ label: third ?? first });
        await row.getByLabel("Singles 2 1", { exact: true }).selectOption({ label: second });
        await row.getByRole("button", { name: "Save the lineup" }).click();
        await row.getByText(new RegExp(`${q.name}: ${first}`)).waitFor();
      });
    await lineup(home, "home");
    await s.step(away.captain, "opens the fixture: their own side is theirs to pick, the other side's players are not shown yet", async () => {
      const page = away.captain.page;
      await page.goto(leaguePage);
      const row = fixtureRow(page, todays.home.name, todays.away.name);
      await row.getByRole("button", { name: "Games and lineup" }).click();
      await row.getByRole("button", { name: "Save the lineup" }).waitFor();
      namesNone(await row.innerText(), home.people);
      expect(await fitsScreen(page)).toBeLessThanOrEqual(0);
    });
    await lineup(away, "away");

    await s.step(home.captain, "reports each game, the home side's score first: wins both singles, loses the doubles", async () => {
      const page = home.captain.page;
      await page.goto(leaguePage);
      const row = fixtureRow(page, todays.home.name, todays.away.name);
      await row.getByRole("button", { name: "Report the result" }).click();
      await row.getByLabel("Singles 1: Winner").selectOption({ label: home.name });
      await row.getByLabel("Singles 1: Score").fill("21-15, 21-17");
      await row.getByLabel("Doubles 1: Winner").selectOption({ label: away.name });
      await row.getByLabel("Doubles 1: Score").fill("19-21, 18-21");
      await row.getByLabel("Singles 2: Winner").selectOption({ label: home.name });
      await row.getByLabel("Singles 2: Score").fill("21-12, 21-9");
      await row.getByRole("button", { name: "Send the result" }).click();
      await row.getByText("Reported, waiting for the other captain").waitFor();
      expect(await fitsScreen(page)).toBeLessThanOrEqual(0);
    });
    await s.step(away.captain, "is emailed, opens the league and confirms what was reported", async () => {
      await emailed(manager, club.venueId, away.captain.email, new RegExp(`^${home.name} reported a result$`));
      const page = away.captain.page;
      await page.goto(leaguePage);
      await page.getByText(new RegExp(`${home.name} reported this result\\. Confirm it, or say it is wrong`)).waitFor();
      await page.getByRole("button", { name: "Confirm", exact: true }).click();
      const row = fixtureRow(page, todays.home.name, todays.away.name);
      await row.getByText(/Played/).waitFor();
      await row.getByText("2-1").waitFor();
    });
    await s.step(home.captain, "is told it was confirmed, and sees both lineups now that a result is in", async () => {
      await emailed(manager, club.venueId, home.captain.email, new RegExp(`^${away.name} confirmed your result$`));
      const page = home.captain.page;
      await page.goto(leaguePage);
      const row = fixtureRow(page, todays.home.name, todays.away.name);
      await row.getByRole("button", { name: "Games and lineup" }).click();
      await row.getByText(new RegExp(`${away.name}: ${away.people[0]}`)).waitFor();
      await row.getByText(new RegExp(`${home.name}: ${home.people[0]}`)).waitFor();
    });

    const visitor = await s.actor("Visitor", "phone");
    await s.step(visitor, "opens the league without an account: teams, fixtures, the result and the table, no player", async () => {
      await visitor.page.goto(leaguePage);
      await visitor.page.getByRole("heading", { name: leagueName }).waitFor();
      const table = await tableOf(visitor.page);
      // P W D L For Against Pts
      expect(table[home.name].slice(2)).toEqual(["1", "1", "0", "0", "2", "1", "3"]);
      expect(table[away.name].slice(2)).toEqual(["1", "0", "0", "1", "1", "2", "0"]);
      expect(table[bakri.name].slice(2)).toEqual(["0", "0", "0", "0", "0", "0", "0"]);
      const row = fixtureRow(visitor.page, todays.home.name, todays.away.name);
      await row.getByText("2-1").waitFor();
      // The team that cannot play on the first night is the one resting on it, as the page says.
      await visitor.page.getByText(`Not playing: ${bakri.name}`).first().waitFor();
      const text = await said(visitor.page);
      namesNone(text, everyone);
      expect(text).not.toMatch(/Tester/);
      const api = JSON.stringify((await visitor.api("GET", `/api/team-leagues/${leagueId}`)).body);
      namesNone(api, everyone);
      for (const hidden of ['"roster"', '"lineup"', '"blackouts"']) expect(api).not.toContain(hidden);
      expect(await fitsScreen(visitor.page)).toBeLessThanOrEqual(0);
    });

    const desk = await s.actor("Desk");
    await s.step(desk, "the front desk sees the fixtures but not the buttons that move one or give a forfeit, and not the set-up", async () => {
      await staffOnLeagues(desk, club.desk.email);
      const panel = await openLeaguesOfTeams(desk.page);
      await panel.locator("li").filter({ hasText: leagueName }).getByRole("button", { name: "Open", exact: true }).click();
      await panel.getByRole("heading", { name: "Teams (3 of 12)" }).waitFor();
      const row = night(panel, later.date).locator("li").filter({ hasText: `${later.home.name} v ${later.away.name}` });
      await row.getByRole("button", { name: "Enter the result" }).waitFor();
      expect(await row.getByRole("button", { name: /^Move/ }).count()).toBe(0);
      expect(await row.getByRole("button", { name: /^Forfeit by/ }).count()).toBe(0);
      // What only a manager changes is shown read-only, under a line that says so, and without its buttons.
      await panel.getByText("A manager changes this.").first().waitFor();
      expect(await panel.locator("fieldset[disabled]").filter({ has: desk.page.getByRole("heading", { name: "Match nights" }) }).count()).toBe(1);
      expect(await panel.getByRole("button", { name: /Make the fixture list/ }).isVisible()).toBe(false);
      expect(await panel.getByRole("button", { name: "Stop the league" }).isVisible()).toBe(false);
    });
    await s.step(desk, "and the server refuses it however it is asked", async () => {
      const before = shape(await publicLeague(leagueId));
      const move = await desk.api("PATCH", `/api/admin/team-leagues/${leagueId}/fixtures/${later.id}`, { date: later.date, startMin: later.startMin - 120 });
      expect(move.status).toBe(403);
      expect(move.body.code).toBe("MANAGER_ONLY");
      const remake = await desk.api("POST", `/api/admin/team-leagues/${leagueId}`, { action: "generate", nights: [{ date: today, startMin: 1140 }] });
      expect(remake.status).toBe(403);
      // Nothing was moved or made again.
      expect(shape(await publicLeague(leagueId))).toEqual(before);
    });

    await s.step(manager, "moves the second night's fixture to the afternoon: the new time is held, the old given back", async () => {
      const panel = await openLeaguesOfTeams(manager.page);
      const row = night(panel, later.date).locator("li").filter({ hasText: `${later.home.name} v ${later.away.name}` });
      await row.getByRole("button", { name: /^Move/ }).click();
      const target = later.startMin - 300;
      await row.getByLabel("Start time").fill(`${String(Math.floor(target / 60)).padStart(2, "0")}:${String(target % 60).padStart(2, "0")}`);
      await row.getByRole("button", { name: "Move it" }).click();
      await row.getByText(/2:00 PM/).waitFor();
    });
    await s.step(customer, "sees the booking page follow: the old hour is free again, the new one taken", async () => {
      const cells = await boardCells(customer.page, club.venueId, later.date, later.courtName!);
      expect(cells.free).toContain(later.startMin);
      expect(cells.taken).toContain(later.startMin - 300);
      expect(await startsOn(club.venueId, later.date, later.courtId!)).toContain(later.startMin);
    });
    await s.step(bySide(later).home.captain, "is told the fixture moved, by email", async () => {
      await emailed(manager, club.venueId, bySide(later).home.captain.email, new RegExp(`^A fixture in ${leagueName} has moved$`));
    });
  });
  scenario("Team league 2: a reported result is disputed, and the front desk settles it", async (s) => {
    const owner = await signInOwner(await s.actor("Platform"));
    const club = await clubVenue(owner, "Kelab Badminton Seksyen 13", 2);
    const specs = THREE(RUN);
    const [home0, away0] = await squads(s, [specs[0], specs[2]]);
    const manager = await staffApi(await s.actor("Manager"), club.manager.email);
    const leagueName = `Liga Dua Pasukan ${RUN}`;
    const leagueId = await setUpLeague(manager, club, { name: leagueName });
    for (const q of [home0, away0]) await enterLeague(q.team, leagueId);
    const made = await makeFixtures(manager, leagueId, 2);
    expect(made.fixtures).toHaveLength(1);
    const f = made.fixtures[0];
    const [home, away] = [f.home.name, f.away.name].map((n) => [home0, away0].find((q) => q.name === n)!);
    const page = `${url}/team-leagues/${leagueId}`;

    await s.step(home.captain, "reports a 3-0 win in all three games", async () => {
      await home.captain.page.goto(page);
      const row = fixtureRow(home.captain.page, f.home.name, f.away.name);
      await row.getByRole("button", { name: "Report the result" }).click();
      for (const [game, score] of [
        ["Singles 1", "21-15, 21-17"],
        ["Doubles 1", "21-19, 21-18"],
        ["Singles 2", "21-10, 21-12"],
      ]) {
        await row.getByLabel(`${game}: Winner`).selectOption({ label: f.home.name });
        await row.getByLabel(`${game}: Score`).fill(score);
      }
      await row.getByRole("button", { name: "Send the result" }).click();
      await row.getByText("Reported, waiting for the other captain").waitFor();
    });
    await s.step(away.captain, "says it is wrong, and what really happened", async () => {
      const p = away.captain.page;
      await p.goto(page);
      await p.getByRole("button", { name: "It is wrong" }).click();
      await p.getByLabel("What really happened").fill("We won the doubles 21-19 in the third game");
      await p.getByRole("button", { name: "Send to the venue" }).click();
      await fixtureRow(p, f.home.name, f.away.name).getByText("Disputed: the venue decides").waitFor();
      expect(await fitsScreen(p)).toBeLessThanOrEqual(0);
    });
    await s.step(home.captain, "cannot report it again while the venue decides", async () => {
      const again = await home.captain.api("POST", `/api/team-leagues/${leagueId}`, { action: "report", fixtureId: f.id, rubbers: [] });
      expect(again.status).toBeGreaterThanOrEqual(400);
      expect((await publicLeague(leagueId)).fixtures[0].status).toBe("disputed");
    });
    await s.step(manager, "and the club's staff are emailed, each in their own language, with who said what", async () => {
      for (const email of [club.manager.email, club.desk.email]) {
        const mail = await emailed(manager, club.venueId, email, new RegExp(`^A team league result is disputed: ${leagueName}$`));
        expect(mail.text).toContain("We won the doubles 21-19 in the third game");
        expect(mail.text).toContain(`${f.home.name} v ${f.away.name}`);
      }
    });

    const desk = await s.actor("Desk");
    await s.step(desk, "the front desk opens the league on the dashboard: it says a fixture is disputed, and with whose words", async () => {
      await staffOnLeagues(desk, club.desk.email);
      const panel = await openLeaguesOfTeams(desk.page);
      await panel.locator("li").filter({ hasText: leagueName }).getByRole("button", { name: "Open", exact: true }).click();
      await panel.getByText("1 fixtures are disputed: decide them.").waitFor();
      await panel.getByText("The other captain says: We won the doubles 21-19 in the third game").waitFor();
    });
    await s.step(desk, "enters the result the venue decides on: the away side won the doubles, 2-1", async () => {
      const panel = await openLeaguesOfTeams(desk.page);
      const row = night(panel, f.date).locator("li").filter({ hasText: `${f.home.name} v ${f.away.name}` });
      await row.getByRole("button", { name: "Enter the result" }).click();
      const games: [string, "home" | "away", string][] = [
        ["Singles 1", "home", "21-15, 21-17"],
        ["Doubles 1", "away", "21-19, 18-21, 17-21"],
        ["Singles 2", "home", "21-10, 21-12"],
      ];
      for (const [game, winner, score] of games) {
        await row.getByLabel(`${game}: Winner`).selectOption({ label: winner === "home" ? f.home.name : f.away.name });
        await row.getByLabel(`${game}: Score`).fill(score);
      }
      await row.getByRole("button", { name: "Save the result" }).click();
      await row.getByText("2-1").waitFor();
      await row.getByText(/Court \d · played/).waitFor();
    });
    for (const q of [home, away])
      await s.step(q.captain, "is told what the venue decided, and finds it on the league page", async () => {
        const mail = await emailed(manager, club.venueId, q.captain.email, new RegExp(`^The venue decided a fixture in ${leagueName}$`));
        expect(mail.text).toContain("the venue entered the result 2-1");
        await q.captain.page.goto(page);
        await fixtureRow(q.captain.page, f.home.name, f.away.name).getByText("2-1").waitFor();
        await fixtureRow(q.captain.page, f.home.name, f.away.name).getByText(/Played/).waitFor();
        // It is settled: a captain cannot report it over again.
        expect((await q.captain.api("POST", `/api/team-leagues/${leagueId}`, { action: "report", fixtureId: f.id, rubbers: [] })).status).toBeGreaterThanOrEqual(400);
      });
    const visitor = await s.actor("Visitor", "phone");
    await s.step(visitor, "the table the public sees counts it", async () => {
      await visitor.page.goto(page);
      const table = await tableOf(visitor.page);
      expect(table[f.home.name].slice(2, 5)).toEqual(["1", "1", "0"]);
      expect(table[f.away.name].slice(2, 5)).toEqual(["1", "0", "0"]);
      expect(table[f.home.name].at(-1)).toBe("3");
      namesNone(await said(visitor.page), [...home.people, ...away.people]);
    });
  });

  scenario("Team league 3: a forfeit is asked for and nothing changes; the front desk cannot confirm it; a manager confirms one and declines another, and the captains are told", async (s) => {
    const owner = await signInOwner(await s.actor("Platform"));
    const club = await clubVenue(owner, "Kelab Badminton Seksyen 19", 2);
    // One player each besides the captain: a busy day of notices is held to eight emails a person (outbox.ts), and this one has many.
    const all = await squads(s, THREE(RUN).map((spec) => ({ ...spec, players: spec.players.slice(0, 1) })));
    const manager = await staffApi(await s.actor("Manager"), club.manager.email);
    const leagueName = `Liga Walkover ${RUN}`;
    const leagueId = await setUpLeague(manager, club, { name: leagueName, legs: 2 });
    for (const q of all) await enterLeague(q.team, leagueId);
    const league = await makeFixtures(manager, leagueId, 8);
    const today = dayOffset(0);
    const page = `${url}/team-leagues/${leagueId}`;
    const squadOf = (name: string) => all.find((q) => q.name === name)!;
    const future = league.fixtures.filter((f) => f.date > today);
    const x = future[0];
    const y = future[1];
    const [asker, asked] = [squadOf(x.home.name), squadOf(x.away.name)];
    const third = all.find((q) => q !== asker && q !== asked)!;
    const table = (l: LeagueView) => l.standings.map((r) => `${r.name} ${r.played} ${r.won} ${r.lost} ${r.points}`);

    const before = { shape: shape(league), table: table(league), starts: await startsOn(club.venueId, x.date, x.courtId!) };
    expect(before.starts).not.toContain(x.startMin);
    const unchanged = async (why: string) => {
      const now = await publicLeague(leagueId);
      expect(shape(now), `${why}: the fixtures`).toEqual(before.shape);
      expect(table(now), `${why}: the table`).toEqual(before.table);
      expect(await startsOn(club.venueId, x.date, x.courtId!), `${why}: the court's time`).toEqual(before.starts);
    };

    await s.step(asker.captain, `asks the venue to call a forfeit by ${asked.name}: did not turn up, with a note`, async () => {
      const p = asker.captain.page;
      await p.goto(page);
      const row = fixtureRow(p, x.home.name, x.away.name);
      await row.getByRole("button", { name: "Ask the venue to call a forfeit" }).click();
      await row.getByText("Only the venue's manager can call a forfeit. Your request changes nothing until they confirm it, and the other captain is told.").waitFor();
      await row.getByLabel("Team asked to forfeit").selectOption({ label: x.away.name });
      await row.getByLabel("Reason").selectOption({ label: "Did not turn up" });
      await row.getByLabel("Anything to add (up to 300 characters)").fill("Nobody came by 7:15 PM");
      await row.getByRole("button", { name: "Send the request" }).click();
      await row.getByText(`Forfeit requested by ${asker.name}: ${asked.name} asked to forfeit. Waiting for the venue's manager.`).waitFor();
      expect(await fitsScreen(p)).toBeLessThanOrEqual(0);
    });
    await s.step(asked.captain, "is told by email, and sees the request on their own fixture", async () => {
      const mail = await emailed(manager, club.venueId, asked.captain.email, new RegExp(`^A forfeit has been asked for in ${leagueName}$`));
      expect(mail.text).toContain("Only the venue's manager can call a forfeit, and nothing changes until they do.");
      expect(mail.text).toContain("Nobody came by 7:15 PM");
      await asked.captain.page.goto(page);
      await fixtureRow(asked.captain.page, x.home.name, x.away.name).getByText(`Forfeit requested by ${asker.name}: ${asked.name} asked to forfeit.`).waitFor();
      expect(await fitsScreen(asked.captain.page)).toBeLessThanOrEqual(0);
    });
    await s.step(third.captain, "and the third team, and the public, are shown nothing of it; nothing in the league has changed", async () => {
      await third.captain.page.goto(page);
      await fixtureRow(third.captain.page, x.home.name, x.away.name).waitFor();
      expect(await said(third.captain.page)).not.toMatch(/Forfeit requested/);
      const anonymous = JSON.stringify(await (await fetch(`${url}/api/team-leagues/${leagueId}`)).json());
      for (const hidden of ["forfeitRequests", "no_show", "Nobody came"]) expect(anonymous).not.toContain(hidden);
      await unchanged("after the request");
    });

    const desk = await s.actor("Desk");
    const detail = (await manager.api("GET", `/api/admin/team-leagues/${leagueId}`)).body.league as { fixtures: { id: number; forfeitRequests?: { id: number; status: string }[] }[] };
    const requestId = detail.fixtures.find((fx) => fx.id === x.id)!.forfeitRequests!.find((r) => r.status === "open")!.id;
    await s.step(desk, "the front desk sees the request, with who asked, which team and why: and no button to confirm it or to give the forfeit", async () => {
      await staffOnLeagues(desk, club.desk.email);
      const panel = await openLeaguesOfTeams(desk.page);
      await panel.locator("li").filter({ hasText: leagueName }).getByRole("button", { name: "Open", exact: true }).click();
      const row = night(panel, x.date).locator("li").filter({ hasText: `${x.home.name} v ${x.away.name}` });
      await row.getByText(`Forfeit requested by ${asker.name}: ${asked.name} to forfeit`).waitFor();
      await row.getByText("Did not turn up").waitFor();
      await row.getByText(/Nobody came by 7:15 PM/).waitFor();
      await row.getByText("Waiting for a manager").waitFor();
      await row.getByText("A manager gives forfeits. You can ask for one.").waitFor();
      for (const gone of [/^Confirm the forfeit/, /^Forfeit by/, /^Decline/]) expect(await row.getByRole("button", { name: gone }).count()).toBe(0);
    });
    await s.step(desk, "and the server refuses it, by every address that could give one", async () => {
      for (const [path, body] of [
        [`/forfeit-requests/${requestId}`, { confirm: true }],
        [`/fixtures/${x.id}/forfeit`, { forfeitBy: x.away.id }],
        [`/fixtures/${x.id}`, { forfeitBy: x.away.id }],
        [`/forfeit-requests/${requestId}`, { decline: true, reason: "Not for the desk" }],
      ] as const) {
        const r = await desk.api("POST", `/api/admin/team-leagues/${leagueId}${path}`, body);
        expect(r.status, path).toBe(403);
        expect(r.body.code, path).toBe("MANAGER_ONLY");
      }
      await unchanged("after the desk's attempts");
    });

    const boss = await s.actor("Boss");
    await s.step(boss, "the manager opens the same fixture and confirms the forfeit", async () => {
      await staffOnLeagues(boss, club.manager.email);
      const panel = await openLeaguesOfTeams(boss.page);
      await panel.locator("li").filter({ hasText: leagueName }).getByRole("button", { name: "Open", exact: true }).click();
      const row = night(panel, x.date).locator("li").filter({ hasText: `${x.home.name} v ${x.away.name}` });
      await row.getByText(`Forfeit requested by ${asker.name}: ${asked.name} to forfeit`).waitFor();
      await row.getByRole("button", { name: "Confirm the forfeit" }).click();
      await row.getByText(/^Confirmed · /).waitFor();
      // The table as it stood and as it is, kept with the request for the record.
      await row.getByText(/Table before: .*after: /).waitFor();
    });
    const after = await publicLeague(leagueId);
    await s.step(asker.captain, "the table gives the other side every game, and the forfeiting team a defeat", async () => {
      const fixture = after.fixtures.find((fx) => fx.id === x.id)!;
      expect(fixture.status).toBe("forfeit");
      const row = (name: string) => after.standings.find((r) => r.name === name)!;
      expect([row(asker.name).played, row(asker.name).won, row(asker.name).points]).toEqual([1, 1, 3]);
      expect([row(asked.name).played, row(asked.name).lost, row(asked.name).points]).toEqual([1, 1, 0]);
      expect([row(third.name).played, row(third.name).points]).toEqual([0, 0]);
      // The other fixtures are where they were.
      expect(shape(after).filter((l) => !l.startsWith(`${x.id} `))).toEqual(before.shape.filter((l) => !l.startsWith(`${x.id} `)));
    });
    await s.step(asker.captain, "and the fixture's court time is let go: the club's booking page has it free", async () => {
      expect(await startsOn(club.venueId, x.date, x.courtId!)).toContain(x.startMin);
      const customer = await s.actor("Customer");
      const cells = await boardCells(customer.page, club.venueId, x.date, x.courtName!);
      expect(cells.free).toContain(x.startMin);
    });
    for (const q of [asker, asked])
      await s.step(q.captain, "sees the state of the request, is emailed the forfeit, and the table on their phone", async () => {
        const mail = await emailed(manager, club.venueId, q.captain.email, new RegExp(`^The venue decided a fixture in ${leagueName}$`));
        expect(mail.text).toContain(`the venue gave it as a forfeit by ${asked.name}`);
        const p = q.captain.page;
        await p.goto(page);
        const row = fixtureRow(p, x.home.name, x.away.name);
        await row.getByText(`Forfeit confirmed by the venue: ${asked.name} forfeited.`).waitFor();
        await row.getByText(`Forfeit by ${asked.name}`).waitFor();
        expect(await fitsScreen(p)).toBeLessThanOrEqual(0);
      });

    const [asker2, asked2] = [squadOf(y.away.name), squadOf(y.home.name)];
    const reason = "They sent word at 6 PM: a family emergency, so the court is theirs to reschedule";
    await s.step(asker2.captain, "a second request, for another fixture, says another reason and writes why", async () => {
      const p = asker2.captain.page;
      await p.goto(page);
      const row = fixtureRow(p, y.home.name, y.away.name);
      await row.getByRole("button", { name: "Ask the venue to call a forfeit" }).click();
      await row.getByLabel("Team asked to forfeit").selectOption({ label: y.home.name });
      await row.getByLabel("Reason").selectOption({ label: "Another reason (say what below)" });
      await row.getByLabel("Anything to add (up to 300 characters)").fill("They said they will not play this week");
      await row.getByRole("button", { name: "Send the request" }).click();
      await row.getByText(`Forfeit requested by ${asker2.name}: ${asked2.name} asked to forfeit.`).waitFor();
    });
    await s.step(boss, "the manager declines it, with a reason", async () => {
      await boss.page.reload();
      await boss.page.getByRole("button", { name: "Leagues", exact: true }).click();
      const panel = await openLeaguesOfTeams(boss.page);
      await panel.locator("li").filter({ hasText: leagueName }).getByRole("button", { name: "Open", exact: true }).click();
      const row = night(panel, y.date).locator("li").filter({ hasText: `${y.home.name} v ${y.away.name}` });
      await row.getByText(`Forfeit requested by ${asker2.name}: ${asked2.name} to forfeit`).waitFor();
      await row.getByRole("button", { name: "Decline…" }).click();
      await row.getByLabel("Why it is declined").fill(reason);
      await row.getByRole("button", { name: "Decline the request" }).click();
      await row.getByText(/^Declined · /).waitFor();
      await row.getByText(new RegExp(reason)).waitFor();
    });
    for (const q of [asker2, asked2])
      await s.step(q.captain, "is told it was declined, and why", async () => {
        const mail = await emailed(manager, club.venueId, q.captain.email, new RegExp(`^A forfeit request was declined in ${leagueName}$`));
        expect(mail.text).toContain(reason);
        expect(mail.text).toContain("The fixture stands as it was.");
        await q.captain.page.goto(page);
        await fixtureRow(q.captain.page, y.home.name, y.away.name).getByText(`Forfeit request declined by the venue: ${reason}`).waitFor();
      });
    await s.step(asker2.captain, "nothing but the request changed: the fixture is still to play, its court held, the table as it was", async () => {
      const now = await publicLeague(leagueId);
      expect(shape(now)).toEqual(shape(after));
      expect(table(now)).toEqual(table(after));
      expect(await startsOn(club.venueId, y.date, y.courtId!)).not.toContain(y.startMin);
      expect(now.fixtures.find((fx) => fx.id === y.id)!.status).toBe("scheduled");
    });
  });
});
