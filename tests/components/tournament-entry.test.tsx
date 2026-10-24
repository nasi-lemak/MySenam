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
    fireEvent.click(screen.getByRole("button", { name: /Enter/ }));
    await act(async () => {});
    expect(posts.at(-1)).toMatchObject({ action: "enter", partnerName: "Mei Ling", birthDate: "2012-03-14", partnerBirthDate: "2013-07-01" });
  });
});
