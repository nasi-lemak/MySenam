// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

const params = { id: "31" };
vi.mock("next/navigation", () => ({ useParams: () => params }));

import TournamentPage from "../../src/app/tournaments/[id]/page";
import LeaguePage from "../../src/app/leagues/[id]/page";
import { LanguageProvider } from "../../src/components/Language";
import { DEFAULT_RULES } from "../../src/lib/tournament-rules";

/**
 * A guardian entering somebody they act for: the tournament form asks for
 * that person's date of birth, partner and entry mark by their name, not
 * "your"; the fee of an entry or league place made for them says whose it
 * is; the league's join form asks for their partner by their name. The
 * guardian entering themself is asked as before.
 */

const mixedJuniors = {
  id: 31,
  venueId: 1,
  venueName: "Arena Damansara",
  area: "Damansara",
  name: "Junior Mixed Doubles",
  sport: "badminton",
  format: "knockout",
  teamSize: 2,
  entryKind: "player",
  roster: null,
  template: "racket_best_of_3",
  category: "mixed",
  level: null,
  entryFee: 10,
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
  entered: 1,
  waitlisted: 0,
  payOnline: true,
  rules: DEFAULT_RULES,
  competition: null,
  entriesCloseOn: null,
  ageRange: { min: 8, max: 15 },
  membersOnly: false,
  resultsBy: "staff",
  entries: [],
  matches: [],
  groups: [],
  corrections: [],
  issues: [],
  performance: null,
};

const posts: Record<string, unknown>[] = [];
let answer: Record<string, unknown> = {};
beforeEach(() => {
  posts.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === "POST") posts.push(JSON.parse(init.body ?? "{}"));
      return { ok: true, json: async () => answer };
    })
  );
});
afterEach(() => vi.unstubAllGlobals());

const hana = { id: 9, name: "Hana / Adam", status: "entered", seed: null, paid: false, out: null, entryMark: null, checkedIn: false, participantId: 4 };
const people = [
  { id: 4, name: "Hana" },
  { id: 5, name: "Aina" },
];

describe("a tournament entered for somebody the account acts for", () => {
  it("asks for their date of birth, partner and partner's date of birth by their name; the guardian themself is asked as before", async () => {
    answer = { tournament: mixedJuniors, mine: null, managed: [hana], people, signedIn: true };
    render(<TournamentPage />);
    await act(async () => {});
    // The fee of Hana's entry says whose it is (her entry is named with her partner's).
    const pay = screen.getByRole("button", { name: "Pay Hana's RM10.00 entry" });
    expect(screen.queryByRole("button", { name: /Pay my/ })).toBeNull();
    fireEvent.click(pay);
    await act(async () => {});
    expect(posts.at(-1)).toEqual({ action: "pay", entryId: 9 });

    // Myself first: as before.
    expect(screen.getByLabelText("Your date of birth")).toBeTruthy();
    expect(screen.getByLabelText("Your partner's name")).toBeTruthy();
    expect(screen.getByLabelText("Your partner's date of birth")).toBeTruthy();
    expect(screen.getByLabelText("Your partner is")).toBeTruthy();

    fireEvent.change(screen.getByLabelText("Who is entering"), { target: { value: "5" } });
    expect(screen.queryByLabelText("Your date of birth")).toBeNull();
    expect(screen.queryByLabelText("Your partner's name")).toBeNull();
    fireEvent.change(screen.getByLabelText("They are"), { target: { value: "woman" } });
    fireEvent.change(screen.getByLabelText("Aina's partner's name"), { target: { value: "Danial" } });
    fireEvent.change(screen.getByLabelText("Aina's partner is"), { target: { value: "man" } });
    fireEvent.change(screen.getByLabelText("Aina's date of birth"), { target: { value: "2014-02-01" } });
    fireEvent.change(screen.getByLabelText("Aina's partner's date of birth"), { target: { value: "2014-05-01" } });
    fireEvent.click(screen.getByLabelText(/A parent or guardian of each entrant under 18 agrees/));
    fireEvent.click(screen.getByRole("button", { name: "Enter" }));
    await act(async () => {});
    expect(posts.at(-1)).toMatchObject({
      action: "enter",
      participantId: 5,
      gender: "woman",
      partnerName: "Danial",
      partnerGender: "man",
      birthDate: "2014-02-01",
      partnerBirthDate: "2014-05-01",
      guardianConsent: true,
    });
  });

  it("asks for their entry mark by their name, in the customer's language", async () => {
    const swim = { ...mixedJuniors, name: "50m Freestyle", sport: "swimming", format: "performance", teamSize: 1, category: "open", rules: { ...DEFAULT_RULES, performance: { measure: "time" } } };
    answer = { tournament: swim, mine: null, managed: [], people, signedIn: true };
    render(
      <LanguageProvider locale="ms">
        <TournamentPage />
      </LanguageProvider>
    );
    await act(async () => {});
    expect(screen.getByLabelText("Masa atau catatan penyertaan anda (pilihan, untuk penyusunan)")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Siapa yang menyertai"), { target: { value: "4" } });
    expect(screen.getByLabelText("Masa atau catatan penyertaan Hana (pilihan, untuk penyusunan)")).toBeTruthy();
    expect(screen.getByLabelText("Tarikh lahir Hana")).toBeTruthy();
  });
});

describe("a league place held for somebody the account acts for", () => {
  const pairs = {
    id: 31,
    venueId: 1,
    venueName: "Arena Damansara",
    area: "Damansara",
    name: "Junior Pairs",
    sport: "badminton",
    teamSize: 2,
    who: "anyone",
    level: null,
    boxSize: 4,
    moves: 1,
    seasonDays: 28,
    fee: 15,
    description: null,
    status: "running",
    players: 4,
    current: { id: 1, number: 1, startsOn: "2026-11-01", endsOn: "2026-11-28", status: "running" },
    payOnline: true,
    rules: DEFAULT_RULES,
    template: "racket_best_of_3",
    seasons: [{ id: 1, number: 1, startsOn: "2026-11-01", endsOn: "2026-11-28", status: "running" }],
    viewing: { id: 1, number: 1, startsOn: "2026-11-01", endsOn: "2026-11-28", status: "running" },
    boxes: [{ boxNo: 1, table: [] }],
    places: [],
    matches: [],
    people: [{ id: 11, name: "Hana / Adam", status: "active" }],
  };

  it("says whose fee it is, and asks for the partner of the one joining by their name", async () => {
    answer = {
      league: pairs,
      mine: null,
      managed: [
        {
          playerId: 11,
          name: "Hana",
          participantId: 4,
          place: { id: 1, playerId: 11, boxNo: 1, finish: null, move: null, paid: false, withdrawn: false },
          contacts: [],
        },
      ],
      people,
      signedIn: true,
    };
    render(<LeaguePage />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Pay Hana's RM15.00 fee" }));
    await act(async () => {});
    expect(posts.at(-1)).toEqual({ action: "pay", playerId: 11 });

    // Myself first; then Aina.
    expect(screen.getByLabelText("Your partner's name")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Who is joining"), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("Aina's partner's name"), { target: { value: "Danial" } });
    fireEvent.click(screen.getByRole("button", { name: "Join the league" }));
    await act(async () => {});
    expect(posts.at(-1)).toEqual({ action: "join", partnerName: "Danial", participantId: 5 });
  });
});
