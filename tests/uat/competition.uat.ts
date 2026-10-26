import { describe, expect } from "vitest";
import type { Page } from "playwright-core";
import { dayAhead, scenario, signInOwner, signUp, url, type Actor, type Scenario } from "./harness";

/**
 * Tournaments as their organisers run them, with the players, an official,
 * the front desk and the public each in a browser of their own: a
 * competition and its divisions set up from a sport's template on the
 * dashboard; entries, closing them and the draw, with the fixtures the
 * public sees on courts that never clash; results entered by the desk and
 * by an official through a link, winners going through to the final and
 * the third-place match, and the tournament finishing; and a result
 * corrected after the knockout has moved past it, kept on the record, the
 * tournament under review and not finishing until the organiser resolves it.
 *
 * Each scenario has a venue of its own with badminton courts, made by
 * the platform's owner with its manager and front desk (setup, not the
 * subject), so its held court time touches no other scenario's bookings.
 * Players and the draw go through the API only where they are not what
 * the scenario is about.
 */

const PASSWORD = "an organiser's long password";

interface Venue {
  venueId: number;
  name: string;
  courtIds: number[];
  manager: string;
  desk: string;
}

interface Match {
  id: number;
  stage: string;
  round: number;
  position: number;
  placement: number | null;
  a: number | null;
  b: number | null;
  winner: number | null;
  status: string;
  score: string | null;
  date: string | null;
  minute: number | null;
  minutes: number;
  courtId: number | null;
  courtName: string | null;
}

interface Detail {
  id: number;
  name: string;
  status: string;
  entries: { id: number; name: string; status: string }[];
  matches: Match[];
  issues: { id: number; status: string; wrongEntry: number; rightEntry: number | null }[];
}

/** A live venue with badminton courts (two unless said), a manager and a front-desk account. */
async function badmintonVenue(owner: Actor, label: string, courts = 2): Promise<Venue> {
  const stamp = Date.now().toString(36);
  const name = `${label} ${stamp}`;
  const made = await owner.api("POST", "/api/admin/venues", { name, area: "Shah Alam", address: "8 Jalan Kristal 7/71, Shah Alam", phone: "03-5510 7000" });
  if (made.status !== 201) throw new Error(`venue: ${JSON.stringify(made.body)}`);
  const venueId = (made.body.venue as { id: number }).id;
  const courtIds: number[] = [];
  for (const court of Array.from({ length: courts }, (_, i) => `Court ${i + 1}`)) {
    const c = await owner.api("POST", "/api/admin/courts", { venueId, sport: "badminton", name: court, offPeakRate: 15, peakRate: 22, capacity: 1, deposit: 0 });
    if (c.status >= 300) throw new Error(`court: ${JSON.stringify(c.body)}`);
    courtIds.push(((c.body.courts as { id: number }[] | undefined)?.[0] ?? (c.body.court as { id: number })).id);
  }
  const staff: Record<"manager" | "desk", string> = { manager: `organiser-${stamp}@uat.mysenam.test`, desk: `desk-${stamp}@uat.mysenam.test` };
  for (const role of ["manager", "desk"] as const) {
    const r = await owner.api("POST", "/api/admin/admins", { name: role === "manager" ? `${label} Organiser` : `${label} Desk`, email: staff[role], password: PASSWORD, venueId, role });
    if (r.status >= 300) throw new Error(`${role}: ${JSON.stringify(r.body)}`);
  }
  return { venueId, name, courtIds, ...staff };
}

/** Signed in to the dashboard on its page, on the Tournaments tab; every confirmation the screen asks is answered yes. */
async function staffOnTournaments(a: Actor, email: string) {
  a.page.on("dialog", (d) => void d.accept());
  await a.page.goto(`${url}/admin`);
  await a.page.getByLabel("Email").fill(email);
  await a.page.getByLabel("Password").fill(PASSWORD);
  await a.page.getByRole("button", { name: "Sign in" }).click();
  await a.page.getByRole("button", { name: /sign out/i }).waitFor({ timeout: 15_000 });
  await a.page.getByRole("button", { name: "Tournaments", exact: true }).click();
  await a.page.getByRole("heading", { name: "Tournaments", exact: true }).waitFor();
}

/** A tournament opened from the dashboard's list. */
async function openTournament(page: Page, name: string) {
  await page.locator("li").filter({ hasText: name }).getByRole("button", { name: "Open", exact: true }).click();
  await page.getByRole("heading", { name: new RegExp(`^${name}`) }).waitFor();
}

/** A fixture on the dashboard's list of matches, by who plays in it. */
function staffRow(page: Page, a: string, b: string) {
  return page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Matches", exact: true }) })
    .locator("li")
    .filter({ hasText: a })
    .filter({ hasText: b });
}

/** A result entered on the dashboard: the score, side A's first, then who won. */
async function enterOnDashboard(page: Page, a: string, b: string, score: string, winner: string) {
  const row = staffRow(page, a, b);
  await row.getByPlaceholder("21-15, 18-21, 21-10").fill(score);
  await row.getByRole("button", { name: `${winner.split(" ")[0]} won`, exact: true }).click();
  await row.getByText(`✓ ${score}`).waitFor();
}

/** A fixture on the public page's list of matches, by who plays in it. */
function publicRow(page: Page, a: string, b: string) {
  return page
    .locator("section")
    .filter({ has: page.getByRole("heading", { name: "Matches", exact: true }) })
    .locator("li")
    .filter({ hasText: `${a} v ${b}` });
}

const clock = (minute: number) => `${Math.floor(minute / 60) % 12 === 0 ? 12 : Math.floor(minute / 60) % 12}:${String(minute % 60).padStart(2, "0")} ${minute < 720 ? "AM" : "PM"}`;

/** The score of a straight win for `winner`, written from side A's view as every score is. */
const straightWin = (m: Match, winner: number | null, games = ["21-15", "21-17"]) =>
  (winner === m.a ? games : games.map((g) => g.split("-").reverse().join("-"))).join(", ");

async function publicDetail(id: number): Promise<Detail> {
  const res = await fetch(`${url}/api/tournaments/${id}`);
  return ((await res.json()) as { tournament: Detail }).tournament;
}

/**
 * A knockout of four players with a third-place match, results by staff,
 * entered and drawn through the API (setup): who plays whom is read from
 * the draw, as the organiser would read it.
 */
async function drawnKnockout(s: Scenario, manager: Actor, venue: Venue, day: number, names: string[]) {
  const date = dayAhead(day);
  const made = await manager.api("POST", "/api/admin/tournaments", {
    venueId: venue.venueId,
    courtIds: venue.courtIds,
    name: `Shah Alam Open ${date}`,
    sport: "badminton",
    template: "racket_best_of_3",
    format: "knockout",
    teamSize: 1,
    entryFee: 0,
    maxEntries: 8,
    startsOn: date,
    endsOn: date,
    startMin: 9 * 60,
    endMin: 14 * 60,
    matchMinutes: 40,
    resultsBy: "staff",
    thirdPlace: true,
  });
  if (made.status !== 201) throw new Error(`tournament: ${JSON.stringify(made.body)}`);
  const id = (made.body.tournament as { id: number }).id;
  const players: Actor[] = [];
  for (const n of names) {
    const p = await signUp(await s.actor(n));
    const r = await p.api("POST", `/api/tournaments/${id}`, { action: "enter" });
    if (r.status !== 201) throw new Error(`entry for ${n}: ${JSON.stringify(r.body)}`);
    players.push(p);
  }
  for (const action of ["close", "draw"]) {
    const r = await manager.api("POST", `/api/admin/tournaments/${id}`, { action });
    if (r.status !== 200) throw new Error(`${action}: ${JSON.stringify(r.body)}`);
  }
  const d = await publicDetail(id);
  const semis = d.matches.filter((m) => m.stage === "knockout" && m.round === 1).sort((a, b) => a.position - b.position);
  const name = (entry: number | null) => d.entries.find((e) => e.id === entry)!.name;
  return {
    id,
    name: d.name,
    date,
    players,
    entryName: name,
    semis,
    finalId: d.matches.find((m) => m.round === 2 && m.placement === null)!.id,
    thirdId: d.matches.find((m) => m.placement === 3)!.id,
  };
}

/**
 * No two matches on one court at once, and nobody (by name) on court twice at
 * once. A match still to be decided may be played by anybody who could reach
 * it (`could`): within its own division the draw keeps those apart by the
 * bracket, so it is held to them only against the other division's matches.
 */
function expectNoClashes(matches: (Match & { division: number; players: string[]; could: string[] })[]) {
  const end = (m: Match) => m.minute! + m.minutes;
  for (const x of matches)
    for (const y of matches) {
      if (x === y || x.date !== y.date || !(x.minute! < end(y) && y.minute! < end(x))) continue;
      expect(x.courtId, `${x.id} and ${y.id} share a court at once`).not.toBe(y.courtId);
      const [xs, ys] = x.division === y.division ? [x.players, y.players] : [x.could, y.could];
      expect(xs.filter((p) => ys.includes(p)), `${x.id} and ${y.id} share a player at once`).toEqual([]);
    }
}

describe("tournaments, run by their organisers", () => {
  scenario("Tournament 3: a manager sets up a competition and two divisions from the badminton template; another venue's manager cannot see or run it", async (s) => {
    const owner = await signInOwner(await s.actor("Owner"));
    const venue = await badmintonVenue(owner, "Dewan Seksyen 7");
    const other = await badmintonVenue(owner, "Dewan Kota Kemuning");
    const date = dayAhead(30);
    const stamp = Date.now().toString(36);
    const compName = `Club Championships ${stamp}`;

    const organiser = await s.actor("Organiser");
    const page = organiser.page;
    await s.step(organiser, "signs in and sets up a competition with divisions, holding both courts on its day", async () => {
      await staffOnTournaments(organiser, venue.manager);
      const comp = page.locator("details").filter({ hasText: "Set up a competition with divisions" });
      await comp.getByText("Set up a competition with divisions").click();
      await comp.getByLabel("Name", { exact: true }).fill(compName);
      await comp.getByLabel("First day").fill(date);
      await comp.getByLabel("Last day").fill(date);
      await comp.getByLabel("From", { exact: true }).fill("09:00");
      await comp.getByLabel("Until", { exact: true }).fill("13:00");
      await comp.getByLabel("Each match (minutes)").fill("30");
      await comp.getByLabel("Divisions per player (optional)").fill("2");
      await comp.getByRole("button", { name: "Set it up and hold the courts" }).click();
      const listed = page.locator("section").filter({ has: page.getByRole("heading", { name: "Competitions" }) }).locator("li").filter({ hasText: compName });
      await listed.getByText(`${date}, 9:00 AM–1:00 PM · 0 division(s) · up to 2 per player`).waitFor();
    });

    const form = page.locator("form").filter({ has: page.getByRole("heading", { name: "Set up a tournament" }) });
    await s.step(organiser, "adds Open Singles: a knockout from the best-of-three template, with a third-place match and a longer final", async () => {
      await form.getByLabel("Part of").selectOption({ label: `A division of ${compName}` });
      await form.getByText(`Played in ${compName}'s time`).waitFor();
      await form.getByLabel("Name", { exact: true }).fill("Open Singles");
      // Badminton starts from its own template, which says it is club practice, not a governing body's.
      expect(await form.getByLabel("Starting from").inputValue()).toBe("racket_best_of_3");
      await form.getByText("Templates are common club practice, not a governing body's regulations", { exact: false }).waitFor();
      await form.getByLabel("Format").selectOption({ label: "Knockout" });
      await form.getByLabel("Who enters").selectOption({ label: "Singles (one player)" });
      await form.getByLabel(/^Entry fee/).fill("0");
      await form.getByLabel("Most entries").fill("8");
      await form.getByLabel("This division's matches (minutes)").fill("30");
      await form.getByText("Match lengths by stage, third-place match").click();
      await form.getByLabel("Final", { exact: true }).fill("45");
      await form.getByLabel(/^Third-place match/).check();
      await form.getByLabel("Results entered by").selectOption({ label: "Staff (and officials you give a link)" });
      await form.getByRole("button", { name: "Set it up and hold the courts" }).click();
      await page.locator("li").filter({ hasText: "Open Singles" }).filter({ hasText: compName }).getByText("0/8 entered").waitFor();
    });

    await s.step(organiser, "adds Veterans Singles: a round robin for 40 and over, one game each, walkovers and retirements counted as it says", async () => {
      await form.getByLabel("Part of").selectOption({ label: `A division of ${compName}` });
      await form.getByLabel("Name", { exact: true }).fill("Veterans Singles");
      await form.getByLabel("Starting from").selectOption({ label: "Best of three games (badminton, pickleball)" });
      await form.getByLabel("Format").selectOption({ label: "Round robin (everybody plays everybody)" });
      await form.getByLabel("Most entries").fill("6");
      await form.getByLabel("This division's matches (minutes)").fill("20");
      await form.getByLabel("Youngest age").fill("40");
      await form.getByText("Entrants declare their date of birth", { exact: false }).waitFor();
      await form.getByText("Scoring and ranking", { exact: true }).click();
      await form.getByLabel(/^Best of/).selectOption("1");
      await form.getByLabel("A retirement's score, as it stood").selectOption({ label: "Counts as played in the differences" });
      await form.getByLabel(/^A walkover counts as/).fill("21-0");
      await form.getByLabel(/^A walkover counts as/).press("Tab");
      await form.getByRole("button", { name: "Set it up and hold the courts" }).click();
      await page.locator("li").filter({ hasText: "Veterans Singles" }).filter({ hasText: compName }).getByText("0/6 entered").waitFor();
      await page.locator("li").filter({ hasText: compName }).getByText(/2 division\(s\)/).waitFor();
    });

    const vetsId = await s.step(organiser, "opens Veterans Singles and finds its rules as set, still changeable until the draw", async () => {
      await openTournament(page, "Veterans Singles");
      await page.getByText("They can be changed until the draw.").waitFor();
      await page.getByText("Scoring and ranking (from the template racket_best_of_3)").click();
      expect(await page.getByLabel(/^Best of/).inputValue()).toBe("1");
      expect(await page.getByLabel("A retirement's score, as it stood").inputValue()).toBe("as_played");
      expect(await page.getByLabel(/^A walkover counts as/).inputValue()).toBe("21-0");
      const href = await page.getByRole("link", { name: "public page ↗" }).getAttribute("href");
      return Number(/\/tournaments\/(\d+)/.exec(href ?? "")![1]);
    });

    const visitor = await s.actor("Visitor", "phone");
    await s.step(visitor, "opens the division's public page without an account: the competition, the ages asked and a sign-in to enter", async () => {
      await visitor.page.goto(`${url}/tournaments/${vetsId}`);
      await visitor.page.getByRole("heading", { name: /Veterans Singles/ }).waitFor();
      await visitor.page.getByText(`A division of ${compName}`).waitFor();
      await visitor.page.getByText(`Ages 40 and over on ${date}`, { exact: false }).waitFor();
      await visitor.page.getByText(/round robin/).first().waitFor();
      await visitor.page.getByRole("link", { name: "Sign in to enter" }).waitFor();
    });

    const rival = await s.actor("Rival");
    await s.step(rival, "manages another venue: its Tournaments tab shows none of these, and the tournament's own address is refused", async () => {
      await staffOnTournaments(rival, other.manager);
      await rival.page.getByText("None yet. Set one up below.").waitFor();
      expect(await rival.page.getByText(compName).count()).toBe(0);
      expect((await rival.api("GET", `/api/admin/tournaments/${vetsId}`)).status).toBe(403);
      expect((await rival.api("GET", `/api/admin/tournaments?venueId=${venue.venueId}`)).status).toBe(403);
      expect((await rival.api("POST", `/api/admin/tournaments/${vetsId}`, { action: "draw" })).status).toBe(403);
      expect((await rival.api("POST", `/api/admin/tournaments/${vetsId}`, { action: "cancel" })).status).toBe(403);
      // Nor can it put a division into this venue's competition.
      const r = await rival.api("POST", "/api/admin/tournaments", { venueId: venue.venueId, name: "Gatecrash", sport: "badminton", format: "knockout", teamSize: 1, entryFee: 0, maxEntries: 8, startsOn: date, endsOn: date, startHour: 9, endHour: 13, courtIds: venue.courtIds });
      expect(r.status).toBe(403);
    });
  });

  scenario("Tournament 4: players enter two divisions, the organiser closes entries and makes the draws; the public sees the fixtures, on courts with no clashes", async (s) => {
    const owner = await signInOwner(await s.actor("Owner"));
    const venue = await badmintonVenue(owner, "Dewan Seksyen 13", 3);
    const date = dayAhead(31);
    const organiser = await s.actor("Organiser");
    await staffOnTournaments(organiser, venue.manager);

    // The competition and its divisions (setup; Tournament 3 sets them up on the page).
    const compName = `Shah Alam Championships ${Date.now().toString(36)}`;
    const comp = await organiser.api("POST", "/api/admin/competitions", { venueId: venue.venueId, name: compName, sport: "badminton", startsOn: date, endsOn: date, startMin: 9 * 60, endMin: 13 * 60, matchMinutes: 30, courtIds: venue.courtIds });
    if (comp.status !== 201) throw new Error(`competition: ${JSON.stringify(comp.body)}`);
    const competitionId = (comp.body.competition as { id: number }).id;
    const division = async (name: string, extra: Record<string, unknown>) => {
      const r = await organiser.api("POST", "/api/admin/tournaments", { venueId: venue.venueId, competitionId, name, sport: "badminton", template: "racket_best_of_3", teamSize: 1, entryFee: 0, maxEntries: 8, matchMinutes: 30, ...extra });
      if (r.status !== 201) throw new Error(`division ${name}: ${JSON.stringify(r.body)}`);
      return (r.body.tournament as { id: number }).id;
    };
    const openId = await division("Open Singles", { format: "knockout", thirdPlace: true });
    const vetsId = await division("Veterans Singles", { format: "round_robin", ageMin: 40 });

    // Hafiz and Kumar play both divisions: the draw must never have them on court twice at once.
    const [aishah, bryan, hafiz, kumar, lim] = await Promise.all(["Aishah", "Bryan", "Hafiz", "Kumar", "Lim"].map(async (n) => signUp(await s.actor(n))));
    for (const p of [aishah, bryan, hafiz, kumar])
      await s.step(p, "enters Open Singles on its page", async () => {
        await p.page.goto(`${url}/tournaments/${openId}`);
        await p.page.getByText("A division of", { exact: false }).waitFor();
        await p.page.getByRole("button", { name: "Enter", exact: true }).click();
        await p.page.getByText(`You're entered: ${p.name} Tester`).waitFor();
      });
    for (const p of [hafiz, kumar, lim])
      await s.step(p, "enters Veterans Singles, declaring their date of birth as it asks", async () => {
        await p.page.goto(`${url}/tournaments/${vetsId}`);
        await p.page.getByLabel("Your date of birth").fill("1978-05-14");
        await p.page.getByRole("button", { name: "Enter", exact: true }).click();
        await p.page.getByText(`You're entered: ${p.name} Tester`).waitFor();
      });

    await s.step(organiser, "finds four entered in Open Singles and closes its entries", async () => {
      await organiser.page.reload();
      await organiser.page.getByRole("button", { name: "Tournaments", exact: true }).click();
      await openTournament(organiser.page, "Open Singles");
      await organiser.page.getByRole("heading", { name: "Entries (4 of 8)" }).waitFor();
      for (const p of [aishah, bryan, hafiz, kumar]) await organiser.page.getByRole("cell", { name: `${p.name} Tester` }).waitFor();
      await organiser.page.getByRole("button", { name: "Close entries" }).click();
      await organiser.page.getByRole("heading", { name: /Open Singles · closed/ }).waitFor();
    });

    const late = await signUp(await s.actor("Late"));
    await s.step(late, "comes too late: the page says entries are closed and offers no way in", async () => {
      await late.page.goto(`${url}/tournaments/${openId}`);
      await late.page.getByText("Entries closed", { exact: false }).waitFor();
      expect(await late.page.getByRole("button", { name: "Enter", exact: true }).count()).toBe(0);
      const r = await late.api("POST", `/api/tournaments/${openId}`, { action: "enter" });
      expect(r.status).toBeGreaterThanOrEqual(400);
    });

    await s.step(organiser, "makes Open Singles' draw: two semi-finals, the final and the third-place match, each on a court at a time", async () => {
      await organiser.page.getByRole("button", { name: "Make the draw" }).click();
      await organiser.page.getByRole("heading", { name: /Open Singles · drawn/ }).waitFor();
      const matches = organiser.page.locator("section").filter({ has: organiser.page.getByRole("heading", { name: "Matches", exact: true }) }).locator("li");
      await matches.first().waitFor();
      expect(await matches.count()).toBe(4);
      await matches.filter({ hasText: "Third-place match" }).waitFor();
      expect(await matches.filter({ hasText: date }).filter({ hasText: /Court [123]/ }).count()).toBe(4);
    });

    await s.step(organiser, "goes back and makes the Veterans' draw straight from open: everybody plays everybody", async () => {
      await organiser.page.getByRole("button", { name: "← All tournaments" }).click();
      await openTournament(organiser.page, "Veterans Singles");
      await organiser.page.getByRole("button", { name: "Make the draw" }).click();
      await organiser.page.getByRole("heading", { name: /Veterans Singles · drawn/ }).waitFor();
      await organiser.page.getByText("Fixed since the draw.").waitFor();
      const matches = organiser.page.locator("section").filter({ has: organiser.page.getByRole("heading", { name: "Matches", exact: true }) }).locator("li");
      await matches.first().waitFor();
      expect(await matches.count()).toBe(3);
    });

    const visitor = await s.actor("Visitor", "phone");
    const [open, vets] = [await publicDetail(openId), await publicDetail(vetsId)];
    const nameOf = (d: Detail, id: number | null) => (id === null ? null : d.entries.find((e) => e.id === id)!.name);
    await s.step(visitor, "opens Open Singles without an account: the bracket and the actual fixtures, when and on which court", async () => {
      await visitor.page.goto(`${url}/tournaments/${openId}`);
      await visitor.page.getByText("Draw made", { exact: false }).waitFor();
      await visitor.page.getByText("Semi-finals", { exact: true }).waitFor();
      await visitor.page.getByText("Final", { exact: true }).waitFor();
      await visitor.page.getByText("Third place", { exact: true }).waitFor();
      for (const m of open.matches.filter((x) => x.round === 1)) {
        const row = publicRow(visitor.page, nameOf(open, m.a)!, nameOf(open, m.b)!);
        await row.getByText(`${m.date} ${clock(m.minute!)}, ${m.courtName}`).waitFor();
      }
      // The final and the third-place match have their time and court, their players to be decided.
      expect(await visitor.page.locator("li").filter({ hasText: "To be decided v To be decided" }).count()).toBe(2);
    });

    await s.step(visitor, "opens Veterans Singles: its three matches, who plays whom and when", async () => {
      await visitor.page.goto(`${url}/tournaments/${vetsId}`);
      await visitor.page.getByText("Group 1", { exact: true }).waitFor();
      for (const m of vets.matches) await publicRow(visitor.page, nameOf(vets, m.a)!, nameOf(vets, m.b)!).getByText(`${m.date} ${clock(m.minute!)}, ${m.courtName}`).waitFor();
    });

    await s.step(visitor, "and nothing clashes: no court has two matches at once, Hafiz and Kumar are never on court twice at once, and no match's court time is on sale", async () => {
      const all = [open, vets].flatMap((d) =>
        d.matches
          .filter((m) => m.date !== null)
          .map((m) => {
            const players = [nameOf(d, m.a), nameOf(d, m.b)].filter((x): x is string => x !== null);
            // The final and the third-place match: anybody in the division may yet play them.
            return { ...m, division: d.id, players, could: m.a === null || m.b === null ? d.entries.map((e) => e.name) : players };
          })
      );
      expect(all).toHaveLength(7);
      for (const m of all) {
        expect(m.date).toBe(date);
        expect(venue.courtIds).toContain(m.courtId);
        expect(m.minute! >= 9 * 60 && m.minute! + m.minutes <= 13 * 60, `match ${m.id} within the competition's hours`).toBe(true);
      }
      // The final and the third-place match are after both semi-finals, whoever plays them.
      const semisEnd = Math.max(...open.matches.filter((m) => m.round === 1).map((m) => m.minute! + m.minutes));
      for (const m of open.matches.filter((x) => x.round === 2)) expect(m.minute!).toBeGreaterThanOrEqual(semisEnd);
      expectNoClashes(all);
      // What a customer would be offered on the venue's page that day: none of it inside a match.
      const res = await visitor.api("GET", `/api/availability?venueId=${venue.venueId}&date=${date}&sport=badminton`);
      const availability = (res.body.availability as { court: { id: number }; starts: { minute: number; maxLength: number }[] }[]) ?? [];
      for (const m of all) {
        const starts = availability.find((c) => c.court.id === m.courtId)?.starts ?? [];
        for (const st of starts) expect(st.minute < m.minute! + m.minutes && st.minute + st.maxLength > m.minute!, `court ${m.courtId} offered at ${st.minute} over match ${m.id}`).toBe(false);
      }
    });
  });

  scenario("Tournament 5: the front desk and an official enter results; winners reach the final, losers the third-place match, and it finishes", async (s) => {
    const owner = await signInOwner(await s.actor("Owner"));
    const venue = await badmintonVenue(owner, "Dewan Seksyen 9");
    const organiser = await s.actor("Organiser");
    await staffOnTournaments(organiser, venue.manager);
    const t = await drawnKnockout(s, organiser, venue, 32, ["Farah", "Gopal", "Irfan", "Jia"]);
    const [sf1, sf2] = t.semis;
    const n = t.entryName;
    const player = t.players.find((p) => `${p.name} Tester` === n(sf1.a))!;

    await s.step(player, "sees their semi-final on the page, with no way to enter a result the venue's staff enter, nor the dashboard's", async () => {
      await player.page.goto(`${url}/tournaments/${t.id}`);
      await publicRow(player.page, n(sf1.a), n(sf1.b)).waitFor();
      expect(await player.page.getByText("Report the result").count()).toBe(0);
      const report = await player.api("POST", `/api/tournaments/${t.id}`, { action: "report", matchId: sf1.id, winner: sf1.a, score: "21-0, 21-0" });
      expect(report.status).toBeGreaterThanOrEqual(400);
      const staff = await player.api("POST", `/api/admin/tournaments/${t.id}/matches/${sf1.id}`, { winner: sf1.a, score: "21-0, 21-0" });
      expect(staff.status).toBe(401);
    });

    const link = await s.step(organiser, "gives the referee a link of their own, shown once", async () => {
      await organiser.page.reload();
      await organiser.page.getByRole("button", { name: "Tournaments", exact: true }).click();
      await openTournament(organiser.page, t.name);
      await organiser.page.getByPlaceholder("Official's name").fill("Encik Rahman");
      await organiser.page.getByRole("button", { name: "Give an official a link" }).click();
      await organiser.page.getByText("Send this link to the official now", { exact: false }).waitFor();
      const shown = await organiser.page.getByText(/\/officials\/[A-Za-z0-9_-]+/).textContent();
      return /\/officials\/[A-Za-z0-9_-]+/.exec(shown ?? "")![0];
    });

    const referee = await s.actor("Referee", "phone");
    const sf1Score = straightWin(sf1, sf1.a);
    await s.step(referee, "opens the link on their phone, no account, and enters the first semi-final", async () => {
      await referee.page.goto(`${url}${link}`);
      await referee.page.getByRole("heading", { name: `Results for ${t.name}` }).waitFor();
      await referee.page.getByText("Entering results as Encik Rahman", { exact: false }).waitFor();
      const card = referee.page.locator("li").filter({ hasText: `${n(sf1.a)} v ${n(sf1.b)}` });
      await card.getByLabel("Who won").selectOption({ label: n(sf1.a) });
      await card.getByLabel("Score").fill(sf1Score);
      await card.getByRole("button", { name: "Send the result" }).click();
      await referee.page.getByText("Saved.").waitFor();
      expect(await referee.page.locator("li").filter({ hasText: `${n(sf1.a)} v ${n(sf1.b)}` }).count()).toBe(0);
    });

    await s.step(referee, "cannot enter that semi-final again: a result already in is the organiser's to correct", async () => {
      const r = await referee.api("POST", `/api/officials${link.slice("/officials".length)}`, { matchId: sf1.id, winner: sf1.b, score: straightWin(sf1, sf1.b) });
      expect(r.status).toBeGreaterThanOrEqual(400);
      expect(String(r.body.error)).toMatch(/has its result/);
    });

    const desk = await s.actor("Desk");
    const sf2Score = straightWin(sf2, sf2.b, ["21-19", "22-20"]);
    await s.step(desk, "signs in at the front desk and enters the second semi-final on the dashboard", async () => {
      await staffOnTournaments(desk, venue.desk);
      await openTournament(desk.page, t.name);
      await enterOnDashboard(desk.page, n(sf2.a), n(sf2.b), sf2Score, n(sf2.b));
    });

    await s.step(desk, "is refused what is a manager's: correcting a result as a correction, and calling the tournament off", async () => {
      const fix = await desk.api("POST", `/api/admin/tournaments/${t.id}/matches/${sf1.id}`, { winner: sf1.b, score: straightWin(sf1, sf1.b), correction: { mode: "standings_only", reason: "Desk thinks so", token: "x" } });
      expect(fix.status).toBe(403);
      expect((await desk.api("POST", `/api/admin/tournaments/${t.id}`, { action: "cancel" })).status).toBe(403);
    });

    const loser = t.players.find((p) => `${p.name} Tester` === n(sf1.b))!;
    await s.step(loser, "sees they are in the third-place match against the other semi-final's loser; the final is the two winners", async () => {
      await loser.page.goto(`${url}/tournaments/${t.id}`);
      await publicRow(loser.page, n(sf1.b), n(sf2.a)).waitFor();
      await publicRow(loser.page, n(sf1.a), n(sf2.b)).waitFor();
      await publicRow(loser.page, n(sf1.a), n(sf1.b)).getByText(sf1Score).waitFor();
    });

    const final = { ...sf1, id: t.finalId, a: sf1.a, b: sf2.b };
    await s.step(referee, "enters the final; the tournament is not over while the third-place match is to play", async () => {
      await referee.page.reload();
      const card = referee.page.locator("li").filter({ hasText: `${n(sf1.a)} v ${n(sf2.b)}` });
      await card.getByLabel("Who won").selectOption({ label: n(sf2.b) });
      await card.getByLabel("Score").fill(straightWin(final, final.b, ["21-18", "19-21", "21-16"]));
      await card.getByRole("button", { name: "Send the result" }).click();
      await referee.page.getByText("Saved.").waitFor();
      expect((await publicDetail(t.id)).status).toBe("drawn");
    });

    await s.step(referee, "enters the third-place match, the last one", async () => {
      const card = referee.page.locator("li").filter({ hasText: `${n(sf1.b)} v ${n(sf2.a)}` });
      await card.getByLabel("Who won").selectOption({ label: n(sf1.b) });
      await card.getByLabel("Score").fill("21-12, 21-14");
      await card.getByRole("button", { name: "Send the result" }).click();
      await referee.page.getByText("No match is waiting for a result.").waitFor();
    });

    const visitor = await s.actor("Visitor");
    await s.step(visitor, "sees it finished: the winner of the final, and the third-place match decided", async () => {
      await visitor.page.goto(`${url}/tournaments/${t.id}`);
      await visitor.page.getByText(`Winner: ${n(sf2.b)}`).waitFor();
      await visitor.page.getByText("Finished", { exact: false }).first().waitFor();
      await publicRow(visitor.page, n(sf1.b), n(sf2.a)).getByText("21-12, 21-14").waitFor();
    });

    await s.step(referee, "finds the link has stopped now the tournament is over", async () => {
      await referee.page.reload();
      await referee.page.getByText("This link no longer works. Ask the venue for a new one.").waitFor();
    });
  });

  scenario("Tournament 6: a semi-final corrected after the third-place match is played: reviewed, kept on the record, under review, and finished only when resolved", async (s) => {
    const owner = await signInOwner(await s.actor("Owner"));
    const venue = await badmintonVenue(owner, "Dewan Seksyen 24");
    const organiser = await s.actor("Organiser");
    await staffOnTournaments(organiser, venue.manager);
    const t = await drawnKnockout(s, organiser, venue, 33, ["Nadia", "Omar", "Priya", "Qistina"]);
    const [sf1, sf2] = t.semis;
    const n = t.entryName;
    const page = organiser.page;

    await s.step(organiser, "enters the first semi-final for the wrong player, and puts it right before the final is played: the final follows", async () => {
      await page.reload();
      await page.getByRole("button", { name: "Tournaments", exact: true }).click();
      await openTournament(page, t.name);
      await enterOnDashboard(page, n(sf1.a), n(sf1.b), straightWin(sf1, sf1.a), n(sf1.a));
      await staffRow(page, n(sf1.a), "to be decided").first().waitFor();
      // The scoresheet says the other side won: nothing after it has been played, so it is simply entered again.
      await enterOnDashboard(page, n(sf1.a), n(sf1.b), straightWin(sf1, sf1.b), n(sf1.b));
      await staffRow(page, n(sf1.b), "to be decided").filter({ hasText: "Knockout round 2" }).first().waitFor();
      const d = await publicDetail(t.id);
      expect(d.matches.find((m) => m.id === t.finalId)!.a).toBe(sf1.b);
      expect(d.matches.find((m) => m.id === t.thirdId)!.a).toBe(sf1.a);
    });

    const thirdScore = "21-11, 21-13";
    await s.step(organiser, "enters the second semi-final and the third-place match as they are played", async () => {
      await enterOnDashboard(page, n(sf2.a), n(sf2.b), straightWin(sf2, sf2.a), n(sf2.a));
      await enterOnDashboard(page, n(sf1.a), n(sf2.b), thirdScore, n(sf1.a));
    });

    // The referee's sheet comes in: the second semi-final was the other way round.
    const sf2Right = straightWin(sf2, sf2.b, ["21-19", "21-18"]);
    await s.step(organiser, "corrects the second semi-final after the third-place match was played: refused as a plain result, and shown what each way would change", async () => {
      const row = staffRow(page, n(sf2.a), n(sf2.b));
      await row.getByPlaceholder("21-15, 18-21, 21-10").fill(sf2Right);
      await row.getByRole("button", { name: `${n(sf2.b).split(" ")[0]} won`, exact: true }).click();
      const review = page.getByRole("region", { name: "Correction" });
      await review.getByRole("heading", { name: `The knockout has begun: review this correction (${n(sf2.b)} won)` }).waitFor();
      await review.getByText("Not safely: settle these by hand first", { exact: false }).waitFor();
      expect(await review.getByRole("button", { name: "Put into the knockout" }).isDisabled()).toBe(true);
      await review.getByText("This match's record only", { exact: true }).waitFor();
      // Nothing has changed yet.
      const d = await publicDetail(t.id);
      expect(d.matches.find((m) => m.id === sf2.id)!.winner).toBe(sf2.a);
    });

    await s.step(organiser, "corrects the record only, with the reason: the played third-place match is kept, and the tournament goes under review", async () => {
      const review = page.getByRole("region", { name: "Correction" });
      expect(await review.getByRole("button", { name: "Record only" }).isDisabled()).toBe(true);
      await review.getByLabel("Why (kept with the correction)").fill("Referee's scoresheet: the names were swapped");
      await review.getByRole("button", { name: "Record only" }).click();
      await page.getByRole("heading", { name: "What that changed" }).waitFor();
      const issues = page.getByRole("region", { name: "Progression to resolve" });
      await issues.first().waitFor();
      await issues.getByRole("heading", { name: `Under review: ${n(sf2.a)} went on in place of ${n(sf2.b)}` }).waitFor();
      await page.getByText("The tournament does not finish until this is resolved.", { exact: false }).first().waitFor();
      // The one due to play the final is in the other match the place came from: it cannot be replayed here.
      for (const r of await issues.all()) {
        await r.getByText("It cannot be replayed here", { exact: false }).waitFor();
        expect(await r.getByRole("button", { name: "Replay", exact: true }).isDisabled()).toBe(true);
      }
      await page.getByText(/this match's record only, later rounds as played: Referee's scoresheet/).waitFor();
    });

    const desk = await s.actor("Desk");
    const loser = t.players.find((p) => `${p.name} Tester` === n(sf2.a))!;
    await s.step(desk, "cannot resolve it from the front desk, nor can a player", async () => {
      const login = await desk.api("POST", "/api/admin/auth/login", { email: venue.desk, password: PASSWORD });
      expect(login.status).toBe(200);
      const open = (await publicDetail(t.id)).issues.filter((i) => i.status === "open");
      expect(open.length).toBeGreaterThan(0);
      for (const a of [desk, loser]) {
        const r = await a.api("POST", `/api/admin/tournaments/${t.id}/issues/${open[0].id}`, { action: "stand", reason: "Not mine to decide", token: "x" });
        expect(r.status, a.name).toBe(a === desk ? 403 : 401);
      }
    });

    const visitor = await s.actor("Visitor", "phone");
    await s.step(visitor, "sees the tournament under review and the correction noted; the third-place match as it was played", async () => {
      await visitor.page.goto(`${url}/tournaments/${t.id}`);
      await visitor.page.getByText("Some results are under review by the organiser: the outcome is not final yet.").waitFor();
      await visitor.page.getByText("A result was corrected after the knockout began, by the organiser.").waitFor();
      await publicRow(visitor.page, n(sf1.a), n(sf2.b)).getByText(thirdScore).waitFor();
      await publicRow(visitor.page, n(sf2.a), n(sf2.b)).getByText(sf2Right).waitFor();
      const d = await publicDetail(t.id);
      expect(d.matches.find((m) => m.id === t.thirdId)).toMatchObject({ a: sf1.a, b: sf2.b, winner: sf1.a, status: "done", score: thirdScore });
      // Who played the final's place stays as it was played, until the organiser decides.
      expect(d.matches.find((m) => m.id === t.finalId)).toMatchObject({ a: sf1.b, b: sf2.a, status: "scheduled" });
    });

    await s.step(organiser, "enters the final; with the progression unresolved the tournament does not finish", async () => {
      await enterOnDashboard(page, n(sf1.b), n(sf2.a), "21-17, 21-19", n(sf1.b));
      await page.getByRole("heading", { name: new RegExp(`${t.name} · drawn`) }).waitFor();
      expect((await publicDetail(t.id)).status).toBe("drawn");
    });

    await s.step(visitor, "sees no winner while it is under review", async () => {
      await visitor.page.reload();
      await visitor.page.getByText("Some results are under review by the organiser", { exact: false }).waitFor();
      expect(await visitor.page.getByText(/^🏆 Winner:/).count()).toBe(0);
      await visitor.page.getByText("Draw made", { exact: false }).waitFor();
    });

    await s.step(organiser, "lets the results stand, with the reason, for each part of it; then the tournament finishes", async () => {
      const issues = page.getByRole("region", { name: "Progression to resolve" });
      while ((await issues.count()) > 0) {
        const left = await issues.count();
        const first = issues.first();
        await first.getByLabel("Why (kept with the resolution)").fill("Both players agreed to let the results stand");
        await first.getByRole("button", { name: "Let the results stand" }).click();
        await page.waitForFunction((n) => document.querySelectorAll('section[aria-label="Progression to resolve"]').length < n, left);
      }
      await page.getByRole("heading", { name: new RegExp(`${t.name} · finished`) }).waitFor();
      await page.getByText(/results let stand: Both players agreed/).first().waitFor();
    });

    await s.step(visitor, "sees it finished, the final's winner, and the history kept: the correction noted, the third-place match as played", async () => {
      await visitor.page.reload();
      await visitor.page.getByText(`Winner: ${n(sf1.b)}`).waitFor();
      expect(await visitor.page.getByText("Some results are under review by the organiser", { exact: false }).count()).toBe(0);
      await visitor.page.getByText("A result was corrected after the knockout began, by the organiser.").waitFor();
      await publicRow(visitor.page, n(sf1.a), n(sf2.b)).getByText(thirdScore).waitFor();
    });
  });
});
