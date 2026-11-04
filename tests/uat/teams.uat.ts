import { describe, expect, inject, it } from "vitest";
import type { Page } from "playwright-core";
import { dayAhead, fitsScreen, scenario, signInOwner, signUp, url } from "./harness";
import { addChild, adult, clubVenue, emailed, linkIn, makeTeam, rosterIds, staffApi, tokenOf } from "./teams-support";

/**
 * Teams (docs/features/tournaments.md#teams), as the people on one meet them, each in a browser of their own:
 *
 * - **Teams 1**: a captain starts a team and brings people in by a link they share and by an email; somebody who has not said
 *   they are an adult, and somebody across a block, are refused in the same words as any invitation that cannot be used; a
 *   child goes on only through a guardian (the captain's own, or another's by that guardian accepting) and is "a junior
 *   player" to everybody else; the team's name is public only once the captain publishes it; captaincy is handed over and
 *   a member leaves.
 * - **Teams 2**: starting a team and inviting by email with the keyboard alone.
 * - **Teams 3**: the captain enters a tournament as the team, picking a roster; a member who fails the event's age range is
 *   refused with the reason, one who has not said a date of birth likewise, and says it for themself; the typed team and
 *   roster still work beside it.
 *
 * Players' teams hold no court and no money, so no venue is needed but for Teams 3's tournament. Every scenario's names are
 * its own. The captain's and the members' words about themselves (ages, a guardian's agreement) are declared, never verified.
 */

const RUN = Date.now().toString(36);

/** Scenarios that read the emails the app sent, from its output: skipped against a deployment, which has no such log. */
const logScenario: typeof scenario = inject("uatServerLog") ? scenario : (title) => it.skip(title, () => undefined);

/** The roster section of a team's page. */
const roster = (page: Page) => page.locator("section").filter({ has: page.getByRole("heading", { name: "Members", exact: true }) });

/** What the whole page says. */
const said = (page: Page) => page.locator("body").innerText();

/** Press Tab until the focus is on what `selector` matches; how many presses it took. Fails if it never gets there. */
async function tabTo(page: Page, selector: string, max = 40): Promise<number> {
  for (let n = 1; n <= max; n++) {
    await page.keyboard.press("Tab");
    if (await page.evaluate((sel) => document.activeElement?.matches(sel) ?? false, selector)) return n;
  }
  throw new Error(`Keyboard focus never reached ${selector} in ${max} presses of Tab`);
}

describe("teams", () => {
  logScenario("Teams 1: a captain builds a team: by link and email, a child through a guardian, a public name only when published, a hand-over and a leaver", async (s) => {
    const owner = await signInOwner(await s.actor("Platform"));
    const nadia = await adult(s, "Nadia");
    const ben = await adult(s, "Ben", "phone");
    const chloe = await adult(s, "Chloe", "phone");
    const wrong = await adult(s, "Wrong", "phone");
    const minor = await signUp(await s.actor("Minor", "phone"), { profile: { adult: false } });
    const blocker = await adult(s, "Blocker", "phone");
    const gina = await adult(s, "Gina", "phone");
    const visitor = await s.actor("Visitor", "phone");
    const teamName = `Seksyen 7 Smashers ${RUN}`;
    await addChild(nadia, "Mei", 2014);
    const hana = await addChild(gina, "Hana", 2015);

    const teamId = await s.step(nadia, "starts a team on the My teams page", async () => {
      await nadia.page.goto(`${url}/teams`);
      await nadia.page.getByRole("heading", { name: "My teams" }).waitFor();
      await nadia.page.getByText("You are not on a team yet.").waitFor();
      await nadia.page.getByLabel("Team name").fill(teamName);
      await nadia.page.getByRole("button", { name: "Start a team" }).click();
      await nadia.page.waitForURL(/\/teams\/\d+$/);
      await nadia.page.getByRole("heading", { name: new RegExp(teamName) }).waitFor();
      await nadia.page.getByText("This team is not published: only its members can see it.").waitFor();
      return Number(nadia.page.url().split("/").pop());
    });

    await s.step(visitor, "finds nothing at the team's address while it is not published", async () => {
      await visitor.page.goto(`${url}/teams/${teamId}`);
      await visitor.page.getByText("That team is not there.").waitFor();
      expect((await visitor.api("GET", `/api/teams/${teamId}`)).status).toBe(404);
    });

    const shared = await s.step(nadia, "makes a link to share, shown once", async () => {
      await nadia.page.getByRole("button", { name: "Make a link to share" }).click();
      const field = nadia.page.getByRole("textbox", { name: "Your link (shown once)" });
      await field.waitFor();
      await nadia.page.getByRole("link", { name: "Share on WhatsApp" }).waitFor();
      return field.inputValue();
    });
    expect(shared).toContain("/team-invitation?token=");

    await s.step(ben, "opens the shared link on his phone, says when he was born, and joins", async () => {
      await ben.page.goto(shared);
      await ben.page.getByRole("heading", { name: "Join a team" }).waitFor();
      await ben.page.getByText(new RegExp(`Nadia invited you to join ${teamName}`)).waitFor();
      await ben.page.getByLabel("Date of birth").fill("1995-05-05");
      expect(await fitsScreen(ben.page)).toBeLessThanOrEqual(0);
      await ben.page.getByRole("button", { name: "Join the team" }).click();
      await ben.page.getByText(`You are on ${teamName}.`).waitFor();
      await ben.page.getByRole("link", { name: "Open the team" }).click();
      await ben.page.waitForURL(`${url}/teams/${teamId}`);
      await roster(ben.page).getByText("Nadia").waitFor();
      await roster(ben.page).getByText("Captain").first().waitFor();
      expect(await fitsScreen(ben.page)).toBeLessThanOrEqual(0);
    });
    await s.step(ben, "the same link is spent: opened again it cannot be used", async () => {
      await ben.page.goto(shared);
      await ben.page.getByText("That invitation cannot be used.").waitFor();
      await ben.page.getByRole("button", { name: "Join the team" }).waitFor({ state: "detached", timeout: 3000 }).catch(() => undefined);
      expect(await ben.page.getByRole("button", { name: "Join the team" }).count()).toBe(0);
    });
    await s.step(nadia, "is told Ben joined, by email", async () => {
      await emailed(owner, "platform", nadia.email, new RegExp(`^Ben joined ${teamName}$`));
    });

    const mailLink = await s.step(nadia, "invites Chloe by email: told only that it is sent, never who holds the address", async () => {
      await nadia.page.goto(`${url}/teams/${teamId}`);
      await nadia.page.getByLabel("Their email address").fill(chloe.email);
      await nadia.page.getByRole("button", { name: "Send the invitation" }).click();
      await nadia.page.getByText("Invitation sent. It can be used once and runs out in 14 days.").waitFor();
      await nadia.page.getByText(/by email · until \d{4}-\d{2}-\d{2}/).waitFor();
      // The address is not shown back anywhere.
      expect(await said(nadia.page)).not.toContain(chloe.email);
      const mail = await emailed(owner, "platform", chloe.email, new RegExp(`^Nadia invited you to join ${teamName}$`));
      expect(mail.text).toContain("signed in with an account that has said it is 18 or over");
      return linkIn(mail, /^\/team-invitation$/);
    });
    await s.step(wrong, "opens Chloe's emailed link with another account: it cannot be used", async () => {
      await wrong.page.goto(mailLink);
      await wrong.page.getByText("That invitation cannot be used.").waitFor();
      expect(await wrong.page.getByRole("button", { name: "Join the team" }).count()).toBe(0);
      expect((await wrong.api("POST", "/api/team-invitations", { token: tokenOf(mailLink) })).status).toBe(404);
    });
    await s.step(chloe, "opens the email's link on her phone and joins", async () => {
      await chloe.page.goto(mailLink);
      await chloe.page.getByRole("button", { name: "Join the team" }).click();
      await chloe.page.getByText(`You are on ${teamName}.`).waitFor();
    });

    // Somebody who has not said they are 18 or over, and somebody who blocked the captain: the same words as any invitation that cannot be used.
    const groupId = (await blocker.api("POST", "/api/groups", { name: `Blocker's Friday doubles ${RUN}`, sport: "badminton" })).body.group as { id: number };
    expect((await nadia.api("POST", `/api/groups/${groupId.id}`, { action: "join" })).status).toBeLessThan(300);
    const asked = (await blocker.api("GET", `/api/groups/${groupId.id}`)).body.group as { roster?: { memberId: number; userId: number; status: string }[] };
    const request = (asked.roster ?? []).find((m) => m.userId === nadia.id && m.status === "requested");
    expect((await blocker.api("POST", `/api/groups/${groupId.id}/members/${request!.memberId}`, { action: "accept" })).status).toBe(200);
    expect((await blocker.api("POST", "/api/players/blocks", { userId: nadia.id })).status).toBe(200);

    const guardianLink = await s.step(nadia, "makes another link, for the people who are about to try it", async () => {
      await nadia.page.getByRole("button", { name: "Make a link to share" }).click();
      return nadia.page.getByRole("textbox", { name: "Your link (shown once)" }).inputValue();
    });
    for (const [who, why] of [
      [minor, "has said they are under 18"],
      [blocker, "has blocked the captain"],
    ] as const)
      await s.step(who, `opens the link: refused, in the words of any invitation that cannot be used, because ${why}`, async () => {
        await who.page.goto(guardianLink);
        await who.page.getByText("That invitation cannot be used.").waitFor();
        expect(await who.page.getByRole("button", { name: "Join the team" }).count()).toBe(0);
        const direct = await who.api("POST", "/api/team-invitations", { token: tokenOf(guardianLink) });
        expect(direct.status).toBe(404);
        expect(direct.body).toMatchObject({ code: "TM_INVITE_INVALID" });
        expect(await fitsScreen(who.page)).toBeLessThanOrEqual(0);
      });

    await s.step(nadia, "puts her own child on the team: the captain's agreement, as guardian", async () => {
      await nadia.page.goto(`${url}/teams/${teamId}`);
      const form = nadia.page.locator("form").filter({ has: nadia.page.getByRole("heading", { name: "Put a child you look after on the team" }) });
      await form.getByLabel("Who").selectOption({ label: "Mei" });
      await form.getByLabel("Date of birth").fill("2014-03-03");
      await form.getByRole("button", { name: "Put on the team" }).click();
      await roster(nadia.page).getByText("Mei").waitFor();
      // The picker offers only the children she manages herself: nobody else's.
      expect(await form.getByLabel("Who").locator("option").allTextContents()).toEqual(["", "Mei"]);
    });
    await s.step(nadia, "cannot put somebody else's child on the team herself: refused, as for one who is not hers", async () => {
      const r = await nadia.api("POST", `/api/teams/${teamId}`, { action: "addChild", participantId: hana });
      expect(r.status).toBe(404);
      expect(r.body.code).toBe("TM_NOT_YOURS");
    });
    await s.step(gina, "opens the link as a guardian and puts Hana on the team instead of herself: her own agreement", async () => {
      await gina.page.goto(guardianLink);
      await gina.page.getByLabel("Put somebody you look after on the team instead of yourself").selectOption({ label: "Hana" });
      await gina.page.getByText("You agree for them, as their guardian; their name is shown only to you and the captain.").waitFor();
      await gina.page.getByRole("button", { name: "Join the team" }).click();
      await gina.page.getByText(`You are on ${teamName}.`).waitFor();
      await gina.page.getByRole("link", { name: "Open the team" }).click();
      await roster(gina.page).getByText("Hana").waitFor();
      // She is on the roster for her child, not for herself, and sees Mei only as "a junior player".
      await roster(gina.page).getByText("somebody you look after").waitFor();
      expect(await roster(gina.page).getByText("A junior player").count()).toBe(1);
      expect(await said(gina.page)).not.toContain("Mei");
    });
    await s.step(ben, "sees both children only as junior players: no name is shown to another member", async () => {
      await ben.page.goto(`${url}/teams/${teamId}`);
      await roster(ben.page).getByText("Chloe").waitFor();
      expect(await roster(ben.page).getByText("A junior player").count()).toBe(2);
      const page = await said(ben.page);
      for (const name of ["Mei", "Hana"]) expect(page).not.toContain(name);
      expect(JSON.stringify((await ben.api("GET", `/api/teams/${teamId}`)).body)).not.toMatch(/Mei|Hana/);
      expect(await fitsScreen(ben.page)).toBeLessThanOrEqual(0);
    });
    await s.step(nadia, "sees both children by name, as the captain does, and Hana's guardian's agreement is on record", async () => {
      await nadia.page.goto(`${url}/teams/${teamId}`);
      await roster(nadia.page).getByText("Hana").waitFor();
      await roster(nadia.page).getByText("Mei").waitFor();
    });

    await s.step(nadia, "publishes the team: only its name is then shown", async () => {
      // The box follows the server's answer, so it is clicked and then waited for.
      await nadia.page.getByLabel("Show the team's name to anybody").click();
      await nadia.page.getByText("This team is not published: only its members can see it.").waitFor({ state: "detached" });
    });
    await s.step(visitor, "now finds the team by its address: its name and sport and nothing else", async () => {
      await visitor.page.goto(`${url}/teams/${teamId}`);
      await visitor.page.getByRole("heading", { name: new RegExp(teamName) }).waitFor();
      await visitor.page.getByText("This team's name is public. Nothing else about it is.").waitFor();
      const page = await said(visitor.page);
      for (const hidden of ["Nadia", "Ben", "Chloe", "Gina", "Mei", "Hana", "Members", "Invite somebody"]) expect(page).not.toContain(hidden);
      const api = JSON.stringify((await visitor.api("GET", `/api/teams/${teamId}`)).body);
      for (const hidden of ["Nadia", "Ben", "Chloe", "Mei", "Hana", "roster", "invitations"]) expect(api).not.toContain(hidden);
      expect(await fitsScreen(visitor.page)).toBeLessThanOrEqual(0);
    });

    await s.step(nadia, "hands the team to Ben: he cannot be a junior, so the button is not on the children", async () => {
      await nadia.page.goto(`${url}/teams/${teamId}`);
      const rows = roster(nadia.page).locator("li");
      expect(await rows.filter({ hasText: "Mei" }).getByRole("button", { name: "Make captain" }).count()).toBe(0);
      await rows.filter({ hasText: "Ben" }).getByRole("button", { name: "Make captain" }).click();
      await roster(nadia.page).locator("li").filter({ hasText: "Ben" }).getByText("Captain").waitFor();
      await nadia.page.getByRole("heading", { name: "Invite somebody" }).waitFor({ state: "detached" });
      // She is an ordinary member now, and can leave: for herself and, as guardian, for Mei.
      await roster(nadia.page).locator("li").filter({ hasText: "Nadia" }).getByRole("button", { name: "Leave" }).waitFor();
    });
    await s.step(ben, "is the captain now, on his phone: he invites, settles and is told so by email", async () => {
      await ben.page.reload();
      await ben.page.getByRole("heading", { name: "Invite somebody" }).waitFor();
      await ben.page.getByRole("heading", { name: "Team details" }).waitFor();
      await emailed(owner, "platform", ben.email, new RegExp(`^You are now captain of ${teamName}$`));
      expect(await fitsScreen(ben.page)).toBeLessThanOrEqual(0);
    });

    await s.step(chloe, "leaves the team from its page", async () => {
      await chloe.page.goto(`${url}/teams/${teamId}`);
      await roster(chloe.page).locator("li").filter({ hasText: "Chloe" }).getByRole("button", { name: "Leave" }).click();
      // No longer a member: the team is public now, so she sees its name and no roster.
      await chloe.page.getByText("This team's name is public. Nothing else about it is.").waitFor();
      expect(await chloe.page.getByRole("heading", { name: "Members" }).count()).toBe(0);
    });
    await s.step(ben, "has Chloe off the roster, and is told she left", async () => {
      await ben.page.reload();
      await roster(ben.page).getByText("Nadia").waitFor();
      expect(await roster(ben.page).getByText("Chloe").count()).toBe(0);
      await emailed(owner, "platform", ben.email, new RegExp(`^Chloe left ${teamName}$`));
      // Chloe is gone; the captain, now Ben, is the one who sees the children's names, as the documents say.
      expect(Object.keys(await rosterIds(ben, teamId)).sort()).toEqual(["Ben", "Hana", "Mei", "Nadia"]);
    });
  });

  scenario("Teams 2: starting a team and inviting somebody by email, with the keyboard alone", async (s) => {
    const kamal = await adult(s, "Kamal");
    const teamName = `Kamal's Keyboard Club ${RUN}`;
    await s.step(kamal, "reaches the form by Tab, in reading order, each field named by its label", async () => {
      await kamal.page.goto(`${url}/teams`);
      await kamal.page.getByRole("heading", { name: "My teams" }).waitFor();
      await kamal.page.getByText("You are not on a team yet.").waitFor();
      await kamal.page.waitForLoadState("networkidle");
      const presses = await tabTo(kamal.page, 'input[name="teamName"]');
      expect(presses).toBeLessThanOrEqual(30);
      expect(await kamal.page.evaluate(() => (document.activeElement as HTMLInputElement).labels?.[0]?.textContent)).toContain("Team name");
    });
    await s.step(kamal, "a name too short is not sent: the form says so and keeps the focus", async () => {
      await kamal.page.keyboard.type("Km");
      await kamal.page.keyboard.press("Enter");
      expect(await kamal.page.evaluate(() => (document.activeElement as HTMLInputElement).validity.tooShort)).toBe(true);
      expect(kamal.page.url()).toBe(`${url}/teams`);
      await kamal.page.keyboard.press("Backspace");
      await kamal.page.keyboard.press("Backspace");
      await kamal.page.keyboard.type(teamName);
    });
    await s.step(kamal, "goes on to the sport, the publish box and the button, in that order", async () => {
      await kamal.page.keyboard.press("Tab");
      expect(await kamal.page.evaluate(() => (document.activeElement as HTMLSelectElement).labels?.[0]?.textContent)).toContain("Sport");
      expect(await kamal.page.evaluate(() => (document.activeElement as HTMLSelectElement).value)).toBe("badminton");
      await kamal.page.keyboard.press("Tab");
      expect(await kamal.page.evaluate(() => (document.activeElement as HTMLInputElement).type)).toBe("checkbox");
      // Left alone: a team is not public unless its captain says so.
      expect(await kamal.page.evaluate(() => (document.activeElement as HTMLInputElement).checked)).toBe(false);
      await kamal.page.keyboard.press("Tab");
      expect(await kamal.page.evaluate(() => document.activeElement?.textContent)).toBe("Start a team");
      await kamal.page.keyboard.press("Enter");
      await kamal.page.waitForURL(/\/teams\/\d+$/);
      await kamal.page.getByRole("heading", { name: new RegExp(teamName) }).waitFor();
    });
    await s.step(kamal, "invites somebody by email, again by keyboard: Enter in the field sends it, and the answer is announced", async () => {
      await kamal.page.waitForLoadState("networkidle");
      await tabTo(kamal.page, 'input[name="inviteEmail"]');
      await kamal.page.keyboard.type(`kb-invite-${RUN}@uat.mysenam.test`);
      await kamal.page.keyboard.press("Enter");
      await kamal.page.getByRole("status").filter({ hasText: "Invitation sent. It can be used once and runs out in 14 days." }).waitFor();
      await kamal.page.getByText(/by email · until/).waitFor();
      // The invitations out can be withdrawn with the keyboard too.
      await tabTo(kamal.page, "button");
      await kamal.page.getByRole("button", { name: "Withdraw" }).focus();
      await kamal.page.keyboard.press("Enter");
      await kamal.page.getByText(/by email · until/).waitFor({ state: "detached" });
    });
  });

  logScenario("Teams 3: a captain enters a tournament as a team, each rostered member held to the event's age range; the typed team still works", async (s) => {
    const owner = await signInOwner(await s.actor("Platform"));
    const club = await clubVenue(owner, "Dewan Seksyen 7", 2);
    const manager = await staffApi(await s.actor("Manager"), club.manager.email);
    const date = dayAhead(24);
    const made = await manager.api("POST", "/api/admin/tournaments", {
      venueId: club.venueId,
      courtIds: club.courtIds,
      name: `Inter-club Cup ${RUN}`,
      sport: "badminton",
      format: "knockout",
      teamSize: 1,
      entryKind: "team",
      roster: { min: 2, max: 4 },
      ageMin: 18,
      ageMax: 40,
      entryFee: 0,
      maxEntries: 8,
      startsOn: date,
      endsOn: date,
      startHour: 9,
      endHour: 18,
      resultsBy: "staff",
    });
    if (made.status !== 201) throw new Error(`tournament: ${JSON.stringify(made.body)}`);
    const tournamentId = (made.body.tournament as { id: number }).id;
    const tournament = `${url}/tournaments/${tournamentId}`;

    const captain = await adult(s, "Sofia");
    const ben = await adult(s, "Ben", "phone");
    const dara = await adult(s, "Dara", "phone");
    const eli = await adult(s, "Eli", "phone");
    const team = await makeTeam(captain, `Pasukan Seksyen 7 ${RUN}`, [ben, dara, eli], { declare: { Ben: { birthDate: "1995-05-05" }, Dara: { birthDate: "1950-02-02" } } });
    const ids = await rosterIds(captain, team.id);
    expect((await captain.api("POST", `/api/teams/${team.id}`, { action: "details", memberId: ids.Sofia, birthDate: "1990-01-01" })).status).toBe(200);

    const entry = (page: Page) => page.locator("form").filter({ has: page.getByRole("heading", { name: "Enter a team you captain" }) });
    const pick = async (names: string[]) => {
      await captain.page.goto(tournament);
      const form = entry(captain.page);
      await form.getByRole("heading", { name: "Enter a team you captain" }).waitFor();
      await form.locator('select[name="enterTeamId"]').selectOption({ label: team.name });
      for (const n of ["Sofia", "Ben", "Dara", "Eli"]) {
        const box = form.getByLabel(n, { exact: true });
        await box.waitFor();
        if (names.includes(n)) await box.check();
      }
      await form.getByRole("button", { name: "Enter", exact: true }).click();
    };
    const entered = async () => ((await captain.api("GET", `/api/tournaments/${tournamentId}`)).body.tournament as { entries?: { name: string }[] }).entries?.map((e) => e.name) ?? [];

    await s.step(captain, "picks Dara, who said she was born in 1950: refused with her name and the age range, nothing entered", async () => {
      await pick(["Sofia", "Ben", "Dara"]);
      await captain.page.getByRole("alert").getByText(/Dara Tester is \d+ on \d{4}-\d{2}-\d{2}: this is for ages .*18.*40/).waitFor();
      expect(await entered()).toEqual([]);
    });
    await s.step(captain, "picks Eli, who has not said a date of birth: refused with why", async () => {
      await pick(["Sofia", "Ben", "Eli"]);
      await captain.page.getByRole("alert").getByText(/Eli Tester has not given a date of birth, which this event's age range \(.*18.*40.*\) needs\./).waitFor();
      expect(await entered()).toEqual([]);
    });
    await s.step(eli, "says his own date of birth on the team's page, on his phone: his word, shown to nobody", async () => {
      await eli.page.goto(`${url}/teams/${team.id}`);
      await eli.page.getByText("Only so an event's age range can be checked: it is your word, not checked, and shown to nobody.").waitFor();
      await eli.page.getByLabel("Date of birth").fill("1998-08-08");
      await eli.page.getByRole("button", { name: "Save", exact: true }).click();
      await eli.page.getByRole("status").filter({ hasText: "Saved." }).waitFor();
      await eli.page.reload();
      await eli.page.getByText("A date is saved.").waitFor();
      expect(await said(eli.page)).not.toContain("1998");
      expect(await fitsScreen(eli.page)).toBeLessThanOrEqual(0);
    });
    await s.step(captain, "enters the team with the three who fit the range, and is entered", async () => {
      await pick(["Sofia", "Ben", "Eli"]);
      await captain.page.getByText("You're entered").waitFor();
      expect(await entered()).toEqual([team.name]);
    });
    await s.step(ben, "is on the roster, and told so by email", async () => {
      await emailed(manager, club.venueId, ben.email, new RegExp(`^You are on the roster for Inter-club Cup ${RUN}$`));
      await emailed(manager, club.venueId, eli.email, new RegExp(`^You are on the roster for Inter-club Cup ${RUN}$`));
    });
    await s.step(captain, "cannot enter the same team twice", async () => {
      const again = await captain.api("POST", `/api/tournaments/${tournamentId}`, { action: "enter", teamId: team.id, rosterMemberIds: [ids.Sofia, ids.Ben] });
      expect(again.status).toBeGreaterThanOrEqual(400);
      expect(await entered()).toEqual([team.name]);
    });

    const typed = await signUp(await s.actor("Typed"), { profile: { adult: true } });
    await s.step(typed, "has no team to pick: the typed team and roster form is all there is, and still works", async () => {
      await typed.page.goto(tournament);
      await typed.page.getByLabel("Team name").waitFor();
      expect(await typed.page.getByRole("heading", { name: "Enter a team you captain" }).count()).toBe(0);
      await typed.page.getByLabel("Team name").fill(`Kelab Typed ${RUN}`);
      await typed.page.getByLabel(/^Players, one a line/).fill("Ali Bin Abu\nBala Raj\nChong Wei");
      await typed.page.getByLabel("Date of birth").fill("1992-06-06");
      await typed.page.getByLabel(/^Everybody on the roster is within these ages/).check();
      await typed.page.getByRole("button", { name: "Enter", exact: true }).click();
      await typed.page.getByText("You're entered").waitFor();
    });

    const visitor = await s.actor("Visitor", "phone");
    await s.step(visitor, "reads the tournament's page: the teams by the name they entered under, no member", async () => {
      await visitor.page.goto(tournament);
      await visitor.page.getByRole("heading", { name: new RegExp(`Inter-club Cup ${RUN}`) }).waitFor();
      await visitor.page.getByText(team.name).first().waitFor();
      const page = await said(visitor.page);
      for (const hidden of ["Sofia", "Ben", "Dara", "Eli", "Ali Bin Abu", "Bala Raj"]) expect(page).not.toContain(hidden);
      const api = JSON.stringify((await visitor.api("GET", `/api/tournaments/${tournamentId}`)).body);
      for (const hidden of ["Sofia", "Ben ", "Dara", "Eli", "Ali Bin Abu"]) expect(api).not.toContain(hidden);
      expect(await fitsScreen(visitor.page)).toBeLessThanOrEqual(0);
    });
  });
});

