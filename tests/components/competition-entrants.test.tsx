// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

const params = { id: "31" };
vi.mock("next/navigation", () => ({ useParams: () => params }));

import TournamentPage from "../../src/app/tournaments/[id]/page";
import LeaguePage from "../../src/app/leagues/[id]/page";
import { DEFAULT_RULES } from "../../src/lib/tournament-rules";

/**
 * The public pages when the account acts for somebody: choosing who enters
 * or joins (their declared gender where the event asks it), the entries made
 * for them, a gendered league of pairs asking the partner's gender, and a
 * league answer naming the version of the result it answers.
 */

const girls = {
  id: 31,
  venueId: 1,
  venueName: "Arena Damansara",
  area: "Damansara",
  name: "Girls' Singles",
  sport: "badminton",
  format: "knockout",
  teamSize: 1,
  entryKind: "player",
  roster: null,
  template: "racket_best_of_3",
  category: "women",
  level: null,
  entryFee: 10,
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
  status: "open",
  courtIds: [7],
  entered: 1,
  waitlisted: 0,
  payOnline: true,
  rules: DEFAULT_RULES,
  competition: null,
  entriesCloseOn: null,
  ageRange: null,
  membersOnly: false,
  resultsBy: "staff",
  entries: [],
  matches: [],
  groups: [],
  corrections: [],
  issues: [],
  performance: null,
};

const posts: Record<string, unknown>[] = [];
let answer: Record<string, unknown> = {};
beforeEach(() => {
  posts.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === "POST") posts.push(JSON.parse(init.body ?? "{}"));
      return { ok: true, json: async () => answer };
    })
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("a guardian on a tournament's page", () => {
  it("chooses who is entering, says a participant's gender in a women's event, and sees the entry made for them", async () => {
    answer = {
      tournament: girls,
      mine: null,
      managed: [{ id: 9, name: "Hana", status: "entered", seed: null, paid: false, out: null, entryMark: null, checkedIn: false, participantId: 4 }],
      people: [
        { id: 4, name: "Hana" },
        { id: 5, name: "Aina" },
      ],
      signedIn: true,
    };
    render(<TournamentPage />);
    await act(async () => {});
    expect(screen.getByText("Hana: entered")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Pay Hana's/ }));
    await act(async () => {});
    expect(posts.at(-1)).toEqual({ action: "pay", entryId: 9 });
    // Hana is entered already: the choice is the guardian, or Aina.
    const who = screen.getByLabelText("Who is entering") as HTMLSelectElement;
    expect([...who.options].map((o) => o.text)).toEqual(["Myself", "Aina"]);
    fireEvent.change(who, { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("They are"), { target: { value: "woman" } });
    fireEvent.click(screen.getByRole("button", { name: "Enter" }));
    await act(async () => {});
    expect(posts.at(-1)).toMatchObject({ action: "enter", participantId: 5, gender: "woman" });
  });
});

describe("a league's page", () => {
  const ladder = {
    id: 31,
    venueId: 1,
    venueName: "Arena Damansara",
    area: "Damansara",
    name: "Ladies' Pairs",
    sport: "badminton",
    teamSize: 2,
    who: "women",
    level: null,
    boxSize: 4,
    moves: 1,
    seasonDays: 28,
    fee: 0,
    description: null,
    status: "running",
    players: 4,
    current: { id: 1, number: 1, startsOn: "2026-11-01", endsOn: "2026-11-28", status: "running" },
    payOnline: false,
    rules: DEFAULT_RULES,
    template: "racket_best_of_3",
    seasons: [{ id: 1, number: 1, startsOn: "2026-11-01", endsOn: "2026-11-28", status: "running" }],
    viewing: { id: 1, number: 1, startsOn: "2026-11-01", endsOn: "2026-11-28", status: "running" },
    boxes: [{ boxNo: 1, table: [] }],
    places: [
      { id: 1, playerId: 11, boxNo: 1, finish: null, move: null, paid: false, withdrawn: false },
      { id: 2, playerId: 12, boxNo: 1, finish: null, move: null, paid: false, withdrawn: false },
    ],
    matches: [{ id: 70, boxNo: 1, a: 11, b: 12, score: "21-10, 21-12", winner: 11, status: "reported", reportedBy: 11, reportedAt: "2026-11-03", version: 3 }],
    people: [
      { id: 11, name: "Mei / Siti", status: "active" },
      { id: 12, name: "Puteri / Lina", status: "active" },
    ],
  };

  it("asks a pair's partner's gender in a women's league", async () => {
    answer = { league: { ...ladder, current: { ...ladder.current, status: "forming" }, viewing: null, boxes: [], matches: [], places: [] }, mine: null, managed: [], people: [], signedIn: true };
    render(<LeaguePage />);
    await act(async () => {});
    fireEvent.change(screen.getByLabelText("Your partner's name"), { target: { value: "Aminah" } });
    fireEvent.change(screen.getByLabelText("Your partner is"), { target: { value: "woman" } });
    fireEvent.click(screen.getByRole("button", { name: "Join the league" }));
    await act(async () => {});
    expect(posts.at(-1)).toEqual({ action: "join", partnerName: "Aminah", partnerGender: "woman" });
  });

  it("answers a report on the version of the result it shows", async () => {
    answer = {
      league: ladder,
      mine: { playerId: 12, name: "Puteri / Lina", place: { id: 2, playerId: 12, boxNo: 1, finish: null, move: null, paid: false, withdrawn: false }, contacts: [] },
      managed: [],
      people: [],
      signedIn: true,
    };
    render(<LeaguePage />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await act(async () => {});
    expect(posts.at(-1)).toEqual({ action: "confirm", version: 3 });
  });
});
