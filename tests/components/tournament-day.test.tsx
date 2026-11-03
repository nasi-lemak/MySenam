// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({ useParams: () => ({ id: "9" }) }));

import { StaffMayProvider } from "../../src/components/admin/StaffMay";
import { TournamentDay } from "../../src/components/admin/TournamentDay";
import LiveTournamentPage from "../../src/app/tournaments/[id]/live/page";
import { staffMay } from "../../src/lib/roles";
import type { DayBoard, DayFixture, LiveBoard } from "../../src/lib/tournament-day";
import type { TournamentDetail } from "../../src/lib/tournaments";

/** The day board for staff (a manager acts, the desk reads) and the public live page. */

const fixture = (over: Partial<DayFixture>): DayFixture => ({
  id: 1,
  label: "Semi-final 1",
  labelPhrase: { key: "srv.round.semi", vars: { n: 1 } } as never,
  a: { id: 11, name: "Aina Lim" },
  b: { id: 12, name: "Bala Raj" },
  courtId: 1,
  courtName: "Court 1",
  date: "2026-12-05",
  minute: 540,
  minutes: 60,
  state: "waiting",
  ready: true,
  blockers: [],
  calledAt: null,
  calledBy: null,
  dueAt: null,
  overdue: false,
  minutesLeft: 0,
  ...over,
});

const base: DayBoard = {
  tournamentId: 9,
  name: "Open Cup",
  status: "drawn",
  today: "2026-12-05",
  nowMin: 545,
  now: "2026-12-05T01:05:00.000Z",
  settings: { minRestMinutes: 0, callWaitMinutes: 10, announceNext: true, liveNames: "full" },
  courts: [
    { id: 1, name: "Court 1", now: null, next: fixture({}), free: true, proposal: 1 },
    { id: 2, name: "Court 2", now: null, next: null, free: true, proposal: null },
  ],
  waiting: [fixture({}), fixture({ id: 2, label: "Semi-final 2", a: { id: 13, name: "Chen Wei" }, b: { id: 14, name: "Dewi Sari" }, courtId: 2, courtName: "Court 2", ready: false, blockers: [{ code: "notHere", entryId: 13, name: "Chen Wei" }] })],
  recent: [],
};

const tn = { id: 9, format: "knockout", matches: [] } as unknown as TournamentDetail;
const posts: Record<string, unknown>[] = [];
let board: DayBoard = base;

beforeEach(() => {
  posts.length = 0;
  board = base;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init?: { method?: string; body?: string }) => {
      if (init?.method === "POST") posts.push(JSON.parse(init.body ?? "{}"));
      return { ok: true, json: async () => ({ board }) };
    })
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the day board", () => {
  it("shows each court, what is next and who is waiting and why not", async () => {
    render(<TournamentDay tn={tn} />);
    await act(async () => {});
    expect(screen.getByText("Now and next")).toBeTruthy();
    expect(screen.getAllByText("Court 2").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Aina Lim v Bala Raj|Aina Lim .* Bala Raj/).length).toBeGreaterThan(0);
    expect(screen.getByText("Chen Wei is not checked in")).toBeTruthy();
    expect(screen.getByText(/checked in below/)).toBeTruthy();
  });

  it("lets a manager call, or put the suggestion on a free court", async () => {
    render(<TournamentDay tn={tn} />);
    await act(async () => {});
    fireEvent.click(screen.getAllByRole("button", { name: "Call" })[0]);
    await act(async () => {});
    expect(posts.at(-1)).toEqual({ action: "call", matchId: 1 });
    fireEvent.click(screen.getByRole("button", { name: "Call it" }));
    await act(async () => {});
    expect(posts.at(-1)).toEqual({ action: "call", matchId: 1, courtId: 1 });
  });

  it("offers wait, forfeit and swap once nobody came in time, confirming a forfeit first", async () => {
    board = {
      ...base,
      courts: [{ id: 1, name: "Court 1", now: fixture({ state: "called", ready: false, calledAt: "2026-12-05T01:00:00.000Z", dueAt: "2026-12-05T01:10:00.000Z", overdue: true }), next: null, free: false, proposal: null }, base.courts[1]],
    };
    const confirm = vi.fn(() => true);
    vi.stubGlobal("confirm", confirm);
    render(<TournamentDay tn={tn} />);
    await act(async () => {});
    expect(screen.getByText(/Nobody came in time/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Wait 10 more minutes" }));
    await act(async () => {});
    expect(posts.at(-1)).toEqual({ action: "decide", matchId: 1, decision: { action: "wait" } });
    fireEvent.click(screen.getByRole("button", { name: "Swap in the next ready match" }));
    await act(async () => {});
    expect(posts.at(-1)).toEqual({ action: "decide", matchId: 1, decision: { action: "swap" } });
    fireEvent.click(screen.getByLabelText("and take them out of the event"));
    fireEvent.click(screen.getByRole("button", { name: "Aina Lim did not come: give the match to the other side" }));
    await act(async () => {});
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining("walkover"));
    expect(posts.at(-1)).toEqual({ action: "decide", matchId: 1, decision: { action: "forfeit", absent: 11, outOfEvent: true } });
  });

  it("is read-only for front desk, which is told who does what", async () => {
    render(
      <StaffMayProvider may={staffMay("desk")}>
        <TournamentDay tn={tn} />
      </StaffMayProvider>
    );
    await act(async () => {});
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByText(/A manager calls matches to their courts/)).toBeTruthy();
    expect(screen.getAllByText("Court 1").length).toBeGreaterThan(0);
  });

  it("saves the day's settings", async () => {
    render(<TournamentDay tn={tn} />);
    await act(async () => {});
    fireEvent.click(screen.getByText("Day settings"));
    fireEvent.change(screen.getByLabelText("Rest between a player's matches (minutes)"), { target: { value: "20" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await act(async () => {});
    expect(posts.at(-1)).toEqual({ action: "settings", minRestMinutes: 20, callWaitMinutes: 10, announceNext: true, liveNames: "full" });
  });
});

describe("the live page", () => {
  const live: LiveBoard = {
    id: 9,
    name: "Open Cup",
    venueName: "Arena Damansara",
    sport: "badminton",
    status: "drawn",
    today: "2026-12-05",
    courts: [
      { id: 1, name: "Court 1", now: { id: 1, stage: "knockout", groupNo: null, round: 1, placement: null, rounds: 2, a: "Aina L.", b: "Bala Raj", state: "called", date: "2026-12-05", minute: 540 }, next: null },
      { id: 2, name: "Court 2", now: null, next: { id: 2, stage: "knockout", groupNo: null, round: 2, placement: null, rounds: 2, a: null, b: null, state: "scheduled", date: "2026-12-05", minute: 600 } },
    ],
    recent: [{ id: 3, stage: "knockout", groupNo: null, round: 1, placement: null, rounds: 2, a: "Chen W.", b: "Dewi Sari", winner: "Chen W.", score: "21-10, 21-12", walkover: false }],
  };

  it("shows what is on court, next and recent, with no sign-in, and does not name a minor in full", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ board: live }) })));
    const { container } = render(<LiveTournamentPage />);
    await act(async () => {});
    expect(screen.getByText("Live: Open Cup")).toBeTruthy();
    expect(screen.getByText("Called: please go to the court")).toBeTruthy();
    expect(screen.getAllByText("Free").length).toBeGreaterThan(0);
    expect(screen.getByText("to be decided", { exact: false })).toBeTruthy();
    expect(screen.getByText(/Chen W\. won/)).toBeTruthy();
    expect(container.textContent).toContain("Aina L.");
    expect(container.textContent).not.toContain("Aina Lim");
  });

  it("says so when the tournament cannot be shown", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: false, status: 404, json: async () => ({ error: "Not found." }) })));
    render(<LiveTournamentPage />);
    await act(async () => {});
    expect(screen.queryByText("Live: Open Cup")).toBeNull();
  });
});
