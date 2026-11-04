// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useParams: () => ({ id: "5" }) }));

import RatingsPage from "../../src/app/ratings/page";
import RankingsPage from "../../src/app/venue/[id]/rankings/page";
import { RatingsPanel } from "../../src/components/admin/RatingsPanel";
import { StaffMayProvider } from "../../src/components/admin/StaffMay";
import type { ManagedVenue } from "../../src/components/admin/shared";
import { staffMay } from "../../src/lib/roles";
import type { Board, StaffRatings } from "../../src/lib/ratings";

/**
 * The screens for a venue's ranking policy: the public page's separate provisional section (not ranked, not in order, said to be a
 * rating that may move a lot), the estimate note on the public and player pages, and the manager's switches.
 */

afterEach(cleanup);

const json = (body: unknown, ok = true, status = 200) => ({ ok, status, headers: new Headers({ "content-type": "application/json" }), json: async () => body, text: async () => JSON.stringify(body) });

const board = (over: Partial<Board> = {}): Board => ({
  venueId: 5,
  venueName: "MCP Arena",
  sport: "badminton",
  format: "singles",
  season: "all",
  rows: [{ rank: 1, kind: "person", name: "Lena L", rating: 1120, games: 9, wins: 7, draws: 0, losses: 2, form: ["W", "W", "L"] }],
  rankAfter: 8,
  provisional: [
    { kind: "person", name: "Aiman A", rating: 1034, games: 5 },
    { kind: "team", name: "Shuttle Club", rating: 980, games: 3 },
  ],
  ...over,
});

describe("a venue's public rankings", () => {
  const serve = (b: Board) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const choices = { pools: [{ sport: "badminton", format: "singles" }], seasons: [2026] };
        const rules = { provisionalGames: 8, rankAfter: 8, showProvisional: true };
        return url.includes("sport=") ? json({ choices, rules, board: b }) : json({ choices, rules });
      })
    );

  it("shows who is not ranked yet in a block of its own: titled, explained, no rank, no order of merit", async () => {
    serve(board());
    render(<RankingsPage />);
    const section = await screen.findByTestId("provisional");
    expect(within(section).getByRole("heading", { name: "Provisional: fewer than 8 rated results; these ratings may move a lot" })).toBeTruthy();
    expect(within(section).getByText(/These players and teams are not ranked/)).toBeTruthy();
    expect(within(section).getByText("Aiman A")).toBeTruthy();
    expect(within(section).getByText("Shuttle Club")).toBeTruthy();
    // No rank column, no rank numbers: name, rating and results counted only.
    const heads = within(section).getAllByRole("columnheader").map((h) => h.textContent);
    expect(heads).toEqual(["Name", "Rating", "Played"]);
    expect(within(section).queryByText("Rank")).toBeNull();
    // The ranked table is a different element, and does not contain them.
    const ranked = screen.getByTestId("rankings");
    expect(ranked.contains(section)).toBe(false);
    expect(within(ranked).queryByText("Aiman A")).toBeNull();
    expect(within(ranked).getByText("Lena L")).toBeTruthy();
    // Said everywhere: an estimate, which N results do not make exact.
    expect(screen.getByText(/A rating is an estimate worked out from the results counted\. With few results it can move a lot, and 8 results do not make it exact\./)).toBeTruthy();
  });

  it("shows no provisional block where the venue did not choose it", async () => {
    serve(board({ provisional: [] }));
    render(<RankingsPage />);
    expect(await screen.findByText("Lena L")).toBeTruthy();
    expect(screen.queryByTestId("provisional")).toBeNull();
  });

  it("uses the venue's own number in what it says", async () => {
    serve(board({ rankAfter: 12 }));
    render(<RankingsPage />);
    expect((await screen.findByTestId("provisional")).textContent).toContain("fewer than 12 rated results");
  });
});

describe("a player's ratings say what a rating is", () => {
  it("says it is an estimate, and each venue chooses how many counted results rank a player; a pool says how many more it needs there", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json({
          ratings: {
            who: [{ participantId: null, name: null, pools: [{ venueId: 5, venueName: "MCP Arena", sport: "badminton", format: "singles", rating: 1020, games: 3, wins: 2, draws: 0, losses: 1, provisional: true, rankAfter: 5, earns: null, form: ["W"] }] }],
            teams: [],
          },
          rules: { start: 1000, provisionalGames: 8, matchBand: 100 },
        })
      )
    );
    render(<RatingsPage />);
    // The venue's number (5), not the install's (8): two more to go.
    expect(await screen.findByText(/Provisional: 2 more counted results before it is ranked/)).toBeTruthy();
    expect(screen.getByText(/do not make it exact/)).toBeTruthy();
    expect(screen.getByText(/Each venue chooses how many counted results a player needs to be ranked there/)).toBeTruthy();
  });
});

describe("the manager's switches", () => {
  const venue = { id: 5 } as unknown as ManagedVenue;
  const view = (over: Partial<NonNullable<StaffRatings["policy"]>> = {}): StaffRatings => ({
    events: [],
    businessBoard: false,
    inBusiness: false,
    pools: [],
    results: [],
    resets: [],
    hasRated: true,
    policy: { venueId: 5, publicRankings: false, showProvisional: false, rankAfter: 8, installDefault: 8, custom: false, updatedAt: null, updatedBy: null, ...over },
    policyLog: [{ kind: "public_rankings", subject: null, from: "off", to: "on", by: "Mira", at: "2026-11-04 09:30:00" }],
  });
  const posts: Record<string, unknown>[] = [];
  let current: StaffRatings;
  beforeEach(() => {
    posts.length = 0;
    current = view();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { method?: string; body?: string }) => {
        if (init?.method === "POST") posts.push(JSON.parse(init.body ?? "{}"));
        return json({ ratings: current });
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
  const mount = async () => {
    render(
      <StaffMayProvider may={staffMay("manager")}>
        <RatingsPanel venue={venue} />
      </StaffMayProvider>
    );
    await open();
  };

  it("tells a venue with rated results that its rankings are not public, and offers the switch, off", async () => {
    await mount();
    expect((await screen.findByRole("status")).textContent).toContain("its rankings are not public");
    const pub = screen.getByRole("checkbox", { name: /Publish this venue's rankings/ }) as HTMLInputElement;
    expect(pub.checked).toBe(false);
    // The provisional section cannot be asked for while public rankings are off.
    expect((screen.getByRole("checkbox", { name: /not ranked yet, in a separate section/ }) as HTMLInputElement).disabled).toBe(true);
    await act(async () => {
      fireEvent.click(pub);
    });
    expect(posts.at(-1)).toEqual({ venueId: 5, action: "policy", publicRankings: true });
  });

  it("sets how many counted results rank a player, within 3 to 30, and goes back to the default", async () => {
    current = view({ publicRankings: true, rankAfter: 12, custom: true });
    await mount();
    const input = (await screen.findByLabelText("Counted results before a player is ranked")) as HTMLInputElement;
    expect(input.value).toBe("12");
    expect(input.min).toBe("3");
    expect(input.max).toBe("30");
    expect(screen.getByText(/3 to 30\. The default is 8\./)).toBeTruthy();
    const save = screen.getByRole("button", { name: "Save" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await act(async () => {
      fireEvent.change(input, { target: { value: "5" } });
    });
    expect(save.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(save);
    });
    expect(posts.at(-1)).toEqual({ venueId: 5, action: "policy", rankAfter: 5 });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Use the default" }));
    });
    expect(posts.at(-1)).toEqual({ venueId: 5, action: "policy", rankAfter: null });
    // What it does and does not change, and the estimate said.
    expect(screen.getByText(/It never changes a rating or the ledger\./)).toBeTruthy();
    expect(screen.getAllByText(/estimate/).length).toBeGreaterThan(0);
  });

  it("offers the provisional section once public, a ledger download, and who changed what", async () => {
    current = view({ publicRankings: true });
    await mount();
    const prov = (await screen.findByRole("checkbox", { name: /not ranked yet, in a separate section/ })) as HTMLInputElement;
    expect(prov.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(prov);
    });
    expect(posts.at(-1)).toEqual({ venueId: 5, action: "policy", showProvisional: true });
    expect(screen.getByRole("link", { name: "Download the ledger (CSV)" }).getAttribute("href")).toBe("/api/admin/ratings?venueId=5&export=ledger");
    expect(screen.getByText("2026-11-04 09:30, Mira: public rankings, off to on")).toBeTruthy();
    // No prompt once they are public.
    expect(screen.queryByRole("status")).toBeNull();
  });
});
