// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { TournamentsTab } from "../../src/components/admin/TournamentsTab";
import { TEMPLATES } from "../../src/lib/competition-templates";
import { DEFAULT_RULES } from "../../src/lib/tournament-rules";

/**
 * The judge's screen for a counted event (bouldering): a row for each competitor and, for each boulder, + for an
 * attempt, Z for the zone and T for the top, saved through the performances route, a correction that changes the
 * final previewed first. And the rules an organiser sets (lib/counted-performances.ts).
 */

const venue = {
  id: 1,
  name: "Setia Wall",
  openMin: 8 * 60,
  closeMin: 22 * 60,
  courts: [{ id: 7, name: "Boulder Wall", sport: "bouldering", activities: [] }],
} as never;

const counted = {
  rankBy: ["tops", "zones", "attempts_top", "attempts_zone"],
  kind: "boulders",
  units: 3,
  countback: false,
  finalStart: "reverse",
  cutTies: "choose",
};

const cup = {
  id: 9,
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
  entered: 2,
  waitlisted: 0,
  payOnline: false,
  groups: [],
  corrections: [],
  issues: [],
  rules: { ...DEFAULT_RULES, performance: { measure: "score", better: "higher", attempts: 1, aggregate: "best", heatSize: 4, finalSize: 2, counted } },
  entries: [
    { id: 1, name: "Aina", status: "entered", seed: null, paid: false, out: null, entryMark: null },
    { id: 2, name: "Bala", status: "entered", seed: null, paid: false, out: null, entryMark: null },
  ],
  matches: [{ id: 50, stage: "heat", groupNo: null, round: 1, position: 1, a: null, b: null, courtId: 7, courtName: "Boulder Wall", date: "2026-11-20", minute: 540, hour: 9, score: null, winner: null, next: null, nextSlot: null, status: "scheduled" }],
  performance: {
    lines: {
      50: [
        { entryId: 1, lane: 1, status: "pending", attempts: [], result: null, shown: null, rank: null, counts: [] },
        { entryId: 2, lane: 2, status: "pending", attempts: [], result: null, shown: null, rank: null, counts: [] },
      ],
    },
    ranking: [],
    heatRanking: [],
    tieForFinal: null,
    field: { heat: [{ unit: 1, tops: 0, zones: 0, climbers: 0 }], final: [] },
  },
};

let preview: Record<string, unknown>;
let current: typeof cup = cup;
let requests: unknown[] = [];
const posts: { url: string; body: Record<string, unknown> }[] = [];

beforeEach(() => {
  posts.length = 0;
  current = cup;
  requests = [];
  preview = { consequential: false, token: "tok", changes: [] };
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === "POST") {
        const body = JSON.parse(init.body ?? "{}");
        posts.push({ url, body });
        return { ok: true, json: async () => (body.preview ? { preview } : { tournament: cup }) };
      }
      if (url.startsWith("/api/admin/tournaments?")) return { ok: true, json: async () => ({ tournaments: [current], competitions: [], templates: TEMPLATES, venueTemplates: [] }) };
      return { ok: true, json: async () => ({ tournament: current, correctionRequests: requests, reports: [], officials: [] }) };
    })
  );
  vi.stubGlobal("confirm", () => true);
});
afterEach(() => vi.unstubAllGlobals());

async function open() {
  render(<TournamentsTab venues={[venue]} />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  await act(async () => {});
}

const click = (name: string) => fireEvent.click(screen.getByRole("button", { name }));

describe("a counted event's group", () => {
  it("is entered attempt by attempt: + for each, Z at the attempt that reached the zone, T at the one that topped, saved as counts", async () => {
    await open();
    // Aina on boulder 1: two attempts, the zone on the second, then the top on the same attempt.
    click("Add an attempt: Aina, boulder 1");
    click("Add an attempt: Aina, boulder 1");
    click("Zone reached: Aina, boulder 1");
    click("Top reached: Aina, boulder 1");
    // The climb ended at the top: no more attempts, and the zone is part of the top.
    expect((screen.getByRole("button", { name: "Add an attempt: Aina, boulder 1" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Zone reached: Aina, boulder 1" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Take back an attempt: Aina, boulder 1" }) as HTMLButtonElement).disabled).toBe(true);
    // Boulder 2: one attempt for nothing; Bala did not start.
    click("Add an attempt: Aina, boulder 2");
    fireEvent.change(screen.getByLabelText("Bala status"), { target: { value: "dns" } });
    click("Save results");
    await act(async () => {});
    const url = "/api/admin/tournaments/9/matches/50";
    const performances = [
      {
        entryId: 1,
        status: "ok",
        counts: [
          { unit: 1, attempts: 2, zone: 2, top: 2 },
          { unit: 2, attempts: 1, zone: null, top: null },
        ],
      },
      { entryId: 2, status: "dns" },
    ];
    // What it would change is asked first; nothing downstream changes, so it is saved without a prompt.
    expect(posts).toEqual([
      { url, body: { performances, preview: true } },
      { url, body: { performances } },
    ]);
  });

  it("takes an attempt back until the zone or top, and one boulder at a time on a narrow screen", async () => {
    await open();
    click("Add an attempt: Aina, boulder 1");
    click("Add an attempt: Aina, boulder 1");
    click("Zone reached: Aina, boulder 1");
    expect((screen.getByRole("button", { name: "Take back an attempt: Aina, boulder 1" }) as HTMLButtonElement).disabled).toBe(true);
    // The zone is taken off: attempts can be taken back again.
    click("Zone reached: Aina, boulder 1");
    expect((screen.getByRole("button", { name: "Take back an attempt: Aina, boulder 1" }) as HTMLButtonElement).disabled).toBe(false);
    // Show boulder 2 only: boulder 1's buttons are gone and boulder 2's are there.
    click("2");
    expect(screen.queryByRole("button", { name: "Add an attempt: Aina, boulder 1" })).toBeNull();
    click("Add an attempt: Bala, boulder 2");
    click("All boulders");
    expect(screen.getByRole("button", { name: "Add an attempt: Aina, boulder 3" })).toBeTruthy();
  });

  it("asks before a correction that changes who is in the final, and makes it against the preview's token", async () => {
    preview = {
      consequential: true,
      token: "tok-77",
      changes: ["Aina: 0T 1Z 0 2 becomes 1T 1Z 1 1.", "The final's field changes: Aina and Bala, where it was Bala and Cai."],
    };
    await open();
    click("Add an attempt: Aina, boulder 1");
    click("Top reached: Aina, boulder 1");
    click("Save results");
    await act(async () => {});
    expect(posts.map((p) => Object.keys(p.body))).toEqual([["performances", "preview"], ["performances", "confirm"]]);
    expect(posts[1].body.confirm).toEqual({ token: "tok-77" });
  });

  it("makes no correction when the organiser declines the preview", async () => {
    preview = { consequential: true, token: "t", changes: ["The final's field changes."] };
    vi.stubGlobal("confirm", () => false);
    await open();
    click("Add an attempt: Aina, boulder 1");
    click("Save results");
    await act(async () => {});
    expect(posts).toHaveLength(1);
    expect(posts[0].body.preview).toBe(true);
  });
});

describe("a counted event's rules", () => {
  it("are chosen with the template: how many boulders, what it is ranked by, the countback, the final's start and the cut", async () => {
    render(<TournamentsTab venues={[venue]} />);
    await act(async () => {});
    fireEvent.change(screen.getByDisplayValue(/Bouldering: tops, zones and attempts|Racket|Best of three/), { target: { value: "bouldering_tops_zones" } });
    expect((screen.getByLabelText("Boulders in a round") as HTMLInputElement).value).toBe("5");
    const rankBy = screen.getByLabelText("Ranked by") as HTMLSelectElement;
    expect(rankBy.value).toBe("simple");
    fireEvent.change(rankBy, { target: { value: "full" } });
    expect(rankBy.value).toBe("full");
    expect(screen.getByLabelText("Level in the final: the better placing in the groups decides")).toBeTruthy();
    expect(screen.getByLabelText("The final starts with")).toBeTruthy();
    expect(screen.getByLabelText("Level for the last place in the final")).toBeTruthy();
  });
});

describe("a finished climbing event", () => {
  const asked = { id: 4, matchId: 50, officialName: "Judge Jamal", reason: "Aina's boulder 1 was topped", lines: [], status: "open", createdAt: "2026-11-20T10:00:00Z", decidedBy: null, decidedAt: null, decisionNote: null };

  it("still shows the correction requests its officials send in the days after, to preview, apply or decline, and nothing else of the officials' panel", async () => {
    current = { ...cup, status: "finished" };
    requests = [asked];
    await open();
    expect(screen.getByText("Results from the players and officials")).toBeTruthy();
    expect(screen.getByText(/Judge Jamal asks to correct Group 1: Aina's boulder 1 was topped/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Preview what it changes" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Decline…" })).toBeTruthy();
    // No link is given for a finished event.
    expect(screen.queryByRole("button", { name: "Give an official a link" })).toBeNull();
  });

  it("shows no officials' panel when nobody has asked for a correction", async () => {
    current = { ...cup, status: "finished" };
    await open();
    expect(screen.queryByText("Results from the players and officials")).toBeNull();
  });
});
