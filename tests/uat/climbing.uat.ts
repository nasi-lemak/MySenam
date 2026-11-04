import { describe, expect } from "vitest";
import { fitsScreen, scenario, url } from "./harness";
import { addChild, apiOwner, apiPeople, apiStaff, clearBoulder, climbersIn, farDay, openListed, openTab, people, site, staffSignIn, tapBoulder, showBoulder, type Count } from "./uatc-support";

/**
 * Climbing as a wall runs it (docs/features/tournaments.md#counted-performances and #officials-and-counted-results): a manager's bouldering
 * event drawn into qualification groups; an official assigned to this event opens their link on a phone and enters the counts in the judge's grid, overwrites a
 * line, and can reach nothing else (another event, any dashboard page, any other action); the manager makes the final where climbers are level for its last
 * place; the official enters the final's counts; a finished round is changed only through a correction request that the manager previews and applies (against
 * its token) or declines; the public page shows tops, zones, attempts and each boulder's tops, a junior by first name and initial; and after the event the
 * official's link still sends correction requests and enters no count.
 *
 * Day 8 (the link ending seven days after the finish) needs the clock moved, which the acceptance server cannot do: it is covered below the browser, in
 * tests/official-climbing.test.ts ("keeps the link for seven days: alive on day 6 and on the last day, dead on day 8").
 */

const c = (unit: number, attempts: number, zone: number | null = null, top: number | null = null): Count => ({ unit, attempts, zone, top });

/** What the judge counts for each climber over three boulders, by the name the entry carries (the counts of tests/counted-performances.test.ts). */
const PLAN: Record<string, Count[] | "dns"> = {
  "Amir Tester": [c(1, 2, 1, 2), c(2, 1, null, 1), c(3, 3)], // 2T 2Z, 3 attempts to top, 2 to zone
  "Bee Tester": [c(1, 1, 1, 1), c(2, 3, 2, 3), c(3, 2, 1)], // 2T 3Z, 4, 4
  "Chen Tester": [c(1, 1, 1, 1), c(2, 1, 1, 1), c(3, 5, 3, 5)], // 3T 3Z, 7, 5
  "Devi Tester": [c(1, 4, 2), c(2, 3)], // 0T 1Z, 0, 2
  "Eli Tester": [c(1, 3, 3, 3), c(2, 2, 1)], // 1T 2Z, 3, 4
  "Aina Lim": [c(1, 2, 1, 2), c(2, 2, 1)], // 1T 2Z, 2, 2  (the junior)
  "Farah Tester": [c(1, 1, 1, 1), c(2, 3, 2, 3), c(3, 2, 1)], // level with Bee for the final's last place
  "Gopal Tester": "dns",
};

const ADULTS = ["Amir", "Bee", "Chen", "Devi", "Eli", "Farah", "Gopal"];

describe("climbing: a bouldering event judged by an official from a phone", () => {
  scenario("Climbing A: groups, the judge's grid, a link that reaches one event only, the final, a correction request, and the link after the event", async (s) => {
    const owner = await apiOwner();
    const wall = await site(owner, "Setia Wall", "bouldering", 2);
    const day = farDay(45);
    const eventName = `Subang Boulder Open ${Date.now().toString(36)}`;
    const body = (name: string, date: string) => ({
      venueId: wall.venueId,
      courtIds: wall.courtIds,
      name,
      sport: "bouldering",
      template: "bouldering_tops_zones_attempts",
      format: "performance",
      teamSize: 1,
      entryFee: 0,
      maxEntries: 32,
      startsOn: date,
      endsOn: date,
      startMin: 9 * 60,
      endMin: 18 * 60,
      // Groups of four, the best two to a final; three boulders a round.
      rules: { performance: { heatSize: 4, finalSize: 2, counted: { units: 3 } } },
    });

    const manager = await s.actor("Manager");
    const tournamentId = await s.step(manager, "signs in, sets up a bouldering event from the counted template (tops, zones, attempts) and finds its rules on the dashboard", async () => {
      await staffSignIn(manager, wall.manager.email);
      const made = await manager.api("POST", "/api/admin/tournaments", body(eventName, day));
      expect(made.status, JSON.stringify(made.body)).toBe(201);
      await openTab(manager.page, "Tournaments");
      await openListed(manager.page, eventName);
      await manager.page.getByText("Scoring and ranking (from the template bouldering_tops_zones_attempts)").click();
      await manager.page.getByText("Ranked by").first().waitFor();
      return (made.body.tournament as { id: number }).id;
    });

    // Another event of the same wall, drawn, for the official's link to be refused (setup).
    const decoy = await manager.api("POST", "/api/admin/tournaments", body(`Youth Wall Day ${Date.now().toString(36)}`, farDay(46)));
    expect(decoy.status, JSON.stringify(decoy.body)).toBe(201);
    const decoyId = (decoy.body.tournament as { id: number }).id;

    // Seven adults and a mother have accounts made at once; the adults enter (setup), and the first four enter the decoy too.
    const made = await apiPeople(ADULTS);
    const mother = (await people(s, ["Mother"], {}, "phone")).Mother;
    await Promise.all(
      ADULTS.map(async (name, i) => {
        const r = await made[name].api("POST", `/api/tournaments/${tournamentId}`, { action: "enter" });
        expect(r.status, JSON.stringify(r.body)).toBe(201);
        if (i < 4) expect((await made[name].api("POST", `/api/tournaments/${decoyId}`, { action: "enter" })).status).toBe(201);
      })
    );
    for (const action of ["close", "draw"]) expect((await manager.api("POST", `/api/admin/tournaments/${decoyId}`, { action })).status).toBe(200);
    const decoyRound = (((await manager.api("GET", `/api/admin/tournaments/${decoyId}`)).body.tournament as { matches: { id: number; stage: string }[] }).matches).find((m) => m.stage === "heat")!.id;

    await addChild(mother, "Aina Lim", 2014);
    await s.step(mother, "on a phone, enters her daughter in the event through its page, as somebody she acts for", async () => {
      const page = mother.page;
      await page.goto(`${url}/tournaments/${tournamentId}`);
      await page.getByLabel("Who is entering").selectOption({ label: "Aina Lim" });
      const agree = page.getByLabel("A parent or guardian of each entrant under 18 agrees to this entry");
      if (await agree.count()) await agree.check();
      await page.getByRole("button", { name: "Enter", exact: true }).click();
      await page.getByText(/Aina Lim|entered/i).first().waitFor();
      expect(await fitsScreen(page)).toBeLessThanOrEqual(0);
    });

    await s.step(manager, "closes entries and draws the qualification groups: eight climbers, two groups by lot", async () => {
      const page = manager.page;
      await page.reload();
      await openTab(page, "Tournaments");
      await openListed(page, eventName);
      await page.getByRole("button", { name: "Close entries" }).click();
      await page.getByRole("button", { name: "Make the draw" }).click();
      await page.getByRole("heading", { name: /^Group 1/ }).waitFor();
      await page.getByRole("heading", { name: /^Group 2/ }).waitFor();
      await page.getByText("Final: filled once the heats are in.").waitFor();
    });

    const link = await s.step(manager, "gives an official, Judge Jamal, a link of their own for this event, shown once", async () => {
      const page = manager.page;
      await page.getByPlaceholder("Official's name").fill("Judge Jamal");
      await page.getByRole("button", { name: "Give an official a link" }).click();
      await page.getByText("Send this link to the official now", { exact: false }).waitFor();
      const shown = await page.getByText(/\/officials\/[A-Za-z0-9_-]+/).textContent();
      return /\/officials\/[A-Za-z0-9_-]+/.exec(shown ?? "")![0];
    });
    const token = link.slice("/officials/".length);

    const judge = await s.actor("Judge", "phone");
    const grids = (name: RegExp) => judge.page.locator("div.rounded-xl").filter({ has: judge.page.getByRole("heading", { name }) });
    /** One round entered boulder by boulder as the judge does on a phone; `only` limits it to some of the climbers, `mistake` enters one boulder wrongly first. */
    async function enterRound(grid: ReturnType<typeof grids>, which: { only?: string[]; skip?: string[] } = {}) {
      const names = (await climbersIn(grid)).filter((n) => (!which.only || which.only.includes(n)) && !which.skip?.includes(n));
      for (const unit of [1, 2, 3]) {
        await showBoulder(grid, unit);
        for (const n of names) {
          const plan = PLAN[n];
          if (plan === "dns") continue;
          const count = plan.find((x) => x.unit === unit);
          if (count) await tapBoulder(grid, n, count);
        }
      }
      for (const n of names) if (PLAN[n] === "dns") await grid.getByLabel(`${n} status`).selectOption({ label: "did not start" });
    }

    await s.step(judge, "opens the link on a phone, no account: this event's rounds, and nothing of the dashboard", async () => {
      await judge.page.goto(`${url}${link}`);
      await judge.page.getByRole("heading", { name: `Results for ${eventName}` }).waitFor();
      await judge.page.getByText("Entering results as Judge Jamal", { exact: false }).waitFor();
      await grids(/^Group 1/).waitFor();
      await grids(/^Group 2/).waitFor();
      expect(await fitsScreen(judge.page)).toBeLessThanOrEqual(0);
      // The junior is on the official's page by full name: the judge needs it at the wall.
      await judge.page.getByRole("rowheader", { name: "Aina Lim" }).waitFor();
    });

    let firstGroup = "";
    let wrongName = "";
    await s.step(judge, "taps the first group's counts, one boulder at a time, for three of four climbers, entering one boulder wrongly: the round stays open", async () => {
      const grid = grids(/^Group 1/);
      const names = await climbersIn(grid);
      firstGroup = names.join("|");
      // The first climber's second boulder is taken as a top on the second attempt (+ + T), a mistake the judge corrects below.
      await enterRound(grid, { skip: [names[3]] });
      wrongName = names.slice(0, 3).find((n) => PLAN[n] !== "dns" && (PLAN[n] as Count[]).some((x) => x.unit === 2))!;
      expect(wrongName, "a climber with a second boulder among the first three").toBeTruthy();
      await showBoulder(grid, 2);
      await clearBoulder(grid, wrongName, 2);
      await tapBoulder(grid, wrongName, c(2, 2, 2, 2));
      await grid.getByRole("button", { name: "Save the counts" }).click();
      await judge.page.getByText("Saved.").waitFor();
      // Still open: its grid is still there, with the three lines in.
      await grids(/^Group 1/).getByRole("button", { name: "Save the counts" }).waitFor();
    });

    await s.step(judge, "re-enters the wrong line and the fourth climber's: the round is complete and finished, and the page lists what was overwritten", async () => {
      const grid = grids(/^Group 1/);
      const names = await climbersIn(grid);
      expect(names.join("|")).toBe(firstGroup);
      await showBoulder(grid, 2);
      await clearBoulder(grid, wrongName, 2);
      await tapBoulder(grid, wrongName, (PLAN[wrongName] as Count[]).find((x) => x.unit === 2)!);
      await enterRound(grid, { only: [names[3]] });
      await grid.getByRole("button", { name: "Save the counts" }).click();
      await judge.page.getByRole("heading", { name: /^Group 1/ }).locator("xpath=ancestor::section[1]").getByText("· finished", { exact: true }).waitFor();
      // What the judge overwrote is on their page, with what it replaced.
      await judge.page.getByRole("heading", { name: "Your recent entries" }).waitFor();
      await judge.page.getByText(/\(was .+\)/).first().waitFor();
    });

    await s.step(judge, "enters the second group in one save: with every group in, the final waits for the manager, because two climbers are level for its last place", async () => {
      const grid = grids(/^Group 2/);
      await enterRound(grid);
      await grid.getByRole("button", { name: "Save the counts" }).click();
      await judge.page.getByRole("heading", { name: /^Group 2/ }).locator("xpath=ancestor::section[1]").getByText("· finished", { exact: true }).waitFor();
      expect(await fitsScreen(judge.page)).toBeLessThanOrEqual(0);
    });

    await s.step(judge, "is refused a finished round's counts, another event's round, any dashboard page and any other action", async () => {
      const finishedRound = (await manager.api("GET", `/api/admin/tournaments/${tournamentId}`)).body.tournament as { matches: { id: number; stage: string; position: number }[]; entries: { id: number; name: string }[] };
      const group1 = finishedRound.matches.find((m) => m.stage === "heat" && m.position === 1)!;
      const bee = finishedRound.entries.find((e) => e.name === "Bee Tester")!;
      // A finished round: refused, and the manager's flow is named.
      const final = await judge.api("POST", `/api/officials/${token}`, { matchId: group1.id, performances: [{ entryId: bee.id, counts: [{ unit: 1, attempts: 1, zone: 1, top: 1 }] }] });
      expect(final.status).toBe(409);
      expect(final.body).toMatchObject({ code: "OFC_ROUND_FINAL" });
      // Another event's round, though a real one: not found for this link, nothing written.
      const other = await judge.api("POST", `/api/officials/${token}`, { matchId: decoyRound, performances: [{ entryId: bee.id, counts: [{ unit: 1, attempts: 1, zone: 1, top: 1 }] }] });
      expect(other.status).toBe(409);
      expect(other.body).toMatchObject({ code: "OFC_NOT_HERE" });
      // The link shows this event only.
      const seen = await judge.api("GET", `/api/officials/${token}`);
      expect((seen.body.tournament as { id: number }).id).toBe(tournamentId);
      // Anything but counts and correction requests is no action it has.
      for (const action of ["cancel", "draw", "close", "final"]) expect((await judge.api("POST", `/api/officials/${token}`, { action })).status, action).toBe(400);
      // A link is not a session: every dashboard route says nobody is signed in.
      for (const [method, path, payload] of [
        ["GET", `/api/admin/tournaments/${tournamentId}`, undefined],
        ["GET", `/api/admin/tournaments?venueId=${wall.venueId}`, undefined],
        ["POST", `/api/admin/tournaments/${tournamentId}`, { action: "final", chosen: [bee.id] }],
        ["POST", `/api/admin/tournaments/${tournamentId}/matches/${group1.id}`, { performances: [] }],
        ["POST", `/api/admin/tournaments/${tournamentId}/officials`, { name: "Me too" }],
        ["GET", `/api/admin/activity?venueId=${wall.venueId}`, undefined],
        ["GET", `/api/admin/bookings?venueId=${wall.venueId}&date=${day}`, undefined],
      ] as const) {
        const r = await judge.api(method, path, payload);
        expect(r.status, `${method} ${path}`).toBe(401);
      }
      // And the dashboard's own page offers this browser a sign-in, not a dashboard.
      await judge.page.goto(`${url}/admin`);
      await judge.page.getByLabel("Email").waitFor();
      expect(await judge.page.getByRole("button", { name: /sign out/i }).count()).toBe(0);
    });

    let chosen = "";
    await s.step(manager, "finds the tie for the final's last place and puts one of the two level climbers in the final", async () => {
      const page = manager.page;
      await page.reload();
      await openTab(page, "Tournaments");
      await openListed(page, eventName);
      const tie = page.locator("div").filter({ has: page.getByRole("heading", { name: "Level for the final's last place" }) }).last();
      await tie.waitFor();
      const labels = await tie.locator("label").allTextContents();
      expect(labels.map((x) => x.trim()).sort()).toEqual(["Bee Tester", "Farah Tester"]);
      chosen = labels[0].trim();
      await tie.getByRole("checkbox", { name: chosen }).check();
      await tie.getByRole("button", { name: "Put them in the final" }).click();
      await page.getByRole("heading", { name: "Level for the final's last place" }).waitFor({ state: "detached" });
    });

    const publicPage = await s.actor("Visitor", "phone");
    await s.step(publicPage, "on a phone, with no account, sees the placings with tops, zones and attempts, how many topped each boulder, and the junior as Aina L.", async () => {
      const page = publicPage.page;
      await page.goto(`${url}/tournaments/${tournamentId}`);
      await page.getByRole("heading", { name: "Results", exact: true }).waitFor();
      const results = page.getByRole("heading", { name: "Results", exact: true }).locator("xpath=following::table[1]");
      for (const head of ["Tops", "Zones", "Attempts to top", "Attempts to zone"]) await results.getByText(head, { exact: true }).waitFor();
      const row = (name: string) => results.locator("tr").filter({ hasText: name }).first();
      // Rank, name, tops, zones, attempts to top, attempts to zone.
      // The two finalists have no place until the final is climbed; the rest are placed after them. Their qualifying counts are in their group.
      expect((await row("Chen Tester").innerText()).split(/\s+/).join(" ")).toBe("— Chen Tester to come");
      expect((await page.locator("tr").filter({ hasText: "Chen Tester" }).nth(1).innerText()).split(/\s+/).join(" ")).toMatch(/^\d Chen Tester\(1\) 3 3 7 5$/);
      expect((await row("Amir Tester").innerText()).split(/\s+/).join(" ")).toBe("4 Amir Tester 2 2 3 2");
      expect((await row("Aina L.").innerText()).split(/\s+/).join(" ")).toBe("5 Aina L. 1 2 2 2");
      expect((await row("Devi Tester").innerText()).split(/\s+/).join(" ")).toBe("7 Devi Tester 0 1 0 2");
      await page.getByText("How many topped each boulder", { exact: false }).first().waitFor();
      await page.getByText(/\d of \d topped it, \d reached the zone/).first().waitFor();
      // The child by first name and the initial of the next, everywhere on the page; the full name nowhere.
      expect(await page.locator("body").innerText()).not.toContain("Aina Lim");
      expect(await fitsScreen(page)).toBeLessThanOrEqual(0);
      const api = await publicPage.api("GET", `/api/tournaments/${tournamentId}`);
      expect(JSON.stringify(api.body)).not.toContain("Aina Lim");
      expect(JSON.stringify(api.body)).toContain("Aina L.");
    });

    await s.step(judge, "reloads: the final is there with the two climbers, and the official enters its counts; the round finishes and so does the event", async () => {
      await judge.page.goto(`${url}${link}`);
      const grid = grids(/^Final/);
      await grid.waitFor();
      const names = await climbersIn(grid);
      expect(names.sort()).toEqual(["Chen Tester", chosen].sort());
      // The final's counts: Chen tops two boulders, the other climber one.
      const finalCounts: Record<string, Count[]> = { "Chen Tester": [c(1, 1, 1, 1), c(2, 2, 1, 2), c(3, 3)], [chosen]: [c(1, 2, 1, 2), c(2, 4, 2), c(3, 2)] };
      for (const unit of [1, 2, 3]) {
        await showBoulder(grid, unit);
        for (const n of names) {
          const count = finalCounts[n].find((x) => x.unit === unit);
          if (count) await tapBoulder(grid, n, count);
        }
      }
      // Chen's counts on the third boulder: nothing reached, three attempts.
      await grid.getByRole("button", { name: "Save the counts" }).click();
      await judge.page.getByRole("heading", { name: /^Final/ }).locator("xpath=ancestor::section[1]").getByText("· finished", { exact: true }).waitFor();
      const detail = (await manager.api("GET", `/api/admin/tournaments/${tournamentId}`)).body.tournament as { status: string };
      expect(detail.status).toBe("finished");
    });

    // A count is wrong in Group 1: Devi's second boulder was topped on the third attempt, zone on the second.
    const asked = "Devi's boulder 2 was topped on the third attempt (zone on the second): the judge's card.";
    await s.step(judge, "asks for a correction to a finished group, saying why and giving the counts it should have; nothing changes", async () => {
      const page = judge.page;
      await page.reload();
      const section = page.locator("section").filter({ hasText: "Devi Tester" }).filter({ has: page.getByRole("button", { name: "Ask for a correction" }) }).first();
      await section.getByRole("button", { name: "Ask for a correction" }).click();
      await section.getByLabel("Why it needs correcting").fill(asked);
      const grid = section.locator("div.rounded-xl").first();
      await showBoulder(grid, 2);
      await clearBoulder(grid, "Devi Tester", 2);
      await tapBoulder(grid, "Devi Tester", c(2, 3, 2, 3));
      await grid.getByRole("button", { name: "Send the correction request" }).click();
      await page.getByRole("heading", { name: "Your correction requests" }).waitFor();
      await page.getByText("waiting for the organiser").waitFor();
      // Changed nothing: the public page still has Devi at 0 tops.
      const publicRow = await (await fetch(`${url}/api/tournaments/${tournamentId}`)).json();
      expect(JSON.stringify(publicRow)).toContain("Devi Tester");
    });

    await s.step(manager, "finds the request under the event, previews what it changes, applies it as previewed; the desk may not", async () => {
      const page = manager.page;
      await page.reload();
      await openTab(page, "Tournaments");
      await openListed(page, eventName);
      const requests = page.getByLabel("Corrections officials asked for");
      await requests.getByText(/Judge Jamal asks to correct Group \d/).waitFor();
      await requests.getByText("Waiting for a manager").waitFor();
      await requests.getByRole("button", { name: "Preview what it changes" }).click();
      await requests.getByText("It would change:").waitFor();
      await requests.getByText(/0T 1Z .* becomes 1T 2Z/).waitFor();
      // The desk is turned away from deciding it, by the server.
      const desk = await apiStaff(wall.desk.email);
      const list = (await desk.api("GET", `/api/admin/tournaments/${tournamentId}`)).body.correctionRequests as { id: number }[];
      expect(list).toHaveLength(1);
      const refused = await desk.api("POST", `/api/admin/tournaments/${tournamentId}/correction-requests/${list[0].id}`, { action: "apply", token: "x" });
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({ code: "MANAGER_ONLY" });
      await requests.getByRole("button", { name: "Apply the correction" }).click();
      await requests.getByText("Applied").waitFor();
    });

    await s.step(publicPage, "reloads the public page: Devi's line is corrected and the placings follow", async () => {
      const page = publicPage.page;
      await page.reload();
      const results = page.getByRole("heading", { name: "Results", exact: true }).locator("xpath=following::table[1]");
      await results.locator("tr").filter({ hasText: "Devi Tester" }).first().waitFor();
      expect((await results.locator("tr").filter({ hasText: "Devi Tester" }).first().innerText()).split(/\s+/).join(" ")).toBe("6 Devi Tester 1 2 3 4");
      // Level with Eli on every count, so they share sixth place.
      expect((await results.locator("tr").filter({ hasText: "Eli Tester" }).first().innerText()).split(/\s+/).join(" ")).toBe("6 Eli Tester 1 2 3 4");
      // The final's order: Chen first with two tops.
      expect((await results.locator("tbody tr").first().innerText()).split(/\s+/).join(" ")).toMatch(/^1 Chen Tester 2 /);
    });

    await s.step(judge, "after the event has finished, the link still shows the results and asks for a correction; counts are refused", async () => {
      const page = judge.page;
      await page.reload();
      await page.getByText(/^This event has finished\. Until \d{4}-\d{2}-\d{2} this link still shows the results/).waitFor();
      await page.getByText("made by the organiser").waitFor();
      // Entering is refused, a preview included, and a result, a call or a start is not something the link does.
      const names = (await (await fetch(`${url}/api/tournaments/${tournamentId}`)).json()) as { tournament: { entries: { id: number; name: string }[]; matches: { id: number; stage: string; position: number }[] } };
      const bee = names.tournament.entries.find((e) => e.name === "Bee Tester")!;
      const g1 = names.tournament.matches.find((m) => m.stage === "heat" && m.position === 1)!;
      const counts = await judge.api("POST", `/api/officials/${token}`, { matchId: g1.id, performances: [{ entryId: bee.id, counts: [{ unit: 1, attempts: 1, zone: 1, top: 1 }] }] });
      expect(counts.body).toMatchObject({ code: "OFC_EVENT_FINISHED" });
      const preview = await judge.api("POST", `/api/officials/${token}`, { matchId: g1.id, preview: true, performances: [{ entryId: bee.id, counts: [{ unit: 1, attempts: 1, zone: 1, top: 1 }] }] });
      expect(preview.body).toMatchObject({ code: "OFC_EVENT_FINISHED" });
      expect((await judge.api("POST", `/api/officials/${token}`, { action: "call", matchId: g1.id })).status).toBe(409);
      // A correction that would change who was in the final, which has been climbed, cannot even be asked for: Amir's third boulder as a zone would put him in it.
      const live = (await (await fetch(`${url}/api/tournaments/${tournamentId}`)).json()) as { tournament: { entries: { id: number; name: string }[]; performance: { lines: Record<string, { entryId: number }[]> } } };
      const amir = live.tournament.entries.find((e) => e.name === "Amir Tester")!;
      const amirGroup = Object.entries(live.tournament.performance.lines).find(([, lines]) => lines.some((l) => l.entryId === amir.id))![0];
      const tooMuch = await judge.api("POST", `/api/officials/${token}`, {
        action: "correction_request",
        matchId: Number(amirGroup),
        reason: "Amir's third boulder was a zone on the second attempt.",
        performances: [{ entryId: amir.id, status: "ok", counts: [{ unit: 1, attempts: 2, zone: 1, top: 2 }, { unit: 2, attempts: 1, zone: 1, top: 1 }, { unit: 3, attempts: 3, zone: 2, top: null }] }],
      });
      expect(tooMuch.status).toBe(409);
      expect(String(tooMuch.body.error)).toMatch(/The final has results.*arrange a re-climb by hand\./);
      // A correction request that leaves the final's field as it was goes through the page.
      const section = page.locator("section").filter({ hasText: "Aina Lim" }).filter({ has: page.getByRole("button", { name: "Ask for a correction" }) }).first();
      await section.getByRole("button", { name: "Ask for a correction" }).click();
      await section.getByLabel("Why it needs correcting").fill("Aina's second boulder was topped on the second attempt: the judge's card shows T.");
      const grid = section.locator("div.rounded-xl").first();
      await showBoulder(grid, 2);
      await clearBoulder(grid, "Aina Lim", 2);
      await tapBoulder(grid, "Aina Lim", c(2, 2, 1, 2));
      await grid.getByRole("button", { name: "Send the correction request" }).click();
      await page.getByText(/waiting for the organiser/).waitFor();
      expect(await fitsScreen(page)).toBeLessThanOrEqual(0);
    });

    await s.step(manager, "declines that request, with a reason; the official sees the reason and the counts stand", async () => {
      const page = manager.page;
      await page.reload();
      await openTab(page, "Tournaments");
      await openListed(page, eventName);
      const requests = page.getByLabel("Corrections officials asked for");
      const item = requests.locator("li").filter({ hasText: "Aina's second boulder" });
      await item.getByRole("button", { name: "Decline…" }).click();
      await item.getByLabel("Why it is declined").fill("The video shows the zone was not held.");
      await item.getByRole("button", { name: "Decline the request" }).click();
      await item.getByText("Declined").waitFor();
      await judge.page.reload();
      await judge.page.getByText(/declined: The video shows the zone was not held\./).waitFor();
      // Everything the official and the manager did is in the venue's activity log under their names.
      const log = ((await manager.api("GET", `/api/admin/activity?venueId=${wall.venueId}`)).body.actions as { action: string; adminName: string }[]).map((a) => `${a.action} ${a.adminName}`);
      expect(log).toEqual(expect.arrayContaining(["tournament.performances Official: Judge Jamal", "tournament.correction_requested Official: Judge Jamal", `tournament.correction_applied ${wall.manager.name}`, `tournament.correction_declined ${wall.manager.name}`]));
    });
  });
});
