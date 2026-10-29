// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import type { ReactElement } from "react";
import { TournamentsTab } from "../../src/components/admin/TournamentsTab";
import { StaffMayProvider } from "../../src/components/admin/StaffMay";
import { staffMay, type StaffRole } from "../../src/lib/roles";
import { TEMPLATES } from "../../src/lib/competition-templates";
import { DEFAULT_RULES } from "../../src/lib/tournament-rules";
import { formatMinute } from "../../src/lib/interval";

/**
 * The organiser's screen for a tournament: a performance event's heats are
 * entered lane by lane, and progression a correction left wrong is resolved
 * — let stand or replayed — with a reason and the token of what was reviewed.
 */

const venue = {
  id: 1,
  name: "Sunway Aquatic",
  openMin: 6 * 60,
  closeMin: 22 * 60,
  courts: [{ id: 7, name: "Lap Pool", sport: "swimming", activities: [] }],
} as never;

const base = {
  id: 9,
  venueId: 1,
  venueName: "Sunway Aquatic",
  area: "Subang",
  name: "Club Gala",
  sport: "swimming",
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
  matchMinutes: 10,
  description: null,
  status: "drawn",
  courtIds: [7],
  entered: 2,
  waitlisted: 0,
  payOnline: false,
  groups: [],
  corrections: [],
};

const gala = {
  ...base,
  format: "performance",
  template: "swimming_heats",
  rules: { ...DEFAULT_RULES, performance: { measure: "time", better: "lower", attempts: 1, aggregate: "best", heatSize: 8, finalSize: 8 } },
  entries: [
    { id: 1, name: "Aina", status: "entered", seed: null, paid: false, out: null, entryMark: 61 },
    { id: 2, name: "Bala", status: "entered", seed: null, paid: false, out: null, entryMark: 62 },
  ],
  matches: [{ id: 50, stage: "heat", groupNo: null, round: 1, position: 1, a: null, b: null, courtId: 7, courtName: "Lap Pool", date: "2026-11-20", minute: 540, hour: 9, score: null, winner: null, next: null, nextSlot: null, status: "scheduled" }],
  issues: [],
  performance: {
    lines: {
      50: [
        { entryId: 1, lane: 4, status: "pending", attempts: [], result: null, shown: null, rank: null },
        { entryId: 2, lane: 5, status: "pending", attempts: [], result: null, shown: null, rank: null },
      ],
    },
    ranking: [],
    tieForFinal: null,
  },
};

const cup = {
  ...base,
  name: "Open Cup",
  sport: "badminton",
  format: "knockout",
  template: "racket_best_of_3",
  rules: DEFAULT_RULES,
  entries: [
    { id: 1, name: "Aina", status: "entered", seed: null, paid: false, out: null, entryMark: null },
    { id: 2, name: "Bala", status: "entered", seed: null, paid: false, out: null, entryMark: null },
    { id: 3, name: "Chong", status: "entered", seed: null, paid: false, out: null, entryMark: null },
  ],
  matches: [],
  performance: null,
  issues: [
    {
      id: 4,
      fromMatchId: 70,
      wrongEntry: 1,
      rightEntry: 2,
      affected: [{ matchId: 70, played: true, text: "Final: Aina played instead of Bala against Chong; Aina won 21-18, 21-19." }],
      status: "open",
      createdAt: "2026-11-20 10:00:00",
    },
  ],
};

const championship = {
  id: 3,
  venueId: 1,
  name: "Club Championships",
  sport: "badminton",
  startsOn: "2026-12-05",
  endsOn: "2026-12-06",
  startMin: 540,
  endMin: 1080,
  matchMinutes: 30,
  courtIds: [7],
  maxDivisionsPerPlayer: 2,
  description: null,
  status: "open",
};

let fetchMock: ReturnType<typeof vi.fn>;
let detail: unknown;
const posts: { url: string; body: Record<string, unknown> }[] = [];

beforeEach(() => {
  posts.length = 0;
  fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === "POST") {
      posts.push({ url, body: JSON.parse(init.body ?? "{}") });
      return { ok: true, json: async () => ({ tournament: detail, changes: ["done"] }) };
    }
    if (url.startsWith("/api/admin/tournaments?"))
      return { ok: true, json: async () => ({ tournaments: [detail], competitions: [championship], templates: TEMPLATES, venueTemplates: [] }) };
    if (url.includes("/issues/"))
      return { ok: true, json: async () => ({ issue: cup.issues[0], replay: { possible: true, matches: [{ matchId: 70, name: "Final", needsSlot: true }] }, token: "tok-1" }) };
    return { ok: true, json: async () => ({ tournament: detail }) };
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("confirm", () => true);
});
afterEach(() => vi.unstubAllGlobals());

async function open() {
  render(<TournamentsTab venues={[venue]} />);
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Open" }));
  await act(async () => {});
}

describe("a performance event's heats", () => {
  it("are entered lane by lane, a swimmer who did not start said so, and saved as performances", async () => {
    detail = gala;
    await open();
    fireEvent.change(screen.getByLabelText("Aina attempt 1"), { target: { value: "1:01.20" } });
    fireEvent.change(screen.getByLabelText("Bala status"), { target: { value: "dns" } });
    fireEvent.click(screen.getByRole("button", { name: "Save results" }));
    await act(async () => {});
    expect(posts.at(-1)).toEqual({
      url: "/api/admin/tournaments/9/matches/50",
      body: { performances: [{ entryId: 1, status: "ok", attempts: ["1:01.20"] }, { entryId: 2, status: "dns" }] },
    });
  });
});

describe("progression a correction left wrong", () => {
  it("is shown with what it affects, and resolved only with a reason, against the token reviewed", async () => {
    detail = cup;
    await open();
    expect(screen.getByText(/Under review: Aina went on in place of Bala/)).toBeTruthy();
    expect(screen.getByText(/Final: Aina played instead of Bala/)).toBeTruthy();
    const stand = screen.getByRole("button", { name: "Let the results stand" }) as HTMLButtonElement;
    expect(stand.disabled).toBe(true);
    fireEvent.change(screen.getByPlaceholderText(/Both finalists agreed/), { target: { value: "Both finalists agreed it stands" } });
    expect(stand.disabled).toBe(false);
    fireEvent.click(stand);
    await act(async () => {});
    expect(posts.at(-1)).toEqual({ url: "/api/admin/tournaments/9/issues/4", body: { action: "stand", reason: "Both finalists agreed it stands", token: "tok-1" } });
  });
});

describe("a competition's divisions", () => {
  it("are set up by choosing the competition: its days and courts are shown, not asked, and who may enter goes with the rest", async () => {
    detail = { ...cup, issues: [] };
    const badmintonVenue = { ...(venue as object), courts: [{ id: 7, name: "Court 1", sport: "badminton", activities: [] }] } as never;
    render(<TournamentsTab venues={[badmintonVenue]} />);
    await act(async () => {});
    expect(screen.getByText(/Club Championships/, { selector: "span" })).toBeTruthy();
    fireEvent.change(screen.getByDisplayValue("On its own, holding its own courts"), { target: { value: "3" } });
    expect(screen.getByText(/Played in Club Championships's time/)).toBeTruthy();
    // Only the competition form below still asks for days.
    expect(screen.getAllByText("First day")).toHaveLength(1);
    fireEvent.change(screen.getByPlaceholderText("Open Singles, November"), { target: { value: "Girls Under 12" } });
    fireEvent.change(screen.getByLabelText("Oldest age"), { target: { value: "11" } });
    fireEvent.click(screen.getByLabelText("Members only"));
    fireEvent.click(screen.getAllByRole("button", { name: "Set it up and hold the courts" })[0]);
    await act(async () => {});
    expect(posts.at(-1)).toMatchObject({ url: "/api/admin/tournaments", body: { name: "Girls Under 12", competitionId: 3, ageMin: null, ageMax: 11, membersOnly: true, entriesCloseOn: null } });
  });

  it("start from a competition that holds the courts, with a cap on divisions per player", async () => {
    detail = { ...cup, issues: [] };
    const badmintonVenue = { ...(venue as object), courts: [{ id: 7, name: "Court 1", sport: "badminton", activities: [] }] } as never;
    render(<TournamentsTab venues={[badmintonVenue]} />);
    await act(async () => {});
    fireEvent.click(screen.getByText("Set up a competition with divisions"));
    fireEvent.change(screen.getByPlaceholderText("Club Championships 2026"), { target: { value: "Junior Open" } });
    fireEvent.change(screen.getByLabelText("Divisions per player (optional)"), { target: { value: "2" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Set it up and hold the courts" })[1]);
    await act(async () => {});
    expect(posts.at(-1)).toMatchObject({ url: "/api/admin/competitions", body: { name: "Junior Open", sport: "badminton", courtIds: [7], maxDivisionsPerPlayer: 2 } });
  });
});

describe("on the day", () => {
  const today = {
    ...cup,
    issues: [],
    ageRange: { min: 10, max: 15 },
    thirdPlace: true,
    stageMinutes: {},
    entries: [
      { id: 1, name: "Aina", status: "entered", seed: null, paid: false, out: null, entryMark: null, checkedIn: false, guardian: { name: "Aunty Lim", consentAt: "2026-11-01 10:00:00" }, eligibilityChecked: null },
      { id: 2, name: "Bala", status: "entered", seed: null, paid: false, out: null, entryMark: null, checkedIn: true, guardian: null, eligibilityChecked: { at: "2026-11-20 08:00:00", by: "Desk" } },
    ],
    matches: [
      { id: 70, stage: "knockout", groupNo: null, round: 2, position: 2, placement: 3, a: 1, b: 2, courtId: 7, courtName: "Court 1", date: "2026-11-20", minute: 600, hour: 10, score: null, winner: null, next: null, nextSlot: null, loserNext: null, loserNextSlot: null, minutes: 45, status: "scheduled" },
    ],
  };

  it("checks entrants in, records an age check without the document, shows a declared minor's guardian as their word, and moves a fixture", async () => {
    detail = today;
    const badmintonVenue = { ...(venue as object), courts: [{ id: 7, name: "Court 1", sport: "badminton", activities: [] }] } as never;
    render(<TournamentsTab venues={[badmintonVenue]} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await act(async () => {});
    expect(screen.getByText(/guardian Aunty Lim agreed \(their word, not checked\)/)).toBeTruthy();
    expect(screen.getByText("✓ eligibility checked by Desk")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "check in" }));
    await act(async () => {});
    expect(posts.at(-1)).toEqual({ url: "/api/admin/tournaments/9/entries/1", body: { checkedIn: true } });
    fireEvent.click(screen.getAllByRole("button", { name: "age checked" })[0]);
    await act(async () => {});
    expect(posts.at(-1)).toEqual({ url: "/api/admin/tournaments/9/entries/1", body: { eligibilityChecked: true } });
    // The third-place match, its length shown, moved and lengthened.
    expect(screen.getByText(/Third-place match/)).toBeTruthy();
    expect(screen.getByText(new RegExp(`${formatMinute(600)}–${formatMinute(645)}`))).toBeTruthy();
    fireEvent.click(screen.getByText("Move…"));
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2026-11-21" } });
    fireEvent.change(screen.getByDisplayValue("45"), { target: { value: "60" } });
    fireEvent.click(screen.getByRole("button", { name: "Move it and tell the players" }));
    await act(async () => {});
    expect(posts.at(-1)).toEqual({ url: "/api/admin/tournaments/9/matches/70", body: { move: { date: "2026-11-21", startMin: 600, courtId: 7, minutes: 60 } } });
  });
});

/**
 * Setting up, the draw, rules, calling off, a correction's knock-on, moving a
 * fixture and disqualifying are a manager's (lib/roles.ts, and the matches and
 * entries routes by what is asked): front desk reads them and is not offered
 * them; it keeps entries, check-in, payments and results. A manager keeps all.
 */
describe("front desk and a manager", () => {
  const court = { ...(venue as object), courts: [{ id: 7, name: "Court 1", sport: "badminton", activities: [] }] } as never;
  const as = (role: StaffRole, ui: ReactElement) => render(<StaffMayProvider may={staffMay(role)}>{ui}</StaffMayProvider>);
  const openAs = async (role: StaffRole) => {
    as(role, <TournamentsTab venues={[court]} />);
    await act(async () => {});
    fireEvent.click(screen.getByRole("button", { name: "Open" }));
    await act(async () => {});
  };
  const readOnly = (el: HTMLElement) => el.closest("fieldset[disabled]") !== null;
  const underWay = {
    ...cup,
    issues: [],
    entries: [
      { id: 1, name: "Aina", status: "entered", seed: null, paid: false, out: null, entryMark: null, checkedIn: false, guardian: null, eligibilityChecked: null },
      { id: 2, name: "Bala", status: "entered", seed: null, paid: false, out: null, entryMark: null, checkedIn: false, guardian: null, eligibilityChecked: null },
    ],
    matches: [
      { id: 70, stage: "knockout", groupNo: null, round: 1, position: 1, placement: null, a: 1, b: 2, courtId: 7, courtName: "Court 1", date: "2026-11-20", minute: 600, hour: 10, score: null, winner: null, next: null, nextSlot: null, loserNext: null, loserNextSlot: null, minutes: 45, status: "scheduled" },
    ],
  };
  const knockoutMovedOn = (preview: boolean) =>
    fetchMock.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === "POST") {
        const body = JSON.parse(init.body ?? "{}");
        posts.push({ url, body });
        if (preview && body.preview)
          return { ok: true, json: async () => ({ preview: { token: "t", replace: { possible: true, changes: [], blockers: [] }, standingsOnly: { changes: [] } } }) };
        return { ok: false, status: 409, json: async () => ({ error: "The knockout has moved on from this match.", code: "KNOCKOUT_STARTED" }) };
      }
      return { ok: true, json: async () => ({ tournament: detail }) };
    });

  it("the list: the desk reads the competitions and set-up forms, with no call-off and nothing to submit", async () => {
    detail = { ...cup, issues: [] };
    as("desk", <TournamentsTab venues={[court]} />);
    await act(async () => {});
    expect(screen.getByText(/Club Championships/, { selector: "span" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Call off" })).toBeNull();
    const setUp = screen.getAllByRole("button", { name: "Set it up and hold the courts" });
    expect(setUp).toHaveLength(2);
    for (const b of setUp) expect(readOnly(b)).toBe(true);
    // Said once, above the first form.
    expect(screen.getAllByText("A manager changes this.")).toHaveLength(1);
  });

  it("the list: a manager calls off and sets up", async () => {
    detail = { ...cup, issues: [] };
    as("manager", <TournamentsTab venues={[court]} />);
    await act(async () => {});
    expect(screen.getByRole("button", { name: "Call off" })).toBeTruthy();
    for (const b of screen.getAllByRole("button", { name: "Set it up and hold the courts" })) expect(readOnly(b)).toBe(false);
    expect(screen.queryByText("A manager changes this.")).toBeNull();
  });

  it("taking entries: the desk checks in and takes payment, and is given no draw, closing, details, template, rules or call-off", async () => {
    detail = { ...underWay, status: "open", matches: [] };
    await openAs("desk");
    expect(screen.getAllByRole("button", { name: "check in" })).toHaveLength(2);
    for (const name of ["Change details", "Close entries", "Make the draw", "Save as template", "Call it off"]) expect(screen.queryByRole("button", { name }), name).toBeNull();
    // The rules are read, not changed.
    for (const rule of screen.getAllByDisplayValue("Stand as played")) expect(readOnly(rule)).toBe(true);
    // Taking somebody out stays; disqualifying is the organiser's.
    const out = screen.getByLabelText("Take Aina out") as HTMLSelectElement;
    expect(Array.from(out.options).map((o) => o.value)).toEqual(["", "withdrawn"]);
  });

  it("taking entries: a manager has every control", async () => {
    detail = { ...underWay, status: "open", matches: [] };
    await openAs("manager");
    for (const name of ["Change details", "Close entries", "Make the draw", "Save as template", "Call it off"]) expect(screen.getByRole("button", { name }), name).toBeTruthy();
    for (const rule of screen.getAllByDisplayValue("Stand as played")) expect(readOnly(rule)).toBe(false);
    expect(Array.from((screen.getByLabelText("Take Aina out") as HTMLSelectElement).options).map((o) => o.value)).toContain("disqualified");
  });

  it("under way: the desk enters a result but is not offered a fixture move, nor a correction once the knockout has moved on", async () => {
    detail = underWay;
    await openAs("desk");
    expect(screen.queryByText("Move…")).toBeNull();
    knockoutMovedOn(true);
    fireEvent.change(screen.getByLabelText("Score"), { target: { value: "21-15, 21-18" } });
    fireEvent.click(screen.getByRole("button", { name: "Aina won" }));
    await act(async () => {});
    // The result asked for, and no review of a correction after it: the refusal says why.
    expect(posts).toEqual([{ url: "/api/admin/tournaments/9/matches/70", body: { winner: 1, score: "21-15, 21-18" } }]);
    expect(screen.queryByRole("region", { name: "Correction" })).toBeNull();
    expect(screen.getByText("The knockout has moved on from this match.")).toBeTruthy();
  });

  it("under way: a manager moves a fixture and reviews a correction", async () => {
    detail = underWay;
    await openAs("manager");
    expect(screen.getByText("Move…")).toBeTruthy();
    knockoutMovedOn(true);
    fireEvent.click(screen.getByRole("button", { name: "Aina won" }));
    await act(async () => {});
    expect(posts.map((p) => p.body.preview === true)).toEqual([false, true]);
    expect(screen.getByRole("region", { name: "Correction" })).toBeTruthy();
  });

  it("a correction's knock-on: the desk reads what it affects, and letting it stand or replaying is not offered", async () => {
    detail = cup;
    await openAs("desk");
    expect(screen.getByText(/Final: Aina played instead of Bala/)).toBeTruthy();
    expect(readOnly(screen.getByRole("button", { name: "Let the results stand" }))).toBe(true);
  });

  it("a final's last places when level: the organiser's; each heat's marks stay the desk's", async () => {
    detail = { ...gala, performance: { ...gala.performance, tieForFinal: [1, 2] } };
    await openAs("desk");
    expect(readOnly(screen.getByRole("button", { name: "Put them in the final" }))).toBe(true);
    expect(readOnly(screen.getByRole("button", { name: "Save results" }))).toBe(false);
  });
});
