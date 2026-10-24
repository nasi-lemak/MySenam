// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { TournamentsTab } from "../../src/components/admin/TournamentsTab";
import { TEMPLATES } from "../../src/lib/competition-templates";
import { DEFAULT_RULES } from "../../src/lib/tournament-rules";

/**
 * The organiser's screen for a tournament: a performance event's heats are
 * entered lane by lane, and progression a correction left wrong is resolved
 * — let stand or replayed — with a reason and the token of what was reviewed.
 */

const venue = {
  id: 1,
  name: "Sunway Aquatic",
  openMin: 6 * 60,
  closeMin: 22 * 60,
  courts: [{ id: 7, name: "Lap Pool", sport: "swimming", activities: [] }],
} as never;

const base = {
  id: 9,
  venueId: 1,
  venueName: "Sunway Aquatic",
  area: "Subang",
  name: "Club Gala",
  sport: "swimming",
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
  matchMinutes: 10,
  description: null,
  status: "drawn",
  courtIds: [7],
  entered: 2,
  waitlisted: 0,
  payOnline: false,
  groups: [],
  corrections: [],
};

const gala = {
  ...base,
  format: "performance",
  template: "swimming_heats",
  rules: { ...DEFAULT_RULES, performance: { measure: "time", better: "lower", attempts: 1, aggregate: "best", heatSize: 8, finalSize: 8 } },
  entries: [
    { id: 1, name: "Aina", status: "entered", seed: null, paid: false, out: null, entryMark: 61 },
    { id: 2, name: "Bala", status: "entered", seed: null, paid: false, out: null, entryMark: 62 },
  ],
  matches: [{ id: 50, stage: "heat", groupNo: null, round: 1, position: 1, a: null, b: null, courtId: 7, courtName: "Lap Pool", date: "2026-11-20", minute: 540, hour: 9, score: null, winner: null, next: null, nextSlot: null, status: "scheduled" }],
  issues: [],
  performance: {
    lines: {
      50: [
        { entryId: 1, lane: 4, status: "pending", attempts: [], result: null, shown: null, rank: null },
        { entryId: 2, lane: 5, status: "pending", attempts: [], result: null, shown: null, rank: null },
      ],
    },
    ranking: [],
    tieForFinal: null,
  },
};

const cup = {
  ...base,
  name: "Open Cup",
  sport: "badminton",
  format: "knockout",
  template: "racket_best_of_3",
  rules: DEFAULT_RULES,
  entries: [
    { id: 1, name: "Aina", status: "entered", seed: null, paid: false, out: null, entryMark: null },
    { id: 2, name: "Bala", status: "entered", seed: null, paid: false, out: null, entryMark: null },
    { id: 3, name: "Chong", status: "entered", seed: null, paid: false, out: null, entryMark: null },
  ],
  matches: [],
  performance: null,
  issues: [
    {
      id: 4,
      fromMatchId: 70,
      wrongEntry: 1,
      rightEntry: 2,
      affected: [{ matchId: 70, played: true, text: "Final: Aina played instead of Bala against Chong; Aina won 21-18, 21-19." }],
      status: "open",
      createdAt: "2026-11-20 10:00:00",
    },
  ],
};

const championship = {
  id: 3,
  venueId: 1,
  name: "Club Championships",
  sport: "badminton",
  startsOn: "2026-12-05",
  endsOn: "2026-12-06",
  startMin: 540,
  endMin: 1080,
  matchMinutes: 30,
  courtIds: [7],
  maxDivisionsPerPlayer: 2,
  description: null,
  status: "open",
};

let fetchMock: ReturnType<typeof vi.fn>;
let detail: unknown;
const posts: { url: string; body: Record<string, unknown> }[] = [];

beforeEach(() => {
  posts.length = 0;
  fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === "POST") {
      posts.push({ url, body: JSON.parse(init.body ?? "{}") });
      return { ok: true, json: async () => ({ tournament: detail, changes: ["done"] }) };
    }
    if (url.startsWith("/api/admin/tournaments?"))
      return { ok: true, json: async () => ({ tournaments: [detail], competitions: [championship], templates: TEMPLATES, venueTemplates: [] }) };
    if (url.includes("/issues/"))
      return { ok: true, json: async () => ({ issue: cup.issues[0], replay: { possible: true, matches: [{ matchId: 70, name: "Final", needsSlot: true }] }, token: "tok-1" }) };
    return { ok: true, json: async () => ({ tournament: detail }) };
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("confirm", () => true);
});
afterEach(() => vi.unstubAllGlobals());

async function open() {
  render(<TournamentsTab venues={[venue]} />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  await act(async () => {});
}

describe("a performance event's heats", () => {
  it("are entered lane by lane, a swimmer who did not start said so, and saved as performances", async () => {
    detail = gala;
    await open();
    fireEvent.change(screen.getByLabelText("Aina attempt 1"), { target: { value: "1:01.20" } });
    fireEvent.change(screen.getByLabelText("Bala status"), { target: { value: "dns" } });
    fireEvent.click(screen.getByRole("button", { name: "Save results" }));
    await act(async () => {});
    expect(posts.at(-1)).toEqual({
      url: "/api/admin/tournaments/9/matches/50",
      body: { performances: [{ entryId: 1, status: "ok", attempts: ["1:01.20"] }, { entryId: 2, status: "dns" }] },
    });
  });
});

describe("progression a correction left wrong", () => {
  it("is shown with what it affects, and resolved only with a reason, against the token reviewed", async () => {
    detail = cup;
    await open();
    expect(screen.getByText(/Under review: Aina went on in place of Bala/)).toBeTruthy();
    expect(screen.getByText(/Final: Aina played instead of Bala/)).toBeTruthy();
    const stand = screen.getByRole("button", { name: "Let the results stand" }) as HTMLButtonElement;
    expect(stand.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText(/Both finalists agreed/), { target: { value: "Both finalists agreed it stands" } });
    expect(stand.disabled).toBe(false);
    fireEvent.click(stand);
    await act(async () => {});
    expect(posts.at(-1)).toEqual({ url: "/api/admin/tournaments/9/issues/4", body: { action: "stand", reason: "Both finalists agreed it stands", token: "tok-1" } });
  });
});

describe("a competition's divisions", () => {
  it("are set up by choosing the competition: its days and courts are shown, not asked, and who may enter goes with the rest", async () => {
    detail = { ...cup, issues: [] };
    const badmintonVenue = { ...(venue as object), courts: [{ id: 7, name: "Court 1", sport: "badminton", activities: [] }] } as never;
    render(<TournamentsTab venues={[badmintonVenue]} />);
    await act(async () => {});
    expect(screen.getByText(/Club Championships/, { selector: "span" })).toBeTruthy();
    fireEvent.change(screen.getByDisplayValue("On its own, holding its own courts"), { target: { value: "3" } });
    expect(screen.getByText(/Played in Club Championships's time/)).toBeTruthy();
    // Only the competition form below still asks for days.
    expect(screen.getAllByText("First day")).toHaveLength(1);
    fireEvent.change(screen.getByPlaceholderText("Open Singles, November"), { target: { value: "Girls Under 12" } });
    fireEvent.change(screen.getByLabelText("Oldest age"), { target: { value: "11" } });
    fireEvent.click(screen.getByLabelText("Members only"));
    fireEvent.click(screen.getAllByRole("button", { name: "Set it up and hold the courts" })[0]);
    await act(async () => {});
    expect(posts.at(-1)).toMatchObject({ url: "/api/admin/tournaments", body: { name: "Girls Under 12", competitionId: 3, ageMin: null, ageMax: 11, membersOnly: true, entriesCloseOn: null } });
  });

  it("start from a competition that holds the courts, with a cap on divisions per player", async () => {
    detail = { ...cup, issues: [] };
    const badmintonVenue = { ...(venue as object), courts: [{ id: 7, name: "Court 1", sport: "badminton", activities: [] }] } as never;
    render(<TournamentsTab venues={[badmintonVenue]} />);
    await act(async () => {});
    fireEvent.click(screen.getByText("Set up a competition with divisions"));
    fireEvent.change(screen.getByPlaceholderText("Club Championships 2026"), { target: { value: "Junior Open" } });
    fireEvent.change(screen.getByLabelText("Divisions per player (optional)"), { target: { value: "2" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Set it up and hold the courts" })[1]);
    await act(async () => {});
    expect(posts.at(-1)).toMatchObject({ url: "/api/admin/competitions", body: { name: "Junior Open", sport: "badminton", courtIds: [7], maxDivisionsPerPlayer: 2 } });
  });
});
