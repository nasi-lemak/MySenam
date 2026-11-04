// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useParams: () => ({ token: "tok-climb" }) }));

import OfficialPage from "../../src/app/officials/[token]/page";
import { DEFAULT_RULES } from "../../src/lib/tournament-rules";

/**
 * An official's page for a climbing event (docs/features/tournaments.md#officials-and-counted-results): the grid for a round still open,
 * saved under the link; a finished round read-only with a way to ask for a correction; their requests, with a way to take one back.
 */

const counted = { kind: "boulders" as const, units: 2, rankBy: ["tops", "zones"], countback: false, finalStart: "reverse", cutTies: "choose" };
const tournament = {
  id: 9,
  name: "Wall Cup",
  venueName: "Boulder Barn",
  rules: { ...DEFAULT_RULES, performance: { counted } },
  entries: [
    { id: 1, name: "Aina", status: "entered" },
    { id: 2, name: "Bala", status: "entered" },
    { id: 3, name: "Chen", status: "entered" },
  ],
  matches: [
    { id: 60, stage: "heat", position: 1, a: null, b: null, courtName: "Wall", date: "2026-12-05", minute: 540, status: "scheduled" },
    { id: 61, stage: "heat", position: 2, a: null, b: null, courtName: "Wall", date: "2026-12-05", minute: 600, status: "done" },
  ],
  performance: {
    lines: {
      60: [
        { entryId: 1, lane: 1, status: "pending", attempts: [], result: null, shown: null, rank: null, counts: [] },
        { entryId: 2, lane: 2, status: "pending", attempts: [], result: null, shown: null, rank: null, counts: [] },
      ],
      61: [{ entryId: 3, lane: 1, status: "ok", attempts: [], result: 1, shown: "1T 1Z", rank: 1, counts: [{ unit: 1, attempts: 1, zone: 1, top: 1 }] }],
    },
  },
};
const performance = {
  rounds: [
    { matchId: 60, lock: null },
    { matchId: 61, lock: "finalised" },
  ],
  recent: [{ matchId: 60, entry: "Aina", was: null, now: "1T 1Z", at: "2026-12-05 09:10:00" }],
  requests: [{ id: 7, matchId: 61, officialName: "Judge Jo", reason: "Boulder 2 was topped", lines: [], status: "open", createdAt: "", decidedBy: null, decidedAt: null, decisionNote: null }],
};

const posts: { url: string; body: Record<string, unknown> }[] = [];
beforeEach(() => {
  posts.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === "POST") posts.push({ url, body: JSON.parse(init.body ?? "{}") });
      return { ok: true, json: async () => ({ official: { id: 3, name: "Judge Jo" }, tournament, performance }) };
    })
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("a climbing event's official page", () => {
  it("shows the grid for an open round and saves the counts under the link", async () => {
    render(<OfficialPage />);
    await act(async () => {});
    expect(screen.getByText(/Enter the counts for the rounds still open/)).toBeTruthy();
    // The boulder buttons carry the climber's name and the boulder, for a phone held at the wall.
    fireEvent.click(screen.getByRole("button", { name: "Add an attempt: Aina, boulder 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Top reached: Aina, boulder 1" }));
    fireEvent.click(screen.getByRole("button", { name: "Save the counts" }));
    await act(async () => {});
    const sent = posts.at(-1)!;
    expect(sent.url).toBe("/api/officials/tok-climb");
    expect(sent.body).toMatchObject({ matchId: 60, performances: [{ entryId: 1, status: "ok", counts: [{ unit: 1, attempts: 1, zone: 1, top: 1 }] }] });
  });

  it("shows a finished round read-only, with a way to ask for a correction that needs a reason", async () => {
    render(<OfficialPage />);
    await act(async () => {});
    expect(screen.getByText(/This round is finished, so only the organiser can change its counts/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ask for a correction" }));
    fireEvent.change(screen.getByLabelText("Why it needs correcting"), { target: { value: "Boulder 1 was topped first go" } });
    fireEvent.click(screen.getByRole("button", { name: "Add an attempt: Chen, boulder 2" }));
    fireEvent.click(screen.getByRole("button", { name: "Send the correction request" }));
    await act(async () => {});
    expect(posts.at(-1)!.body).toMatchObject({ action: "correction_request", matchId: 61, reason: "Boulder 1 was topped first go" });
  });

  it("lists their requests and recent entries, and withdraws a waiting request", async () => {
    render(<OfficialPage />);
    await act(async () => {});
    expect(screen.getByText("Your correction requests")).toBeTruthy();
    expect(screen.getByText("Your recent entries")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Withdraw" }));
    await act(async () => {});
    expect(posts.at(-1)!.body).toEqual({ action: "correction_withdraw", requestId: 7 });
  });
});
