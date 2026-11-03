// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useParams: () => ({ id: "5" }) }));

import TeamPage from "../../src/app/teams/[id]/page";
import TeamLeaguePage from "../../src/app/team-leagues/[id]/page";
import { TeamEntry } from "../../src/components/TeamEntry";
import { translator } from "../../src/lib/i18n";
import { DEFAULT_RULES } from "../../src/lib/tournament-rules";

/**
 * The customer screens for teams and leagues of teams: a team page for its members (a child named only where it may
 * be), the team picker on a team event's entry form, and a league's fixtures with the captain's report.
 */

afterEach(cleanup);

const team = {
  id: 5,
  name: "Shuttle Club",
  sport: "badminton",
  venueId: null,
  venueName: null,
  groupId: null,
  groupName: null,
  description: null,
  published: false,
  status: "active",
  captainName: "Amir",
  members: 3,
  isCaptain: true,
  mine: [{ memberId: 1, participantId: null, role: "captain" }],
  invitations: [],
  roster: [
    { id: 1, role: "captain", name: "Amir", junior: false, mine: true, birthDeclared: false, genderDeclared: false, joinedAt: "2026-11-01" },
    { id: 2, role: "member", name: "Bala", junior: false, mine: false, birthDeclared: true, genderDeclared: false, joinedAt: "2026-11-02" },
    { id: 3, role: "member", name: null, junior: true, mine: false, birthDeclared: false, genderDeclared: false, joinedAt: "2026-11-03" },
  ],
};

describe("a team's page", () => {
  const posts: { url: string; body: Record<string, unknown> }[] = [];
  beforeEach(() => {
    posts.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
        if (init?.method && init.method !== "GET") {
          posts.push({ url, body: JSON.parse(init.body ?? "{}") });
          return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ team, link: "http://localhost/team-invitation?token=abcdefghijklmnopqrstuvwxyz" }), text: async (): Promise<string> => "" };
        }
        const body = url.includes("/history") ? { history: { tournaments: [], leagues: [] } } : url.includes("/api/my/people") ? { people: [{ id: 9, displayName: "Mia" }] } : { team, signedIn: true };
        return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => body, text: async () => JSON.stringify(body) };
      })
    );
  });

  it("names a child only where it may, shows the captain's tools, and makes a link once", async () => {
    render(<TeamPage />);
    expect(await screen.findByText("Shuttle Club", { exact: false })).toBeTruthy();
    expect(screen.getByText("Bala")).toBeTruthy();
    // The child the captain cannot name for another's guardian is "a junior player".
    expect(screen.getByText("A junior player")).toBeTruthy();
    expect(screen.getByText("Invite somebody")).toBeTruthy();
    expect(screen.getByText("This team is not published: only its members can see it.")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByText("Make a link to share"));
    });
    expect(posts.at(-1)).toMatchObject({ url: "/api/teams/5", body: { action: "inviteLink" } });
    expect(await screen.findByText("Your link (shown once)")).toBeTruthy();
    expect((screen.getByLabelText("Your link (shown once)") as HTMLInputElement).value).toContain("team-invitation?token=");
    // Handing the team on is offered for a member with an account, never for a child.
    expect(screen.getAllByText("Make captain")).toHaveLength(1);
  });

  it("does not show a stranger anything but the name", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const body = { team: { id: 5, name: "Shuttle Club", sport: "badminton", published: true, status: "active", members: 0, venueName: null, description: null }, signedIn: false };
        return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => body, text: async () => JSON.stringify(body) };
      })
    );
    render(<TeamPage />);
    expect(await screen.findByText("This team's name is public. Nothing else about it is.")).toBeTruthy();
    expect(screen.queryByText("Members")).toBeNull();
    expect(screen.queryByText("Invite somebody")).toBeNull();
  });
});

describe("the team picker on a team event's entry", () => {
  it("picks the roster from the team's members and enters it by the team's id, sending no typed names", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const body = url.startsWith("/api/teams?captain=1") ? { captained: [{ id: 5, name: "Shuttle Club", members: 3 }] } : { team };
        return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => body, text: async () => JSON.stringify(body) };
      })
    );
    const act2 = vi.fn(async () => undefined);
    render(<TeamEntry t={translator("en")} sport="badminton" roster={{ min: 2, max: 4 }} act={act2} />);
    expect(await screen.findByText("Enter a team you captain")).toBeTruthy();
    await screen.findByLabelText("Bala");
    await act(async () => {
      fireEvent.click(screen.getByLabelText("Amir"));
      fireEvent.click(screen.getByLabelText("Bala"));
    });
    // A child is offered by the junior label for the captain's own view only.
    expect(screen.getByLabelText("A junior player")).toBeTruthy();
    await act(async () => {
      fireEvent.submit(screen.getByText("Enter").closest("form")!);
    });
    expect(act2).toHaveBeenCalledWith({ action: "enter", teamId: 5, rosterMemberIds: [1, 2] });
  });

  it("is not shown to somebody who captains no team of the sport", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => ({ captained: [] }), text: async () => JSON.stringify({ captained: [] }) }))
    );
    const { container } = render(<TeamEntry t={translator("en")} sport="badminton" roster={null} act={async () => undefined} />);
    await act(async () => undefined);
    expect(container.innerHTML).toBe("");
  });
});

const league = {
  id: 5,
  venueId: 1,
  venueName: "Arena",
  name: "Premier League",
  sport: "badminton",
  template: "racket_best_of_3",
  rules: DEFAULT_RULES,
  rubbers: ["singles", "doubles", "singles"],
  table: { tablePoints: { win: 3, draw: 1, loss: 0 }, rankBy: ["points"] },
  legs: 1,
  category: "open",
  ageRange: null,
  membersOnly: false,
  level: null,
  description: null,
  startsOn: "2026-12-01",
  endsOn: "2027-02-01",
  slotsPerNight: 2,
  maxTeams: 8,
  entriesCloseOn: null,
  rosterMin: 2,
  rosterMax: 6,
  maxRubbersPerPlayer: 2,
  rubberMinutes: 45,
  status: "scheduled",
  courts: [{ id: 1, name: "Court 1" }],
  nights: [{ id: 1, no: 1, date: "2026-12-01", startMin: 540 }],
  teams: 2,
  entered: [
    { id: 11, name: "Shuttle Club", withdrawn: false, homeCourtId: null, captain: true, blackouts: [], teamId: 5, roster: [{ memberId: 1, name: "Amir", junior: false }] },
    { id: 12, name: "Net Gains", withdrawn: false, homeCourtId: null },
  ],
  standings: [
    { entryId: 12, leagueTeamId: 12, name: "Net Gains", played: 1, won: 1, drawn: 0, lost: 0, setDiff: 0, setsWon: 0, setsLost: 0, pointsFor: 3, pointsAgainst: 0, pointDiff: 3, points: 3, withdrawn: false, position: 1 },
    { entryId: 11, leagueTeamId: 11, name: "Shuttle Club", played: 1, won: 0, drawn: 0, lost: 1, setDiff: 0, setsWon: 0, setsLost: 0, pointsFor: 0, pointsAgainst: 3, pointDiff: -3, points: 0, withdrawn: false, position: 2 },
  ],
  mine: [{ leagueTeamId: 11, captain: true }],
  fixtures: [
    {
      id: 21,
      leg: 1,
      round: 1,
      nightNo: 1,
      date: "2026-12-01",
      startMin: 540,
      minutes: 135,
      courtId: 1,
      courtName: "Court 1",
      home: { id: 11, name: "Shuttle Club" },
      away: { id: 12, name: "Net Gains" },
      status: "scheduled",
      version: 3,
      forfeitBy: null,
      reportedBy: null,
      result: null,
      rubbers: [
        { no: 1, kind: "singles", score: null, winner: null, played: false, walkover: false },
        { no: 2, kind: "doubles", score: null, winner: null, played: false, walkover: false },
        { no: 3, kind: "singles", score: null, winner: null, played: false, walkover: false },
      ],
      mine: { side: "home", leagueTeamId: 11 },
    },
  ],
};

describe("a league of teams", () => {
  const posts: Record<string, unknown>[] = [];
  beforeEach(() => {
    posts.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: { method?: string; body?: string }) => {
        if (init?.method === "POST") posts.push(JSON.parse(init.body ?? "{}"));
        const body = { league, captained: [], signedIn: true };
        return { ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => body, text: async () => JSON.stringify(body) };
      })
    );
  });

  it("shows the table and the fixtures by name, and lets the captain report each game with the version seen", async () => {
    render(<TeamLeaguePage />);
    expect(await screen.findByText("Table")).toBeTruthy();
    expect(screen.getAllByText("Net Gains").length).toBeGreaterThan(0);
    expect(screen.getByText("Night 1 · 2026-12-01")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByText("Report the result"));
    });
    const selects = screen.getAllByRole("combobox").filter((s) => (s as HTMLSelectElement).name === "");
    expect(selects.length).toBeGreaterThanOrEqual(3);
    // Each game's winner and score, then sent with the fixture's version.
    for (const [i, name] of ["Singles 1", "Doubles 1", "Singles 2"].entries()) {
      await act(async () => {
        fireEvent.change(screen.getByLabelText(`${name}: Winner`), { target: { value: "home" } });
        fireEvent.change(screen.getByLabelText(`${name}: Score`), { target: { value: i === 1 ? "21-18, 19-21, 21-15" : "21-10, 21-12" } });
      });
    }
    await act(async () => {
      fireEvent.submit(screen.getByText("Send the result").closest("form")!);
    });
    expect(posts.at(-1)).toMatchObject({
      action: "report",
      fixtureId: 21,
      version: 3,
      rubbers: [
        { winner: "home", score: "21-10, 21-12" },
        { winner: "home", score: "21-18, 19-21, 21-15" },
        { winner: "home", score: "21-10, 21-12" },
      ],
    });
  });

  it("offers a captain's own team its roster and the dates it cannot play, and a withdrawal", async () => {
    render(<TeamLeaguePage />);
    expect(await screen.findByText("Your team: Shuttle Club")).toBeTruthy();
    expect(screen.getByText("Withdraw the team")).toBeTruthy();
    expect(screen.getByText("Save the dates")).toBeTruthy();
  });
});
