// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";

import type { ReactElement } from "react";
import { SwissPanel } from "../../src/components/admin/SwissPanel";
import { SwissPerformancePanel } from "../../src/components/admin/SwissPerformancePanel";
import { SwissTiebreaks } from "../../src/components/admin/SwissTiebreaks";
import { StaffMayProvider } from "../../src/components/admin/StaffMay";
import { SwissPerformanceStandings } from "../../src/components/SwissPerformanceStandings";
import { SwissStandings } from "../../src/components/SwissStandings";
import { staffMay, type StaffRole } from "../../src/lib/roles";
import { translator } from "../../src/lib/i18n";
import { DEFAULT_RULES } from "../../src/lib/tournament-rules";

/**
 * The tie-break screen and the two other screens of ADR 0038: the organiser's table with every tie-break as a column and what separated
 * each tie, the order of tie-breaks a manager changes with a live preview and a reason, the next round previewed with each pairing's
 * reason and the virtual points said, a counted event's rounds with what a correction put in doubt, and the public standings.
 */

afterEach(cleanup);

const line = (entryId: number, rank: number, points: number, over: Record<string, unknown> = {}) => ({
  entryId,
  rank,
  played: 1,
  won: points,
  drawn: 0,
  lost: 1 - points,
  setDiff: 2,
  setsWon: 2,
  setsLost: 0,
  pointsFor: 42,
  pointsAgainst: 20,
  pointDiff: 22,
  points,
  byes: 0,
  buchholz: 1,
  medianBuchholz: 1,
  buchholzCut1: 1,
  sonnebornBerger: 0.5,
  tie: null,
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

const swissTn = (over: Record<string, unknown> = {}, swiss: Record<string, unknown> = {}) =>
  ({
    id: 9,
    name: "Swiss Cup",
    format: "swiss",
    status: "drawn",
    rules: DEFAULT_RULES,
    entries: [1, 2, 3, 4].map((id) => ({ id, name: ["Aina", "Bala", "Chong", "Devi"][id - 1], status: "entered", out: null })),
    matches: [match(1, 1, 2, { status: "done", winner: 1, score: "21-10, 21-12" }), match(2, 3, 4, { status: "done", winner: 3, score: "21-15, 21-12" })],
    swiss: {
      roundsTotal: 3,
      plannedRounds: 3,
      seed: 1,
      tiebreaks: ["buchholz", "median_buchholz", "wins"],
      byePoints: 1,
      rounds: [{ round: 1, pairedAt: "2026-11-01", complete: true, notes: [{ kind: "pair", a: 1, b: 2, aPoints: 0, bPoints: 0, float: false, aVirtual: 1, bVirtual: 1 }, { kind: "pair", a: 3, b: 4, aPoints: 0, bPoints: 0, float: false }] }],
      standings: [
        line(1, 1, 1),
        line(3, 2, 1, { tie: { above: 1, by: "set_diff", ahead: 4, behind: 2 } }),
        line(2, 3, 0, { lost: 1, won: 0 }),
        line(4, 4, 0, { lost: 1, won: 0, tie: { above: 2, by: "seed", ahead: 2, behind: 4 } }),
      ],
      nextRound: null,
      blocked: null,
      acceleration: { rounds: 2, group: 2, points: 1 },
      ...swiss,
    },
    ...over,
  }) as never;

const names = new Map([[1, "Aina"], [2, "Bala"], [3, "Chong"], [4, "Devi"]]);
const as = (role: StaffRole, ui: ReactElement) => <StaffMayProvider may={staffMay(role)}>{ui}</StaffMayProvider>;
const BASE = "/api/admin/tournaments/9";

describe("the tie-break screen", () => {
  it("shows every tie-break as a column and, for each tie, which one separated the two and by how much, or that only the seed did", () => {
    const call = vi.fn(async () => ({ ok: true, data: {} }));
    render(as("manager", <SwissTiebreaks tn={swissTn()} names={names} base={BASE} call={call} />));
    for (const head of ["Buch.", "Med.", "Cut-1", "S-B", "Wins", "Sets +/-", "Sets ratio", "Pts +/-", "Pts ratio", "Pts for"]) expect(screen.getAllByText(new RegExp(head.replace(/[+/]/g, "\\$&"))).length).toBeGreaterThan(0);
    // "Chong is ahead of Aina on set difference: 4 against 2" is how the first tie is said.
    expect(screen.getByText("ahead of Aina on set difference: 4 against 2")).toBeTruthy();
    expect(screen.getByText(/level with Bala on every tie-break: ahead by the initial order \(2 before 4\)/)).toBeTruthy();
    // The sequence is shown in the order it is applied, with controls that have names.
    expect(screen.getByLabelText("Move median Buchholz up")).toBeTruthy();
    expect(screen.getByLabelText("Move Buchholz (points of the opponents played) down")).toBeTruthy();
    expect(screen.getByText(/locked/)).toBeTruthy();
    expect(call).not.toHaveBeenCalled();
  });

  it("previews as the order is built, and saves a change only with a reason, against the preview's token", async () => {
    const call = vi.fn(async (_url: string, body: object) => {
      const b = body as { preview?: boolean };
      return b.preview
        ? { ok: true, data: { preview: { current: ["buchholz", "median_buchholz", "wins"], proposed: ["median_buchholz", "buchholz", "wins"], locked: true, before: [], after: [{ entryId: 3, rank: 1, tie: null }, { entryId: 1, rank: 2, tie: { above: 3, by: "seed", ahead: 1, behind: 3 } }, { entryId: 2, rank: 3, tie: null }, { entryId: 4, rank: 4, tie: null }], moved: [{ entryId: 3, from: 2, to: 1 }, { entryId: 1, from: 1, to: 2 }], bySeed: [1], token: "tok1" } } }
        : { ok: true, data: {} };
    });
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(as("manager", <SwissTiebreaks tn={swissTn()} names={names} base={BASE} call={call} />));
    const save = screen.getByRole("button", { name: "Change the order" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("Move median Buchholz up"));
    await waitFor(() => expect(call).toHaveBeenCalledWith(BASE, { action: "swiss_tiebreaks", tiebreaks: ["median_buchholz", "buchholz", "wins"], preview: true }));
    // What the table would become is said: who moves, and who only the seed orders.
    expect(await screen.findByText("Chong: place 2 becomes place 1")).toBeTruthy();
    expect(screen.getByText("Level on everything and ordered by the seed alone: Aina")).toBeTruthy();
    // It cannot be saved without a reason.
    expect(save.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Reason for the change"), { target: { value: "Club rule" } });
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await waitFor(() => expect(call).toHaveBeenCalledWith(BASE, { action: "swiss_tiebreaks", tiebreaks: ["median_buchholz", "buchholz", "wins"], token: "tok1", reason: "Club rule" }));
  });

  it("adds and removes tie-breaks, refuses an empty order, and before the draw saves at once with no reason", async () => {
    const call = vi.fn(async () => ({ ok: true, data: {} }));
    const pre = swissTn({ status: "open", swiss: null, matches: [] });
    render(as("manager", <SwissTiebreaks tn={pre} names={names} base={BASE} call={call} />));
    // Before the draw there is no table, and nothing is locked.
    expect(screen.queryByText(/locked/)).toBeNull();
    fireEvent.click(screen.getByLabelText("Add Sonneborn-Berger (points of the opponents beaten, half for a draw)"));
    fireEvent.click(screen.getByLabelText("Remove wins"));
    fireEvent.click(screen.getByRole("button", { name: "Save the order" }));
    await waitFor(() => expect(call).toHaveBeenCalledTimes(1));
    const sent = (call.mock.calls[0] as unknown as [string, { tiebreaks: string[]; action: string; token?: string }])[1];
    expect(sent.action).toBe("swiss_tiebreaks");
    expect(sent.tiebreaks).toContain("sonneborn_berger");
    expect(sent.tiebreaks).not.toContain("wins");
    expect(sent.token).toBeUndefined();
    cleanup();
    // The desk is shown the table and none of the buttons.
    render(as("desk", <SwissTiebreaks tn={swissTn()} names={names} base={BASE} call={call} />));
    expect(screen.getByLabelText("Move median Buchholz up").closest("fieldset[disabled]")).not.toBeNull();
    // Inside a disabled fieldset, whose buttons the stylesheet hides: the desk cannot press anything.
    expect(screen.getByRole("button", { name: "Change the order" }).closest("fieldset[disabled]")).not.toBeNull();
  });
});

describe("the organiser's panel: accelerated pairing and the preview of a round", () => {
  it("says what the virtual points are and shows them beside a pairing's real points", () => {
    const call = vi.fn(async () => ({ ok: true, data: {} }));
    render(as("manager", <SwissPanel tn={swissTn()} names={names} base={BASE} call={call} />));
    expect(screen.getByText(/Accelerated pairing: rounds 1 to 2 are paired with 1 virtual point\(s\) added for the best 2/)).toBeTruthy();
    expect(screen.getByText(/0 \+ 1 accelerated–0 \+ 1 accelerated/)).toBeTruthy();
    // The table itself carries real points only.
    expect(screen.getAllByText("Aina").length).toBeGreaterThan(0);
  });

  it("previews the round that is due, with each pairing's reason, the bye, and whether it fits, and changes nothing", async () => {
    const call = vi.fn(async () => ({
      ok: true,
      data: { preview: { round: 2, pairs: [{ a: 1, b: 3, note: { kind: "pair", a: 1, b: 3, aPoints: 1, bPoints: 1, float: false, aVirtual: 1, bVirtual: 0 } }], bye: { id: 4, note: { kind: "bye", a: 4, b: null, aPoints: 0, bPoints: null, float: false } }, unplaced: 1 } },
    }));
    const due = swissTn({}, { nextRound: 2 });
    render(as("manager", <SwissPanel tn={due} names={names} base={BASE} call={call} />));
    fireEvent.click(screen.getAllByText("Preview round 2")[0]);
    await waitFor(() => expect(call).toHaveBeenCalledWith(BASE, { action: "swiss_preview" }));
    expect(await screen.findByText("Round 2 as it would be paired now")).toBeTruthy();
    expect(screen.getByText(/1 \+ 1 accelerated–1/)).toBeTruthy();
    expect(screen.getByText("Bye: Devi")).toBeTruthy();
    expect(screen.getByText("1 of these matches would find no court time.")).toBeTruthy();
    expect(call).toHaveBeenCalledTimes(1);
  });
});

describe("a counted event played in Swiss rounds, for staff", () => {
  const perf = (over: Record<string, unknown> = {}) =>
    ({
      id: 12,
      name: "Wall Cup",
      format: "performance",
      status: "drawn",
      rules: { ...DEFAULT_RULES, swiss: { rounds: 3, byePoints: null, tiebreaks: null, cumulative: "sum_of_placings" } },
      entries: [1, 2, 3, 4].map((id) => ({ id, name: ["Aina", "Bala", "Chong", "Devi"][id - 1], status: "entered", out: null })),
      matches: [],
      performance: {
        lines: {},
        ranking: [],
        heatRanking: [],
        tieForFinal: null,
        swiss: {
          roundsTotal: 3,
          plannedRounds: 3,
          seed: 4,
          cumulative: "sum_of_placings",
          bestN: null,
          rounds: [
            { round: 1, groupedAt: "x", complete: true, heats: [{ matchId: 21, heat: 1, entryIds: [4, 3, 2, 1] }], notes: [{ heat: 1, members: [{ id: 4, place: null, total: null }] }] },
            { round: 2, groupedAt: "x", complete: false, heats: [{ matchId: 22, heat: 1, entryIds: [2, 4, 3, 1] }], notes: [{ heat: 1, members: [{ id: 2, place: 4, total: 4 }] }] },
          ],
          standings: [
            { entryId: 1, placings: [1], counted: [1], total: 1, rank: 1, order: 1, tie: null, out: null, resultsVoid: false },
            { entryId: 3, placings: [2], counted: [2], total: 2, rank: 2, order: 2, tie: null, out: null, resultsVoid: false },
            { entryId: 2, placings: [3], counted: [3], total: 3, rank: 3, order: 3, tie: null, out: null, resultsVoid: false },
            { entryId: 4, placings: [3], counted: [3], total: 3, rank: 3, order: 4, tie: { above: 2, by: "seed", ahead: 2, behind: 4 }, out: null, resultsVoid: false },
          ],
          nextRound: null,
          blocked: null,
          review: [{ round: 2, moves: [{ entryId: 3, from: 1, to: 2 }, { entryId: 1, from: 2, to: 1 }] }],
          ...over,
        },
      },
    }) as never;

  it("shows the standing with the rule that adds it up, every round's groups, and the round flagged for review without having moved anybody", () => {
    const call = vi.fn(async () => ({ ok: true, data: {} }));
    render(as("manager", <SwissPerformancePanel tn={perf()} names={names} base="/api/admin/tournaments/12" call={call} />));
    expect(screen.getByText("Swiss rounds (counted event)")).toBeTruthy();
    expect(screen.getByText(/Standing: each round's placing across all its groups, added up; the fewest wins/)).toBeTruthy();
    expect(screen.getByText(/level with Bala on the total and every placing: ahead by the initial order \(2 before 4\)/)).toBeTruthy();
    expect(screen.getByText("Round 2: groups flagged for review")).toBeTruthy();
    expect(screen.getByText(/Nobody has been moved\./)).toBeTruthy();
    expect(screen.getAllByText("Chong: group 1 would be group 2").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Round 1").length).toBeGreaterThan(0);
  });

  it("keeps the groups with a reason, or previews and then groups the round again, each as the manager chooses; the desk can only read", async () => {
    const call = vi.fn(async (_url: string, body: object) =>
      (body as { preview?: boolean }).preview
        ? { ok: true, data: { preview: { round: 2, moves: [{ entryId: 3, from: 1, to: 2 }], dropped: [4], cleared: [3], token: "tk" } } }
        : { ok: true, data: {} }
    );
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(as("manager", <SwissPerformancePanel tn={perf()} names={names} base="/api/admin/tournaments/12" call={call} />));
    const keep = screen.getByRole("button", { name: "Keep the groups as they are" }) as HTMLButtonElement;
    expect(keep.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "Climbing has begun" } });
    expect(keep.disabled).toBe(false);
    fireEvent.click(keep);
    await waitFor(() => expect(call).toHaveBeenCalledWith("/api/admin/tournaments/12", { action: "swiss_keep_grouping", round: 2, reason: "Climbing has begun" }));
    fireEvent.click(screen.getByRole("button", { name: "Preview grouping again" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith("/api/admin/tournaments/12", { action: "swiss_regroup", round: 2, preview: true }));
    expect(await screen.findByText(/Not in the new groups \(they have left the event\): Devi/)).toBeTruthy();
    expect(screen.getByText(/The groups of later rounds \(3\) are cleared/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Group round 2 again" }));
    await waitFor(() => expect(call).toHaveBeenCalledWith("/api/admin/tournaments/12", { action: "swiss_regroup", round: 2, token: "tk", reason: "Climbing has begun" }));
    cleanup();
    render(as("desk", <SwissPerformancePanel tn={perf()} names={names} base="/api/admin/tournaments/12" call={call} />));
    expect(screen.getByRole("button", { name: "Keep the groups as they are" }).closest("fieldset[disabled]")).not.toBeNull();
    expect(screen.getByText("Round 2: groups flagged for review")).toBeTruthy();
  });

  it("offers to group the round that could not be placed, and says why", () => {
    const call = vi.fn(async () => ({ ok: true, data: {} }));
    render(as("manager", <SwissPerformancePanel tn={perf({ blocked: "NO_TIME:3", review: [], nextRound: 3, rounds: [{ round: 1, groupedAt: "x", complete: true, heats: [], notes: [] }, { round: 2, groupedAt: "x", complete: true, heats: [], notes: [] }] })} names={names} base="/api/admin/tournaments/12" call={call} />));
    expect(screen.getByText("Round 3 is not grouped")).toBeTruthy();
    expect(screen.getByText(/does not fit in the court time held/)).toBeTruthy();
    fireEvent.click(screen.getAllByText("Group round 3")[0]);
    expect(call).toHaveBeenCalledWith("/api/admin/tournaments/12", { action: "swiss_pair" });
  });
});

describe("the public standings", () => {
  it("show the event's other tie-breaks as columns, in every language, and say what accelerated pairing was", () => {
    const tn = swissTn({}, { tiebreaks: ["buchholz", "buchholz_cut1", "sonneborn_berger", "set_diff", "head_to_head"] });
    render(<SwissStandings t={translator("en")} x={tn} names={names} />);
    expect(screen.getByText("Cut-1")).toBeTruthy();
    expect(screen.getByText("S-B")).toBeTruthy();
    expect(screen.getByText("Sets +/-")).toBeTruthy();
    expect(screen.getByText(/Ranked by points, then by Buchholz \(points of the opponents played\), Buchholz without the lowest opponent/)).toBeTruthy();
    expect(screen.getByText(/Accelerated pairing: in rounds 1 to 2 the best 2 of the initial order were paired as if they had a point more/)).toBeTruthy();
    expect(screen.getByText(/0 \+ 1 accelerated–0 \+ 1 accelerated/)).toBeTruthy();
    cleanup();
    render(<SwissStandings t={translator("zh")} x={tn} names={names} />);
    expect(screen.getByText("去低")).toBeTruthy();
    expect(screen.getByText(/加速配对/)).toBeTruthy();
    cleanup();
    render(<SwissStandings t={translator("ta")} x={tn} names={names} />);
    expect(screen.getByText("கட்-1")).toBeTruthy();
    cleanup();
    render(<SwissStandings t={translator("ms")} x={tn} names={names} />);
    expect(screen.getByText("Cut-1")).toBeTruthy();
    expect(screen.getByText(/Pasangan dipercepat/)).toBeTruthy();
  });

  it("show a counted event's standing across the rounds with its rule, and the next round's note", () => {
    const x = {
      performance: {
        swiss: {
          roundsTotal: 3,
          cumulative: "best_n",
          bestN: 2,
          rounds: [{ round: 1, complete: true }, { round: 2, complete: false }],
          standings: [
            { entryId: 1, placings: [1, 2], total: 3, rank: 1 },
            { entryId: 2, placings: [3, 1], total: 4, rank: 2 },
            { entryId: 3, placings: [], total: 0, rank: null },
          ],
          nextRound: 3,
        },
      },
    } as never;
    render(<SwissPerformanceStandings t={translator("en")} x={x} names={new Map([[1, "Aina"], [2, "Bala"], [3, "Chong"]])} />);
    expect(screen.getByText("Standings after 1 of 3 rounds")).toBeTruthy();
    expect(screen.getByText(/Each climber's best 2 round placings are added up: the fewest points wins/)).toBeTruthy();
    expect(screen.getByText("1, 2")).toBeTruthy();
    expect(screen.getByText(/Round 3 is grouped when every group of the round before is in/)).toBeTruthy();
    cleanup();
    render(<SwissPerformanceStandings t={translator("ms")} x={x} names={new Map([[1, "Aina"], [2, "Bala"], [3, "Chong"]])} />);
    expect(screen.getByText("Kedudukan selepas 1 daripada 3 pusingan")).toBeTruthy();
  });
});
