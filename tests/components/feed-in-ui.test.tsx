// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { TournamentsTab } from "../../src/components/admin/TournamentsTab";
import { TEMPLATES } from "../../src/lib/competition-templates";
import { DEFAULT_RULES } from "../../src/lib/tournament-rules";

/**
 * The organiser's screens for the advanced feed-in consolation draw (ADR 0034, M): it is offered beside the consolation draw, labelled
 * advanced; choosing it shows what it adds (the matches, the court hours, the rounds) and it is saved only once that is confirmed.
 */

const venue = {
  id: 1,
  name: "Sunway Courts",
  openMin: 6 * 60,
  closeMin: 22 * 60,
  courts: [{ id: 7, name: "Court 1", sport: "badminton", activities: [] }],
} as never;

const entries = [1, 2, 3, 4, 5, 6].map((id) => ({ id, name: `Player ${id}`, status: "entered", seed: null, paid: false, out: null, entryMark: null, checkedIn: false }));

const open = {
  id: 9,
  venueId: 1,
  venueName: "Sunway Courts",
  area: "Subang",
  name: "Open Plate",
  sport: "badminton",
  format: "knockout",
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
  endsOn: "2026-11-21",
  startMin: 540,
  endMin: 1260,
  startHour: 9,
  endHour: 21,
  matchMinutes: 30,
  stageMinutes: {},
  description: null,
  status: "open",
  courtIds: [7, 8],
  entered: 6,
  waitlisted: 0,
  payOnline: false,
  template: "racket_best_of_3",
  rules: { ...DEFAULT_RULES, bracket: { consolation: true, consolationThirdPlace: false, grandFinalReset: true } },
  groups: [],
  corrections: [],
  issues: [],
  performance: null,
  placings: null,
  entries,
  matches: [],
};

let detail: unknown;
const posts: { url: string; body: Record<string, unknown> }[] = [];

beforeEach(() => {
  posts.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === "POST") {
        posts.push({ url, body: JSON.parse(init.body ?? "{}") });
        return { ok: true, json: async () => ({ tournament: detail, changes: [] }) };
      }
      if (url.startsWith("/api/admin/tournaments?")) return { ok: true, json: async () => ({ tournaments: [detail], competitions: [], templates: TEMPLATES, venueTemplates: [] }) };
      return { ok: true, json: async () => ({ tournament: detail }) };
    })
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("setting one up", () => {
  async function setUp() {
    detail = open;
    render(<TournamentsTab venues={[venue]} />);
    await act(async () => {});
  }

  it("S1 M5: it is offered only once a consolation draw is chosen, labelled advanced, off by default, and choosing it shows what it adds for the most the tournament takes", async () => {
    await setUp();
    expect(screen.queryByLabelText(/Advanced: feed-in consolation/)).toBeNull();
    fireEvent.click(screen.getByLabelText(/Consolation draw for first-round losers/));
    const feed = screen.getByLabelText(/Advanced: feed-in consolation/) as HTMLInputElement;
    expect(feed.checked).toBe(false);
    expect(screen.queryByRole("group", { name: "What the feed-in consolation draw adds" })).toBeNull();
    fireEvent.click(feed);
    const box = screen.getByRole("group", { name: "What the feed-in consolation draw adds" });
    expect(box.textContent).toContain("for up to 16 entries");
    expect(box.textContent).toContain("Main draw: 15 matches");
    expect(box.textContent).toContain("Consolation draw: 13 matches");
    expect(box.textContent).toContain("In all: 28 matches");
    expect(box.textContent).toMatch(/This adds 13 matches and about \d+(\.\d)? court hours/);
    expect(box.textContent).toContain("6 rounds one after the other (the main draw alone has 4)");
    expect(box.textContent).toContain("The most matches one entrant can play: 6");
    // One court for nine hours does not hold twenty-eight matches of the length the template gives: the box says so.
    expect(box.textContent).toMatch(/is less than the .* hours these matches need|is enough for the/);
  });

  it("S2 M5: the knockout's own third-place match is not offered with it, and it is sent only once confirmed, as a mode of the consolation draw with the confirmation", async () => {
    await setUp();
    fireEvent.click(screen.getByLabelText(/Consolation draw for first-round losers/));
    fireEvent.click(screen.getByLabelText(/Advanced: feed-in consolation/));
    const third = screen.getByLabelText(/Third-place match \(the semi-finals/) as HTMLInputElement;
    expect(third.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText("Open Singles, November"), { target: { value: "Plate Open" } });
    const confirm = screen.getByLabelText(/I have seen this: it adds 13 matches/) as HTMLInputElement;
    expect(confirm.required).toBe(true);
    expect(confirm.checked).toBe(false);
    fireEvent.click(confirm);
    fireEvent.click(screen.getAllByRole("button", { name: "Set it up and hold the courts" })[0]);
    await act(async () => {});
    expect(posts.at(-1)).toMatchObject({
      url: "/api/admin/tournaments",
      body: { format: "knockout", thirdPlace: false, confirmFeedIn: true, rules: { bracket: { consolation: true, consolationMode: "feed_in" } } },
    });
  });

  it("S1: changing the choice again takes the confirmation back, and leaving the feed-in off sends the first round as before", async () => {
    await setUp();
    fireEvent.click(screen.getByLabelText(/Consolation draw for first-round losers/));
    fireEvent.click(screen.getByLabelText(/Advanced: feed-in consolation/));
    fireEvent.click(screen.getByLabelText(/I have seen this/));
    // Another choice of the bracket (its third-place match) asks again.
    fireEvent.click(screen.getByLabelText(/A consolation third-place match/));
    expect((screen.getByLabelText(/I have seen this/) as HTMLInputElement).checked).toBe(false);
    // Its third-place match adds one more match (16 entries: 14 in the consolation draw).
    expect(screen.getByRole("group", { name: "What the feed-in consolation draw adds" }).textContent).toContain("Consolation draw: 14 matches");
    fireEvent.click(screen.getByLabelText(/Advanced: feed-in consolation/));
    expect(screen.queryByRole("group", { name: "What the feed-in consolation draw adds" })).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("Open Singles, November"), { target: { value: "Plain Plate" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Set it up and hold the courts" })[0]);
    await act(async () => {});
    expect(posts.at(-1)).toMatchObject({ body: { confirmFeedIn: false, rules: { bracket: { consolation: true, consolationMode: "first_round" } } } });
  });
});

describe("a tournament that exists", () => {
  async function opened() {
    detail = open;
    render(<TournamentsTab venues={[venue]} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await act(async () => {});
  }

  it("M5: choosing it shows what it adds for the entries it has and saves nothing until confirmed; confirming saves with the confirmation", async () => {
    await opened();
    const feed = screen.getByLabelText(/Advanced: feed-in consolation/) as HTMLInputElement;
    fireEvent.click(feed);
    await act(async () => {});
    expect(posts).toHaveLength(0);
    const box = screen.getByRole("group", { name: "What the feed-in consolation draw adds" });
    expect(box.textContent).toContain("for 6 entries");
    expect(box.textContent).toContain("Main draw: 5 matches");
    expect(box.textContent).toContain("Consolation draw: 3 matches");
    // Two courts for two days of twelve hours hold these eight matches easily.
    expect(box.textContent).toContain("is enough for the");
    fireEvent.click(screen.getByRole("button", { name: /Confirm: this adds 3 matches and about 1\.5 court hours/ }));
    await act(async () => {});
    expect(posts.at(-1)).toMatchObject({ url: "/api/admin/tournaments/9", body: { action: "rules", confirmFeedIn: true, rules: { bracket: { consolation: true, consolationMode: "feed_in" } } } });
  });

  it("M5: keeping it as it is leaves it unsaved", async () => {
    await opened();
    fireEvent.click(screen.getByLabelText(/Advanced: feed-in consolation/));
    fireEvent.click(screen.getByRole("button", { name: "Keep it as it is" }));
    await act(async () => {});
    expect(posts).toHaveLength(0);
    expect(screen.queryByRole("group", { name: "What the feed-in consolation draw adds" })).toBeNull();
  });

  it("S3: one that has it shows what it adds, and turning the consolation draw off sends the first round with it", async () => {
    detail = { ...open, rules: { ...open.rules, bracket: { consolation: true, consolationThirdPlace: false, grandFinalReset: true, consolationMode: "feed_in" } } };
    render(<TournamentsTab venues={[venue]} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await act(async () => {});
    expect((screen.getByLabelText(/Advanced: feed-in consolation/) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByRole("group", { name: "What the feed-in consolation draw adds" }).textContent).toContain("Consolation draw: 3 matches");
    fireEvent.click(screen.getByLabelText(/Consolation draw for first-round losers/));
    await act(async () => {});
    expect(posts.at(-1)).toMatchObject({ body: { action: "rules", rules: { bracket: { consolation: false, consolationMode: "first_round" } } } });
    expect(posts.at(-1)!.body).not.toHaveProperty("confirmFeedIn");
  });

  it("S3: it is fixed once the draw is made", async () => {
    detail = { ...open, status: "drawn", rules: { ...open.rules, bracket: { consolation: true, consolationThirdPlace: false, grandFinalReset: true, consolationMode: "feed_in" } } };
    render(<TournamentsTab venues={[venue]} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await act(async () => {});
    expect((screen.getByLabelText(/Advanced: feed-in consolation/) as HTMLInputElement).disabled).toBe(true);
    expect(screen.queryByRole("group", { name: "What the feed-in consolation draw adds" })).toBeNull();
  });
});
