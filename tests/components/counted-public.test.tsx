// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useParams: () => ({ id: "31" }) }));

import TournamentPage from "../../src/app/tournaments/[id]/page";
import { DEFAULT_RULES } from "../../src/lib/tournament-rules";

/**
 * The public page of a counted event (bouldering): the placings with what each competitor's counts add up to, a column
 * for each thing the event ranks by, each group's climbers in their order of start, how many of the field topped each
 * boulder, and a declared minor by first name and initial (the server names them so: lib/public-names.ts).
 */

const rules = (rankBy: string[], countback = false) => ({
  ...DEFAULT_RULES,
  performance: { measure: "score", better: "higher", attempts: 1, aggregate: "best", heatSize: 4, finalSize: 2, counted: { kind: "boulders", units: 3, rankBy, countback, finalStart: "reverse", cutTies: "choose" } },
});

const tally = (tops: number, zones: number, attemptsTop: number, attemptsZone: number) => ({ tops, zones, attemptsTop, attemptsZone, height: 0, attemptsHeight: 0 });

const event = (over: Record<string, unknown> = {}) => ({
  id: 31,
  venueId: 1,
  venueName: "Setia Wall",
  area: "Subang",
  name: "Boulder Open",
  sport: "bouldering",
  format: "performance",
  template: "bouldering_tops_zones_attempts",
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
  matchMinutes: 120,
  description: null,
  status: "drawn",
  courtIds: [7],
  entered: 3,
  waitlisted: 0,
  payOnline: false,
  rules: rules(["tops", "zones", "attempts_top", "attempts_zone"], true),
  entries: [
    { id: 1, name: "Aina B.", status: "entered", seed: null, paid: false, out: null, entryMark: null },
    { id: 2, name: "Bala Raj", status: "entered", seed: null, paid: false, out: null, entryMark: null },
    { id: 3, name: "Chen Wei", status: "entered", seed: null, paid: false, out: null, entryMark: null },
  ],
  matches: [{ id: 50, stage: "heat", groupNo: null, round: 1, position: 1, a: null, b: null, courtId: 7, courtName: "Boulder Wall", date: "2026-11-20", minute: 540, hour: 9, score: null, winner: null, next: null, nextSlot: null, status: "done" }],
  groups: [],
  corrections: [],
  issues: [],
  performance: {
    lines: {
      50: [
        { entryId: 1, lane: 1, status: "ok", attempts: [], result: 2, shown: "2T 3Z 3 4", rank: 1, counts: [], tally: tally(2, 3, 3, 4) },
        { entryId: 2, lane: 2, status: "ok", attempts: [], result: 1, shown: "1T 2Z 2 3", rank: 2, counts: [], tally: tally(1, 2, 2, 3) },
        { entryId: 3, lane: 3, status: "dns", attempts: [], result: null, shown: null, rank: null, counts: [] },
      ],
    },
    ranking: [
      { entryId: 1, rank: 1, result: 2, shown: "2T 3Z 3 4", status: "ok", stage: "heat", tally: tally(2, 3, 3, 4) },
      { entryId: 2, rank: 2, result: 1, shown: "1T 2Z 2 3", status: "ok", stage: "heat", tally: tally(1, 2, 2, 3) },
      { entryId: 3, rank: null, result: null, shown: null, status: "dns", stage: "heat" },
    ],
    heatRanking: [],
    tieForFinal: null,
    field: {
      heat: [
        { unit: 1, tops: 2, zones: 2, climbers: 2 },
        { unit: 2, tops: 1, zones: 2, climbers: 2 },
        { unit: 3, tops: 0, zones: 1, climbers: 2 },
      ],
      final: [],
    },
  },
  ...over,
});

let current: ReturnType<typeof event>;
beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ tournament: current, mine: null, signedIn: false }) })));
});
afterEach(() => vi.unstubAllGlobals());

describe("a counted event's public page", () => {
  it("shows the placings with a column for each count the event ranks by, a group's start order, and how many topped each boulder", async () => {
    current = event();
    const { container } = render(<TournamentPage />);
    await act(async () => {});
    const results = screen.getByRole("heading", { name: "Results" }).parentElement!;
    for (const head of ["Tops", "Zones", "Attempts to top", "Attempts to zone"]) expect(within(results).getByText(head)).toBeTruthy();
    const rows = within(results).getAllByRole("row").slice(1);
    expect(rows.map((r) => r.textContent)).toEqual(["1Aina B.2334", "2Bala Raj1223", "—Chen Weidid not start"]);
    // The group: its climbers in their order of start, with the same counts.
    expect(screen.getByText("Group 1")).toBeTruthy();
    expect(container.textContent).toContain("How many topped each boulder");
    expect(screen.getByText(/2 of 2 topped it, 2 reached the zone/)).toBeTruthy();
    expect(screen.getByText(/0 of 2 topped it, 1 reached the zone/)).toBeTruthy();
    // The countback rule, where it is on, is said.
    expect(screen.getByText(/Level on every count in the final/)).toBeTruthy();
    // A minor is named as the server named them; no entry mark is asked of an event drawn by lot.
    expect(container.textContent).toContain("Aina B.");
    expect(container.textContent).not.toContain("Aina Binti");
  });

  it("shows only the columns of the club format (tops, then zones), and no champion where first place is shared", async () => {
    const shared = event({ status: "finished" });
    (shared as { rules: unknown }).rules = rules(["tops", "zones"]);
    (shared as { performance: { ranking: { rank: number | null }[] } }).performance.ranking[1].rank = 1;
    current = shared;
    render(<TournamentPage />);
    await act(async () => {});
    const results = screen.getByRole("heading", { name: "Results" }).parentElement!;
    expect(within(results).queryByText("Attempts to top")).toBeNull();
    expect(within(results).getByText("Zones")).toBeTruthy();
    expect(screen.queryByText(/Champion/)).toBeNull();
  });
});
