// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useParams: () => ({ id: "31" }) }));

import TournamentPage from "../../src/app/tournaments/[id]/page";
import { DEFAULT_RULES } from "../../src/lib/tournament-rules";

/**
 * The public page of a double elimination and of a knockout with a consolation draw (ADR 0032): each bracket in a section of its
 * own, the grand-final reset said as played again or not needed, the champion and the final places once it is over.
 */

const match = (id: number, bracket: string, round: number, position: number, over: Record<string, unknown> = {}) => ({
  id,
  stage: "knockout",
  bracket,
  groupNo: null,
  round,
  position,
  placement: null,
  a: null,
  b: null,
  courtId: 7,
  courtName: "Court 1",
  date: "2026-12-05",
  minute: 540 + id,
  hour: 9,
  score: null,
  winner: null,
  next: null,
  nextSlot: null,
  loserNext: null,
  loserNextSlot: null,
  minutes: 30,
  status: "scheduled",
  ...over,
});

const base = {
  id: 31,
  venueId: 1,
  venueName: "Arena Damansara",
  area: "Damansara",
  name: "Open Double",
  sport: "badminton",
  format: "double_elimination",
  teamSize: 1,
  entryKind: "player",
  roster: null,
  template: "racket_best_of_3",
  category: "open",
  level: null,
  entryFee: 0,
  maxEntries: 16,
  groupSize: 4,
  advance: 2,
  startsOn: "2026-12-05",
  endsOn: "2026-12-05",
  startMin: 540,
  endMin: 1080,
  startHour: 9,
  endHour: 18,
  matchMinutes: 30,
  description: null,
  status: "drawn",
  courtIds: [7],
  entered: 3,
  waitlisted: 0,
  payOnline: false,
  rules: DEFAULT_RULES,
  competition: null,
  entriesCloseOn: null,
  ageRange: null,
  membersOnly: false,
  entries: ["Aina", "Bala", "Chong"].map((name, i) => ({ id: i + 1, name, status: "entered", seed: null, paid: false, out: null, entryMark: null })),
  groups: [],
  corrections: [],
  issues: [],
  performance: null,
  placings: null,
  drawOrder: [1, 2, 3],
};

let page: unknown;
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ tournament: page, mine: null, signedIn: false }) })));
});
afterEach(() => vi.unstubAllGlobals());

async function show(tournament: unknown) {
  page = tournament;
  render(<TournamentPage />);
  await act(async () => {});
}

describe("a double elimination", () => {
  const played = {
    ...base,
    matches: [
      match(1, "winners", 1, 1, { a: 1, b: 2, winner: 1, status: "done", score: "21-10, 21-12" }),
      match(2, "winners", 2, 1, { a: 1, b: 3, winner: 1, status: "done", score: "21-10, 21-12" }),
      match(3, "losers", 1, 1, { a: 2, b: 3, winner: 3, status: "done", score: "21-10, 21-12" }),
      match(4, "grand", 1, 1, { a: 1, b: 3, winner: 1, status: "done", score: "21-10, 21-12" }),
      match(5, "grand", 2, 1, { status: "bye" }),
    ],
  };

  it("T2: shows each bracket in a section of its own, named as the bracket is", async () => {
    await show({ ...played, status: "drawn" });
    for (const title of ["Winners' bracket", "Losers' bracket", "Grand final"]) expect(screen.getAllByText(title, { selector: "h2" })).toHaveLength(1);
    expect(screen.getAllByText("Double elimination", { exact: false }).length).toBeGreaterThan(0);
    expect(screen.getByText("Not needed: the winners' bracket's finalist won the grand final.")).toBeTruthy();
    // A match in the losers' bracket is named in the list of fixtures.
    expect(screen.getAllByText("Losers' final").length).toBeGreaterThan(0);
  });

  it("F1: once it is over it names the champion and lists the final places, level entrants sharing one", async () => {
    await show({ ...played, status: "finished", placings: [{ entryId: 1, place: 1 }, { entryId: 3, place: 2 }, { entryId: 2, place: 3 }] });
    expect(screen.getByText(/Aina/, { selector: "p" })).toBeTruthy();
    expect(screen.getByText("Final places")).toBeTruthy();
    expect(screen.getAllByRole("listitem").some((li) => li.textContent?.startsWith("2.") && li.textContent.includes("Chong"))).toBe(true);
  });

  it("E4: before the grand final the reset says it is played again only if the losers' bracket's finalist wins", async () => {
    await show({
      ...base,
      matches: [match(4, "grand", 1, 1), match(5, "grand", 2, 1)],
    });
    expect(screen.getByText("Played again only if the losers' bracket's finalist wins the grand final.")).toBeTruthy();
  });
});

describe("a knockout with a consolation draw", () => {
  it("shows the consolation draw in a section of its own, and says what it is", async () => {
    await show({
      ...base,
      format: "knockout",
      rules: { ...DEFAULT_RULES, bracket: { consolation: true, consolationThirdPlace: false, grandFinalReset: true } },
      matches: [match(1, "main", 1, 1, { a: 1, b: 2, winner: 1, status: "done", score: "21-10, 21-12" }), match(2, "consolation", 1, 1, { a: 2, b: 3 })],
    });
    expect(screen.getAllByText("Consolation draw", { selector: "h2" })).toHaveLength(1);
    expect(screen.getByText("Players who lose their first match play on here.")).toBeTruthy();
    expect(screen.getAllByText("Knockout with a consolation draw", { exact: false }).length).toBeGreaterThan(0);
    expect(screen.getAllByText("Consolation final").length).toBeGreaterThan(0);
  });
});
