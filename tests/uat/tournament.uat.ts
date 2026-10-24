import { describe, expect } from "vitest";
import { courtFor, dayAhead, scenario, signInOwner, signUp, url, type Actor, type Scenario } from "./harness";

/**
 * Tournaments as players meet them: entering, a result reported by one side
 * and confirmed by the other to a winner, and a disputed result handed to
 * the venue's staff, who settle it; nobody but the players in a match may
 * report it.
 */

// Further out than the other scenarios' bookings, so the draw finds its courts free.
let day = 20;

async function tournamentWithPlayers(s: Scenario, names: [string, string]) {
  const owner = await signInOwner(await s.actor("Organiser"));
  const { venueId, courtIds } = await courtFor();
  const date = dayAhead(day++);
  const made = await owner.api("POST", "/api/admin/tournaments", {
    venueId,
    courtIds: courtIds.slice(-1),
    name: `UAT Cup ${date}`,
    sport: "badminton",
    format: "knockout",
    teamSize: 1,
    entryFee: 0,
    maxEntries: 8,
    startsOn: date,
    endsOn: date,
    startHour: 9,
    endHour: 18,
    resultsBy: "players",
  });
  if (made.status !== 201) throw new Error(`tournament: ${JSON.stringify(made.body)}`);
  const id = (made.body.tournament as { id: number }).id;
  const players: Actor[] = [];
  for (const name of names) {
    const p = await signUp(await s.actor(name));
    players.push(p);
    await s.step(p, "enters the tournament on its page", async () => {
      await p.page.goto(`${url}/tournaments/${id}`);
      await p.page.getByRole("button", { name: "Enter" }).click();
      await p.page.getByText("You're entered").waitFor();
    });
  }
  await s.step(owner, "closes entries and makes the draw", async () => {
    expect((await owner.api("POST", `/api/admin/tournaments/${id}`, { action: "close" })).status).toBe(200);
    expect((await owner.api("POST", `/api/admin/tournaments/${id}`, { action: "draw" })).status).toBe(200);
  });
  const detail = (await owner.api("GET", `/api/admin/tournaments/${id}`)).body.tournament as {
    matches: { id: number; a: number | null; b: number | null }[];
    entries: { id: number; userId: number | null; name: string }[];
  };
  const match = detail.matches.find((m) => m.a !== null && m.b !== null)!;
  return { owner, id, players, match };
}

describe("tournaments", () => {
  scenario("Tournament 1: players enter, one reports the result, the other confirms it", async (s) => {
    const { id, players } = await tournamentWithPlayers(s, ["Amir", "Bee"]);
    const [amir, bee] = players;
    await s.step(amir, "reports the match: they won 21-15, 21-17", async () => {
      await amir.page.goto(`${url}/tournaments/${id}`);
      await amir.page.getByLabel("Who won").selectOption({ label: "Amir Tester" });
      await amir.page.getByLabel("Score").fill("21-15, 21-17");
      await amir.page.getByRole("button", { name: "Send the result" }).click();
      await amir.page.getByText(/waiting for the other side to confirm/).waitFor();
    });
    await s.step(bee, "sees what was reported and confirms it", async () => {
      await bee.page.goto(`${url}/tournaments/${id}`);
      await bee.page.getByText(/The other side reported/).waitFor();
      await bee.page.getByRole("button", { name: "That's right" }).click();
      await bee.page.getByText(/Winner: Amir/).waitFor();
    });
  });

  scenario("Tournament 2: a disputed result goes to the venue, and only players may report", async (s) => {
    const { owner, id, players, match } = await tournamentWithPlayers(s, ["Chen", "Devi"]);
    const [chen, devi] = players;
    const outsider = await signUp(await s.actor("Outsider"));
    await s.step(outsider, "cannot report a match they are not in", async () => {
      const r = await outsider.api("POST", `/api/tournaments/${id}`, { action: "report", matchId: match.id, winner: match.a, score: "21-0, 21-0" });
      expect(r.status).toBeGreaterThanOrEqual(400);
    });
    await s.step(chen, "reports a win", async () => {
      await chen.page.goto(`${url}/tournaments/${id}`);
      await chen.page.getByLabel("Who won").selectOption({ label: "Chen Tester" });
      await chen.page.getByLabel("Score").fill("21-19, 21-19");
      await chen.page.getByRole("button", { name: "Send the result" }).click();
      await chen.page.getByText(/waiting for the other side to confirm/).waitFor();
    });
    await s.step(devi, "disputes it, saying why", async () => {
      await devi.page.goto(`${url}/tournaments/${id}`);
      await devi.page.getByRole("button", { name: "That's wrong" }).click();
      await devi.page.getByLabel("What is wrong with it?").fill("I won the second game 21-18");
      await devi.page.getByRole("button", { name: "That's wrong" }).click();
      await devi.page.getByText("Disputed: the venue will enter the result.").waitFor();
    });
    await s.step(owner, "settles it as staff", async () => {
      const entries = ((await owner.api("GET", `/api/admin/tournaments/${id}`)).body.tournament as { entries: { id: number; name: string }[] }).entries;
      const deviEntry = entries.find((e) => e.name.startsWith("Devi"))!.id;
      // Scores are written from the first-named side's view.
      const score = match.a === deviEntry ? "19-21, 21-18, 21-15" : "21-19, 18-21, 15-21";
      const r = await owner.api("POST", `/api/admin/tournaments/${id}/matches/${match.id}`, { winner: deviEntry, score });
      expect(r.status, JSON.stringify(r.body)).toBeLessThan(300);
    });
    await s.step(devi, "sees the venue's result stand", async () => {
      await devi.page.goto(`${url}/tournaments/${id}`);
      await devi.page.getByText(/Winner: Devi/).waitFor();
    });
  });
});
