// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { TournamentsTab } from "../../src/components/admin/TournamentsTab";
import { TEMPLATES } from "../../src/lib/competition-templates";
import { DEFAULT_RULES } from "../../src/lib/tournament-rules";

/**
 * The organiser's screens for a consolation draw and a double elimination (ADR 0032): choosing them when setting a
 * tournament up (the options belong to the format), and the matches of each bracket named as what they are.
 */

const venue = {
  id: 1,
  name: "Sunway Courts",
  openMin: 6 * 60,
  closeMin: 22 * 60,
  courts: [{ id: 7, name: "Court 1", sport: "badminton", activities: [] }],
} as never;

const match = (id: number, bracket: string, round: number, position: number, over: Record<string, unknown> = {}) => ({
  id,
  stage: "knockout",
  bracket,
  groupNo: null,
  round,
  position,
  placement: null,
  a: 1,
  b: 2,
  courtId: 7,
  courtName: "Court 1",
  date: "2026-11-20",
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

const entries = [1, 2, 3].map((id) => ({ id, name: ["Aina", "Bala", "Chong"][id - 1], status: "entered", seed: null, paid: false, out: null, entryMark: null, checkedIn: false }));

const double = {
  id: 9,
  venueId: 1,
  venueName: "Sunway Courts",
  area: "Subang",
  name: "Open Double",
  sport: "badminton",
  format: "double_elimination",
  teamSize: 1,
  entryKind: "player",
  roster: null,
  category: "open",
  level: null,
  entryFee: 0,
  maxEntries: 16,
  groupSize: 4,
  advance: 2,
  startsOn: "2026-11-20",
  endsOn: "2026-11-20",
  startMin: 540,
  endMin: 1020,
  startHour: 9,
  endHour: 17,
  matchMinutes: 30,
  stageMinutes: {},
  description: null,
  status: "drawn",
  courtIds: [7],
  entered: 3,
  waitlisted: 0,
  payOnline: false,
  template: "racket_best_of_3",
  rules: DEFAULT_RULES,
  groups: [],
  corrections: [],
  issues: [],
  performance: null,
  placings: null,
  entries,
  matches: [match(11, "winners", 1, 1), match(12, "winners", 2, 1), match(13, "losers", 1, 1), match(14, "losers", 2, 1), match(15, "grand", 1, 1), match(16, "grand", 2, 1, { a: null, b: null, status: "bye" })],
};

const consolation = {
  ...double,
  name: "Open Plate",
  format: "knockout",
  rules: { ...DEFAULT_RULES, bracket: { consolation: true, consolationThirdPlace: true, grandFinalReset: true } },
  matches: [match(21, "main", 1, 1), match(22, "main", 2, 1), match(23, "consolation", 1, 1), match(24, "consolation", 2, 1)],
};

let fetchMock: ReturnType<typeof vi.fn>;
let detail: unknown;
const posts: { url: string; body: Record<string, unknown> }[] = [];

beforeEach(() => {
  posts.length = 0;
  fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === "POST") {
      posts.push({ url, body: JSON.parse(init.body ?? "{}") });
      return { ok: true, json: async () => ({ tournament: detail, changes: [] }) };
    }
    if (url.startsWith("/api/admin/tournaments?")) return { ok: true, json: async () => ({ tournaments: [detail], competitions: [], templates: TEMPLATES, venueTemplates: [] }) };
    return { ok: true, json: async () => ({ tournament: detail }) };
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

async function setUp() {
  detail = double;
  render(<TournamentsTab venues={[venue]} />);
  await act(async () => {});
}

describe("setting one up", () => {
  it("S1: a knockout offers a consolation draw, its third-place match once it is chosen, and sends both as rules", async () => {
    await setUp();
    expect(screen.queryByLabelText(/Play the grand final again/)).toBeNull();
    const choose = screen.getByLabelText(/Consolation draw for first-round losers/);
    expect(screen.queryByLabelText(/A consolation third-place match/)).toBeNull();
    fireEvent.click(choose);
    // A stage length for the consolation draw is asked for beside the knockout's.
    expect(screen.getByText("Consolation draw", { selector: "label" })).toBeTruthy();
    fireEvent.click(screen.getByLabelText(/A consolation third-place match/));
    fireEvent.change(screen.getByPlaceholderText("Open Singles, November"), { target: { value: "Plate Open" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Set it up and hold the courts" })[0]);
    await act(async () => {});
    expect(posts.at(-1)).toMatchObject({ url: "/api/admin/tournaments", body: { format: "knockout", rules: { bracket: { consolation: true, consolationThirdPlace: true } } } });
  });

  it("S1 S2: a double elimination offers the reset (on) and the stages of its brackets, and no consolation draw; it is not sent for another format", async () => {
    await setUp();
    fireEvent.click(screen.getByLabelText(/Consolation draw for first-round losers/));
    fireEvent.change(screen.getByDisplayValue("Knockout"), { target: { value: "double_elimination" } });
    expect(screen.queryByLabelText(/Consolation draw for first-round losers/)).toBeNull();
    const reset = screen.getByLabelText(/Play the grand final again/) as HTMLInputElement;
    expect(reset.checked).toBe(true);
    for (const stage of ["Losers' bracket", "Grand final", "Reset"]) expect(screen.getByText(stage, { selector: "label" })).toBeTruthy();
    fireEvent.click(reset);
    fireEvent.change(screen.getByPlaceholderText("Open Singles, November"), { target: { value: "Double Open" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Set it up and hold the courts" })[0]);
    await act(async () => {});
    // The consolation draw chosen before the format changed is not sent: it is a straight knockout's.
    expect(posts.at(-1)).toMatchObject({ body: { format: "double_elimination", rules: { bracket: { consolation: false, consolationThirdPlace: false, grandFinalReset: false } } } });
  });
});

describe("the matches of a double elimination", () => {
  it("T2: each is named by its bracket on the organiser's list, the reset not needed is left out, and the options are fixed after the draw", async () => {
    detail = double;
    render(<TournamentsTab venues={[venue]} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await act(async () => {});
    for (const name of [/Winners' round 1/, /Winners' final/, /Losers' round 1/, /Losers' final/, /Grand final$/]) expect(screen.getAllByText(name).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Grand final reset/)).toBeNull();
    const reset = screen.getByLabelText(/Play the grand final again/) as HTMLInputElement;
    expect(reset.disabled).toBe(true);
  });

  it("F1: the final places are listed once it is over, level entrants sharing one", async () => {
    detail = { ...double, status: "finished", placings: [{ entryId: 1, place: 1 }, { entryId: 2, place: 2 }, { entryId: 3, place: 3 }] };
    render(<TournamentsTab venues={[venue]} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await act(async () => {});
    expect(screen.getByText("Final places")).toBeTruthy();
    expect(screen.getByText(/Chong/, { selector: "li" })).toBeTruthy();
  });
});

describe("the matches of a consolation draw", () => {
  it("T2: a consolation match is named as one, and the options can be changed until the draw", async () => {
    detail = { ...consolation, status: "closed", matches: [] };
    render(<TournamentsTab venues={[venue]} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await act(async () => {});
    const third = screen.getByLabelText(/A consolation third-place match/) as HTMLInputElement;
    expect(third.disabled).toBe(false);
    fireEvent.click(third);
    await act(async () => {});
    expect(posts.at(-1)).toMatchObject({ body: { action: "rules", rules: { bracket: { consolation: true, consolationThirdPlace: false } } } });
  });

  it("T2: after the draw the matches carry the names of their draw", async () => {
    detail = consolation;
    render(<TournamentsTab venues={[venue]} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await act(async () => {});
    expect(screen.getAllByText(/Consolation round 1/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Consolation final/).length).toBeGreaterThan(0);
  });
});
