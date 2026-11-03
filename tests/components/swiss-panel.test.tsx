// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { ReactElement } from "react";
import { SwissPanel } from "../../src/components/admin/SwissPanel";
import { SwissStandings } from "../../src/components/SwissStandings";
import { StaffMayProvider } from "../../src/components/admin/StaffMay";
import { staffMay, type StaffRole } from "../../src/lib/roles";
import { translator } from "../../src/lib/i18n";
import { DEFAULT_RULES } from "../../src/lib/tournament-rules";

/**
 * A Swiss event's screens (ADR 0033): the organiser's panel with its table, its rounds and what to do between them, and the public
 * standings with the tie-breaks that rank them.
 */

afterEach(cleanup);

const line = (entryId: number, rank: number, points: number, over: Record<string, unknown> = {}) => ({
  entryId,
  rank,
  played: 1,
  won: points,
  drawn: 0,
  lost: 1 - points,
  setDiff: 0,
  setsWon: 0,
  setsLost: 0,
  pointsFor: 0,
  pointsAgainst: 0,
  pointDiff: 0,
  points,
  byes: 0,
  buchholz: 1,
  medianBuchholz: 1,
  out: null,
  resultsVoid: false,
  ...over,
});

const match = (id: number, a: number, b: number | null, over: Record<string, unknown> = {}) => ({
  id,
  stage: "group",
  groupNo: 1,
  round: 1,
  position: id,
  a,
  b,
  courtId: 7,
  courtName: "Court 1",
  date: "2026-11-20",
  minute: 540,
  hour: 9,
  score: null,
  winner: null,
  next: null,
  nextSlot: null,
  loserNext: null,
  loserNextSlot: null,
  placement: null,
  minutes: 45,
  status: "scheduled",
  ...over,
});

const tn = (over: Record<string, unknown> = {}) =>
  ({
    id: 9,
    name: "Swiss Cup",
    format: "swiss",
    status: "drawn",
    rules: DEFAULT_RULES,
    entries: [1, 2, 3, 4].map((id) => ({ id, name: ["Aina", "Bala", "Chong", "Devi"][id - 1], status: "entered", out: null })),
    matches: [match(1, 1, 2, { status: "done", winner: 1, score: "21-10, 21-12" }), match(2, 3, 4)],
    swiss: {
      roundsTotal: 2,
      plannedRounds: 2,
      seed: 1,
      tiebreaks: ["buchholz", "median_buchholz", "wins"],
      byePoints: 1,
      rounds: [{ round: 1, pairedAt: "2026-11-01", complete: false, notes: [{ kind: "pair", a: 1, b: 2, aPoints: 0, bPoints: 0, float: false }, { kind: "pair", a: 3, b: 4, aPoints: 0, bPoints: 0, float: false }] }],
      standings: [line(1, 1, 1), line(3, 2, 0), line(4, 3, 0), line(2, 4, 0)],
      nextRound: null,
      blocked: null,
    },
    ...over,
  }) as never;

const names = new Map([[1, "Aina"], [2, "Bala"], [3, "Chong"], [4, "Devi"]]);
const as = (role: StaffRole, ui: ReactElement) => <StaffMayProvider may={staffMay(role)}>{ui}</StaffMayProvider>;

describe("the organiser's panel", () => {
  it("shows the table with its tie-breaks and each round's pairings, and closes a round with an answer for every match still to play", () => {
    const call = vi.fn(async () => ({ ok: true, data: {} }));
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(as("manager", <SwissPanel tn={tn()} names={names} base="/api/admin/tournaments/9" call={call} />));
    expect(screen.getByText("Swiss rounds")).toBeTruthy();
    expect(screen.getByText(/Standings: points, then Buchholz/)).toBeTruthy();
    expect(screen.getAllByText("Aina").length).toBeGreaterThan(0);
    // Closing the round needs an answer for the match still to play.
    fireEvent.click(screen.getAllByText("Close round 1")[0]);
    const submit = screen.getByRole("button", { name: "Close round 1" }) as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("What happens to Chong v Devi"), { target: { value: "none" } });
    expect(submit.disabled).toBe(false);
    fireEvent.click(submit);
    expect(call).toHaveBeenCalledWith("/api/admin/tournaments/9", { action: "swiss_close_round", round: 1, resolutions: [{ matchId: 2, winner: null }] });
  });

  it("says why a round could not be paired, and offers to pair it again or to end the event, to a manager", () => {
    const call = vi.fn(async () => ({ ok: true, data: {} }));
    const blocked = tn({
      matches: [match(1, 1, 2, { status: "done", winner: 1 }), match(2, 3, 4, { status: "done", winner: 3 })],
      swiss: { ...(tn() as unknown as { swiss: object }).swiss, rounds: [{ round: 1, pairedAt: "x", complete: true, notes: [] }], blocked: "NO_PAIRING:2", nextRound: 2 },
    });
    render(as("manager", <SwissPanel tn={blocked} names={names} base="/api/admin/tournaments/9" call={call} />));
    expect(screen.getByText("Round 2 is not paired")).toBeTruthy();
    expect(screen.getByText(/without a rematch or a second bye/)).toBeTruthy();
    fireEvent.click(screen.getAllByText("Pair round 2")[0]);
    expect(call).toHaveBeenCalledWith("/api/admin/tournaments/9", { action: "swiss_pair" });
    cleanup();
    // The desk is shown the table and the buttons disabled, hidden, under a line saying a manager does this.
    render(as("desk", <SwissPanel tn={blocked} names={names} base="/api/admin/tournaments/9" call={call} />));
    expect(screen.getAllByText("Pair round 2")[0].closest("fieldset[disabled]")).not.toBeNull();
  });
});

describe("the public standings", () => {
  it("rank by points, then the published tie-breaks, and list every round with its pairings and results", () => {
    render(<SwissStandings t={translator("en")} x={tn()} names={names} />);
    expect(screen.getByText("Standings after 0 of 2 rounds")).toBeTruthy();
    expect(screen.getByText(/Ranked by points, then by Buchholz \(points of the opponents played\), median Buchholz, wins/)).toBeTruthy();
    expect(screen.getByText("Round 1")).toBeTruthy();
    expect(screen.getByText("21-10, 21-12")).toBeTruthy();
  });

  it("is in the reader's own language", () => {
    render(<SwissStandings t={translator("ms")} x={tn()} names={names} />);
    expect(screen.getByText("Pusingan 1")).toBeTruthy();
  });
});
