// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useParams: () => ({ id: "5" }) }));

import RatingsPage from "../../src/app/ratings/page";
import RankingsPage from "../../src/app/venue/[id]/rankings/page";
import { RatingsPanel } from "../../src/components/admin/RatingsPanel";
import { StaffMayProvider } from "../../src/components/admin/StaffMay";
import type { ManagedVenue } from "../../src/components/admin/shared";
import { staffMay } from "../../src/lib/roles";
import type { HistoryLine, MyRatings, StaffRatings } from "../../src/lib/ratings";

/**
 * The screens for ratings (lib/ratings.ts): a player's own ratings with how each result moved them, a venue's public
 * rankings, and a manager's panel (which events count, leaving a result out, starting a rating again).
 */

afterEach(cleanup);

const json = (body: unknown, ok = true, status = 200) => ({ ok, status, headers: new Headers({ "content-type": "application/json" }), json: async () => body, text: async () => JSON.stringify(body) });

const line = (over: Partial<HistoryLine> = {}): HistoryLine => ({
  resultId: 1,
  eventName: "Club Cup",
  playedOn: "2026-11-02",
  kind: "played",
  result: "win",
  opponents: [{ label: "Lim Wei", junior: false }],
  counted: true,
  excluded: false,
  ratingBefore: 1000,
  ratingAfter: 1020,
  change: 20,
  k: 40,
  expected: 50,
  expectedExact: true,
  opponentRating: 1000,
  weight: 1,
  marginFactor: 1,
  beforeReset: false,
  ...over,
});

describe("a player's ratings", () => {
  const mine: MyRatings = {
    who: [
      {
        participantId: null,
        name: null,
        pools: [{ venueId: 5, venueName: "MCP Arena", sport: "badminton", format: "singles", rating: 1020, games: 3, wins: 2, draws: 0, losses: 1, provisional: true, earns: null, form: ["W", "L", "W"] }],
      },
      {
        participantId: 9,
        name: "Aina",
        pools: [{ venueId: 5, venueName: "MCP Arena", sport: "badminton", format: "doubles", rating: 1100, games: 10, wins: 7, draws: 0, losses: 3, provisional: false, earns: "advanced", form: ["W"] }],
      },
    ],
    teams: [],
  };
  const urls: string[] = [];
  beforeEach(() => {
    urls.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        urls.push(url);
        if (url.includes("sport=")) {
          return json({
            history: [
              line(),
              line({ resultId: 2, result: "loss", opponents: [{ label: "", junior: true }], expectedExact: false, expected: 60, opponentRating: null, ratingBefore: 1020, ratingAfter: 1000, change: -20 }),
              line({ resultId: 3, kind: "walkover", counted: false, weight: 0, ratingBefore: 1000, ratingAfter: 1000, change: 0 }),
              line({ resultId: 4, excluded: true, ratingBefore: null, ratingAfter: null, change: null }),
            ],
          });
        }
        return json({ ratings: mine, rules: { start: 1000, provisionalGames: 8, matchBand: 100 } });
      })
    );
  });

  it("shows each rating with whether it is provisional, a child's under their name, and says how each result moved it", async () => {
    render(<RatingsPage />);
    expect(await screen.findByText("Your ratings")).toBeTruthy();
    // Provisional until it has counted results: how many more, never "ranked".
    expect(screen.getByText(/Provisional: 5 more counted results before it is ranked/)).toBeTruthy();
    // The child's, under the child's name, with the level it earns once it is not provisional.
    expect(screen.getByText("For Aina")).toBeTruthy();
    expect(screen.getByText(/This rating earns the level: Advanced/)).toBeTruthy();
    expect(screen.getAllByTestId("rating-pool")).toHaveLength(2);
    await act(async () => {
      fireEvent.click(screen.getAllByText("How each result moved it")[0]);
    });
    expect(urls.some((u) => u.includes("venueId=5&sport=badminton&format=singles"))).toBe(true);
    expect((await screen.findAllByText(/Won against Lim Wei/)).length).toBeGreaterThan(0);
    // The rule, in numbers: what the rating expected and how far it moved.
    expect(screen.getByText(/Your rating was 1000; it was given a 50% chance\. It moved by \+20 to 1020 \(K 40\)\. Their rating then: 1000\./)).toBeTruthy();
    // A child opponent is "a junior player"; their rating is not shown and the chance is to the nearest ten.
    expect(screen.getByText(/Lost to a junior player/)).toBeTruthy();
    expect(screen.getByText(/about a 60% chance.*Their rating is private\./)).toBeTruthy();
    expect(screen.getByText("A walkover moves no rating.")).toBeTruthy();
    expect(screen.getByText("The venue left this result out of the ratings.")).toBeTruthy();
  });

  it("asks a stranger to sign in", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "Please sign in." }, false, 401)));
    render(<RatingsPage />);
    expect(await screen.findByText("Sign in to see your ratings.")).toBeTruthy();
  });
});

describe("a venue's public rankings", () => {
  it("lists only what the route sends, with the provisional rule said and a table a screen reader can read", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (!url.includes("sport=")) return json({ choices: { pools: [{ sport: "badminton", format: "singles" }], seasons: [2026] }, rules: { provisionalGames: 8 } });
        return json({
          choices: { pools: [{ sport: "badminton", format: "singles" }], seasons: [2026] },
          rules: { provisionalGames: 8 },
          board: { venueId: 5, venueName: "MCP Arena", sport: "badminton", format: "singles", season: "all", rows: [{ rank: 1, kind: "person", name: "Lena L", rating: 1120, games: 9, wins: 7, draws: 0, losses: 2, form: ["W", "W", "L"] }, { rank: 2, kind: "team", name: "Shuttle Club", rating: 1050, games: 9, wins: 5, draws: 0, losses: 4, form: [] }] },
        });
      })
    );
    render(<RankingsPage />);
    expect((await screen.findAllByText("Rankings at MCP Arena")).length).toBeGreaterThan(0);
    expect(screen.getByText(/everybody here has at least 8 counted results/)).toBeTruthy();
    expect(await screen.findByText("Lena L")).toBeTruthy();
    expect(screen.getByText("Shuttle Club")).toBeTruthy();
    expect(screen.getByText("(team)")).toBeTruthy();
    const table = screen.getByTestId("rankings");
    expect(table.querySelectorAll("th[scope='col']").length).toBe(6);
    expect(screen.getByText("1120")).toBeTruthy();
  });

  it("says so when there is nothing rated or the venue is not found", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ choices: { pools: [], seasons: [] }, rules: { provisionalGames: 8 } })));
    render(<RankingsPage />);
    expect(await screen.findByText("Nothing is rated here yet.")).toBeTruthy();
    cleanup();
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "Venue not found." }, false, 404)));
    render(<RankingsPage />);
    expect(await screen.findByText("That venue was not found.")).toBeTruthy();
  });
});

describe("the manager's panel", () => {
  const venue = { id: 5 } as unknown as ManagedVenue;
  const view: StaffRatings = {
    events: [
      { kind: "tournament", id: 1, name: "Club Cup", sport: "badminton", rated: true, canChange: true, counted: 0 },
      { kind: "league", id: 2, name: "Ladder", sport: "badminton", rated: true, canChange: false, counted: 4 },
    ],
    businessBoard: false,
    inBusiness: true,
    pools: [{ sport: "badminton", format: "singles", subjects: [{ kind: "user", id: 7, label: "Lim Wei", rating: 1040, games: 9, provisional: false, wins: 6, draws: 0, losses: 3 }, { kind: "participant", id: 8, label: "(junior player)", rating: 990, games: 2, provisional: true, wins: 1, draws: 0, losses: 1 }] }],
    results: [
      { sourceKind: "tournament", sourceId: 1, sourceMatch: 11, unitNo: 0, sport: "badminton", format: "singles", eventName: "Club Cup", playedOn: "2026-11-02", sides: { a: "Lim Wei", b: "Tan" }, outcome: 1, kind: "played", counted: true, excluded: null },
      { sourceKind: "tournament", sourceId: 1, sourceMatch: 12, unitNo: 0, sport: "badminton", format: "singles", eventName: "Club Cup", playedOn: "2026-11-02", sides: { a: "Lee", b: "Tan" }, outcome: 0, kind: "walkover", counted: false, excluded: { id: 3, reason: "Wrong court", by: "Mira", at: "2026-11-02" } },
    ],
    resets: [],
  };
  const posts: Record<string, unknown>[] = [];
  beforeEach(() => {
    posts.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
        if (init?.method === "POST") {
          posts.push(JSON.parse(init.body ?? "{}"));
          return json({ ratings: view });
        }
        return json({ ratings: view });
      })
    );
  });
  const open = async () => {
    const summary = screen.getByText("Ratings and rankings");
    await act(async () => {
      (summary.closest("details") as HTMLDetailsElement).open = true;
      fireEvent(summary.closest("details")!, new Event("toggle"));
    });
  };

  it("lets a manager choose events, leave a result out and start a rating again, each with a reason", async () => {
    render(
      <StaffMayProvider may={staffMay("manager")}>
        <RatingsPanel venue={venue} />
      </StaffMayProvider>
    );
    await open();
    expect((await screen.findAllByText("Club Cup")).length).toBeGreaterThan(0);
    // An event that has started cannot be changed; one that has not can.
    expect((screen.getByRole("checkbox", { name: /Ladder/ }) as HTMLInputElement).disabled).toBe(true);
    await act(async () => {
      fireEvent.click(screen.getByRole("checkbox", { name: /Club Cup/ }));
    });
    expect(posts.at(-1)).toMatchObject({ venueId: 5, action: "rated", kind: "tournament", id: 1, rated: false });
    // A child is shown as a junior, never by a name.
    expect(screen.getByText("(junior player)")).toBeTruthy();
    // Leaving a result out asks for a reason first.
    await act(async () => {
      fireEvent.click(screen.getAllByText("Leave out")[0]);
    });
    const confirm = screen.getByText("Leave it out") as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Why leave this result out of the ratings?"), { target: { value: "Played on the wrong court" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByText("Leave it out"));
    });
    expect(posts.at(-1)).toMatchObject({ action: "exclude", sourceKind: "tournament", sourceId: 1, sourceMatch: 11, reason: "Played on the wrong court" });
    // One already left out says who and why, and can be put back.
    expect(screen.getByText("Left out by Mira: Wrong court")).toBeTruthy();
    // Starting a rating again asks for a reason and says what it keeps.
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "Start again" })[0]);
    });
    expect(screen.getByText(/stay in the ledger and still count for the people who played them/)).toBeTruthy();
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Why start Lim Wei's rating again?"), { target: { value: "Back from a break" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByText("Start this rating again"));
    });
    expect(posts.at(-1)).toMatchObject({ action: "reset", sport: "badminton", format: "singles", subjectKind: "user", subjectId: 7, reason: "Back from a break" });
  });

  it("shows the front desk nothing", async () => {
    render(
      <StaffMayProvider may={staffMay("desk")}>
        <RatingsPanel venue={venue} />
      </StaffMayProvider>
    );
    expect(screen.queryByText("Ratings and rankings")).toBeNull();
  });
});
