// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useParams: () => ({ id: "21" }) }));

import TournamentPage from "../../src/app/tournaments/[id]/page";
import { DEFAULT_RULES } from "../../src/lib/tournament-rules";

/**
 * The public page of a division: it says which competition it is part of
 * and who may enter, and an age range asks the entrant (and a partner) for
 * a date of birth, sent with the entry.
 */

const division = {
  id: 21,
  venueId: 1,
  venueName: "Arena Damansara",
  area: "Damansara",
  name: "Under 16 Doubles",
  sport: "badminton",
  format: "round_robin",
  teamSize: 2,
  entryKind: "pair",
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
  status: "open",
  courtIds: [7],
  entered: 3,
  waitlisted: 0,
  payOnline: false,
  rules: DEFAULT_RULES,
  competition: { id: 3, name: "Junior Open" },
  entriesCloseOn: "2026-11-28",
  ageRange: { min: 10, max: 15 },
  membersOnly: true,
  entries: [],
  matches: [],
  groups: [],
  corrections: [],
  issues: [],
  performance: null,
};

const posts: Record<string, unknown>[] = [];
beforeEach(() => {
  posts.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === "POST") posts.push(JSON.parse(init.body ?? "{}"));
      return { ok: true, json: async () => ({ tournament: division, mine: null, signedIn: true }) };
    })
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("a division's public page", () => {
  it("names its competition and who may enter, and sends the dates of birth an age range asks for", async () => {
    const { container } = render(<TournamentPage />);
    await act(async () => {});
    expect(screen.getByText("A division of Junior Open")).toBeTruthy();
    expect(screen.getByText("Ages 10 to 15 on 2026-12-05 · Members only · Entries close 2026-11-28")).toBeTruthy();
    fireEvent.change(container.querySelector("input:not([type])")!, { target: { value: "Mei Ling" } });
    const dates = container.querySelectorAll('input[type="date"]');
    expect(dates).toHaveLength(2);
    fireEvent.change(dates[0], { target: { value: "2012-03-14" } });
    fireEvent.change(dates[1], { target: { value: "2013-07-01" } });
    // Both under 18 on the first day: a parent or guardian's name and agreement are asked for.
    fireEvent.change(screen.getByLabelText("Parent or guardian's name"), { target: { value: "Aunty Lim" } });
    fireEvent.click(screen.getByLabelText(/A parent or guardian of each entrant under 18 agrees/));
    fireEvent.click(screen.getByRole("button", { name: /Enter/ }));
    await act(async () => {});
    expect(posts.at(-1)).toMatchObject({ action: "enter", partnerName: "Mei Ling", birthDate: "2012-03-14", partnerBirthDate: "2013-07-01", guardianName: "Aunty Lim", guardianConsent: true });
  });
});

describe("players entering their own results", () => {
  const drawn = {
    ...division,
    competition: null,
    ageRange: null,
    membersOnly: false,
    entriesCloseOn: null,
    teamSize: 1,
    entryKind: "player",
    status: "drawn",
    resultsBy: "players",
    entries: [
      { id: 1, name: "Aina", status: "entered", seed: null, paid: false, out: null, entryMark: null },
      { id: 2, name: "Bala", status: "entered", seed: null, paid: false, out: null, entryMark: null },
    ],
    matches: [{ id: 40, stage: "group", groupNo: 1, round: 1, position: 1, a: 1, b: 2, courtId: 7, courtName: "Court 1", date: "2026-12-05", minute: 540, hour: 9, score: null, winner: null, next: null, nextSlot: null, status: "scheduled" }],
  };
  const answer = (reports: unknown[]) =>
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { method?: string; body?: string }) => {
        if (init?.method === "POST") posts.push(JSON.parse(init.body ?? "{}"));
        return { ok: true, json: async () => ({ tournament: drawn, mine: { id: 1, name: "Aina", status: "entered" }, signedIn: true, reports }) };
      })
    );

  it("report their match: who won and the score", async () => {
    answer([]);
    render(<TournamentPage />);
    await act(async () => {});
    fireEvent.change(screen.getByLabelText("Who won"), { target: { value: "1" } });
    fireEvent.change(screen.getByLabelText("Score"), { target: { value: "21-15, 21-18" } });
    fireEvent.click(screen.getByRole("button", { name: "Send the result" }));
    await act(async () => {});
    expect(posts.at(-1)).toEqual({ action: "report", matchId: 40, winner: 1, score: "21-15, 21-18", walkover: false });
  });

  it("confirm what the other side reported, or say it is wrong", async () => {
    answer([{ id: 7, matchId: 40, entryId: 2, winner: 2, score: "15-21, 18-21", walkover: false, status: "pending", createdAt: "2026-12-05 10:00:00" }]);
    render(<TournamentPage />);
    await act(async () => {});
    expect(screen.getByText(/The other side reported Bala won 15-21, 18-21/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "That's right" }));
    await act(async () => {});
    expect(posts.at(-1)).toEqual({ action: "confirm", matchId: 40 });
    fireEvent.click(screen.getByRole("button", { name: "That's wrong" }));
    fireEvent.change(screen.getByLabelText("What is wrong with it?"), { target: { value: "I won the first game" } });
    fireEvent.click(screen.getByRole("button", { name: "That's wrong" }));
    await act(async () => {});
    expect(posts.at(-1)).toEqual({ action: "dispute", matchId: 40, note: "I won the first game" });
  });
});

describe("an entry the server refuses", () => {
  it("says why in an alert, so a screen reader announces it (found by the Teams 3 acceptance scenario)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { method?: string }) =>
        init?.method === "POST"
          ? { ok: false, status: 409, json: async () => ({ error: "Dara Tester is 76 on 2026-12-05: this is for ages 18 to 40." }) }
          : { ok: true, json: async () => ({ tournament: { ...division, competition: null, ageRange: null, membersOnly: false, entriesCloseOn: null, teamSize: 1, entryKind: "player" }, mine: null, signedIn: true }) }
      )
    );
    render(<TournamentPage />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: /Enter/ }));
    await act(async () => {});
    expect(screen.getByRole("alert").textContent).toBe("Dara Tester is 76 on 2026-12-05: this is for ages 18 to 40.");
  });
});
