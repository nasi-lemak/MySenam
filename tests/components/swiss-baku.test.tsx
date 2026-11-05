// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { ReactElement } from "react";
import { SwissPanel } from "../../src/components/admin/SwissPanel";
import { TournamentsTab } from "../../src/components/admin/TournamentsTab";
import { StaffMayProvider } from "../../src/components/admin/StaffMay";
import { SwissStandings } from "../../src/components/SwissStandings";
import { TEMPLATES, templateByKey } from "../../src/lib/competition-templates";
import { translator } from "../../src/lib/i18n";
import { staffMay, type StaffRole } from "../../src/lib/roles";
import { DEFAULT_RULES } from "../../src/lib/tournament-rules";

/**
 * Baku acceleration on screen (ADR 0047): offered when a chess event is set up and for no other sport; the public standings and the
 * organiser's panel say what it was in words and show each pairing's virtual points as they are ("0 + 1 accelerated", "+ 1/2 accelerated"),
 * in a table whose points are kept doubled and shown halved; an event of another sport reads as it did.
 */

afterEach(cleanup);

const chess = templateByKey("chess_results")!.rules;

const line = (entryId: number, rank: number, points: number, over: Record<string, unknown> = {}) => ({
  entryId,
  rank,
  played: 1,
  won: 0,
  drawn: 0,
  lost: 0,
  setDiff: 0,
  setsWon: 0,
  setsLost: 0,
  pointsFor: 0,
  pointsAgainst: 0,
  pointDiff: 0,
  points,
  byes: 0,
  buchholz: 3,
  medianBuchholz: 3,
  buchholzCut1: 3,
  sonnebornBerger: 1,
  tie: null,
  out: null,
  resultsVoid: false,
  ...over,
});

const match = (id: number, round: number, a: number, b: number | null, over: Record<string, unknown> = {}) => ({
  id,
  stage: "group",
  groupNo: 1,
  round,
  position: id,
  a,
  b,
  courtId: 7,
  courtName: "Table 1",
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
  minutes: 120,
  status: "scheduled",
  ...over,
});

const chessTn = (acceleration: Record<string, unknown> | null, rules = chess) =>
  ({
    id: 9,
    name: "Club Chess Open",
    format: "swiss",
    status: "drawn",
    rules,
    entries: [1, 2, 3, 4].map((id) => ({ id, name: ["Aina", "Bala", "Chong", "Devi"][id - 1], status: "entered", out: null })),
    matches: [match(1, 1, 1, 2, { status: "done", winner: null, score: "1-1" }), match(2, 1, 3, 4, { status: "done", winner: 3, score: "1-0" }), match(3, 2, 3, 1), match(4, 2, 2, 4)],
    swiss: {
      roundsTotal: 5,
      plannedRounds: 5,
      seed: 1,
      tiebreaks: ["buchholz", "median_buchholz", "wins"],
      byePoints: 2,
      rounds: [
        { round: 1, pairedAt: "2026-11-01", complete: true, notes: [{ kind: "pair", a: 1, b: 2, aPoints: 0, bPoints: 0, float: false, aVirtual: 2, bVirtual: 2 }, { kind: "pair", a: 3, b: 4, aPoints: 0, bPoints: 0, float: false, aVirtual: 2, bVirtual: 0 }] },
        { round: 2, pairedAt: "2026-11-02", complete: false, notes: [{ kind: "pair", a: 3, b: 1, aPoints: 2, bPoints: 1, float: false, aVirtual: 1, bVirtual: 1 }, { kind: "pair", a: 2, b: 4, aPoints: 1, bPoints: 0, float: false, aVirtual: 0, bVirtual: 0 }] },
      ],
      standings: [line(3, 1, 3), line(1, 2, 1), line(2, 3, 1), line(4, 4, 0)],
      nextRound: null,
      blocked: null,
      acceleration,
    },
  }) as never;

const BAKU = { method: "baku", rounds: 3, group: 4, points: 2, fullRounds: 2 };
const names = new Map([[1, "Aina"], [2, "Bala"], [3, "Chong"], [4, "Devi"]]);
const as = (role: StaffRole, ui: ReactElement) => <StaffMayProvider may={staffMay(role)}>{ui}</StaffMayProvider>;

describe("the public standings", () => {
  it("say what Baku acceleration was in words, and show points halved: 1, 1/2 and 0 for a chess table, a pairing's virtual point as '+ 1 accelerated' or '+ 1/2 accelerated'", () => {
    render(<SwissStandings t={translator("en")} x={chessTn(BAKU)} names={names} />);
    expect(screen.getByText(/Baku acceleration \(FIDE\): the best 4 of the initial order were paired as if they had one point more in round 1–2 and half a point more in round 3/)).toBeTruthy();
    // The table: Chong 3 table points is 1½, Aina and Bala 1 is ½, Devi 0.
    expect(screen.getAllByText("1½").length).toBeGreaterThan(0);
    expect(screen.getAllByText("½").length).toBeGreaterThanOrEqual(2);
    // Round 1 pairs: 0 + 1 accelerated; round 2 (virtual 1 table point): 1 + 1/2 accelerated.
    expect(screen.getByText(/0 \+ 1 accelerated–0 \+ 1 accelerated/)).toBeTruthy();
    expect(screen.getByText(/1 \+ ½ accelerated–½ \+ ½ accelerated/)).toBeTruthy();
    expect(screen.queryByText(/Accelerated pairing:/)).toBeNull();
  });

  it("an event of one accelerated round says only the full point; a standard event says nothing; the earlier constant method reads as it did", () => {
    render(<SwissStandings t={translator("en")} x={chessTn({ method: "baku", rounds: 1, group: 4, points: 2, fullRounds: 1 })} names={names} />);
    const text = screen.getByText(/Baku acceleration \(FIDE\)/).textContent ?? "";
    expect(text).toContain("one point more in round 1, so");
    expect(text).not.toContain("half a point");
    cleanup();
    render(<SwissStandings t={translator("en")} x={chessTn(null)} names={names} />);
    expect(screen.queryByText(/acceleration/i)).toBeNull();
    expect(screen.queryByText(/Accelerated pairing/)).toBeNull();
    cleanup();
    // A table of another sport (no halves flag): whole points as before, and the constant method's own sentence.
    const other = chessTn({ rounds: 2, group: 2, points: 1 }, DEFAULT_RULES as never);
    render(<SwissStandings t={translator("en")} x={other} names={names} />);
    expect(screen.getByText(/Accelerated pairing: in rounds 1 to 2 the best 2 of the initial order were paired as if they had a point more/)).toBeTruthy();
    expect(screen.queryByText(/Baku/)).toBeNull();
    expect(screen.queryByText("1½")).toBeNull();
  });

  it("is written in Malay, Chinese and Tamil too", () => {
    for (const [locale, word] of [["ms", /Pecutan Baku/], ["zh", /巴库加速法/], ["ta", /பாகு வேகப்படுத்தல்/]] as const) {
      render(<SwissStandings t={translator(locale)} x={chessTn(BAKU)} names={names} />);
      expect(screen.getByText(word)).toBeTruthy();
      cleanup();
    }
  });
});

describe("the organiser's panel", () => {
  it("states the method for staff and keeps the tables in halves", () => {
    const call = vi.fn(async () => ({ ok: true, data: {} }));
    render(as("manager", <SwissPanel tn={chessTn(BAKU)} names={names} base="/api/admin/tournaments/9" call={call} />));
    expect(screen.getByText(/Baku acceleration \(FIDE C\.04\.7\): the best 4 of the initial order \(group GA\) are paired as if they had one point more in round 1–2 and half a point more in round 3/)).toBeTruthy();
    expect(screen.getByText(/Points for a bye: 1\./)).toBeTruthy();
    expect(screen.getByText(/1 \+ ½ accelerated–½ \+ ½ accelerated/)).toBeTruthy();
    expect(screen.getAllByText("1½").length).toBeGreaterThan(0);
  });
});

describe("setting a chess event up", () => {
  const venue = { id: 1, name: "Chess Club", openMin: 6 * 60, closeMin: 22 * 60, courts: [{ id: 7, name: "Table 1", sport: "badminton", activities: [] }] } as never;
  const posts: { url: string; body: Record<string, unknown> }[] = [];

  beforeEach(() => {
    posts.length = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
        if (init?.method === "POST") {
          posts.push({ url, body: JSON.parse(init.body ?? "{}") });
          return { ok: true, json: async () => ({ tournament: null }) };
        }
        return { ok: true, json: async () => ({ tournaments: [], competitions: [], templates: TEMPLATES, venueTemplates: [] }) };
      })
    );
  });
  afterEach(() => vi.unstubAllGlobals());

  async function setUp() {
    render(<TournamentsTab venues={[venue]} />);
    await act(async () => {});
  }

  it("offers the pairing only on the chess template, standard first; the earlier constant checkbox is gone from a new event", async () => {
    await setUp();
    fireEvent.change(screen.getByDisplayValue("Knockout"), { target: { value: "swiss" } });
    expect(screen.queryByLabelText("Pairing")).toBeNull();
    expect(screen.queryByLabelText(/Accelerated pairing \(virtual point/)).toBeNull();
    fireEvent.change(screen.getByLabelText("Starting from"), { target: { value: "chess_results" } });
    const pairing = screen.getByLabelText("Pairing") as HTMLSelectElement;
    expect(pairing.value).toBe("standard");
    expect([...pairing.options].map((o) => o.text)).toEqual(["Standard Swiss pairing (the default)", "FIDE Baku acceleration (the best half carries virtual points in the first half of the rounds)"]);
    // Standard sends no acceleration at all.
    fireEvent.change(screen.getByPlaceholderText("Open Singles, November"), { target: { value: "Standard Chess Open" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Set it up and hold the courts" })[0]);
    await act(async () => {});
    expect(posts.at(-1)!.body).toMatchObject({ format: "swiss", template: "chess_results" });
    expect((posts.at(-1)!.body.rules as { swiss: Record<string, unknown> }).swiss).not.toHaveProperty("acceleration");
    // Baku is sent as the method, and the template's scoring (kept doubled, shown halved) goes with it.
    fireEvent.change(screen.getByLabelText("Pairing"), { target: { value: "baku" } });
    fireEvent.change(screen.getByPlaceholderText("Open Singles, November"), { target: { value: "Baku Chess Open" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Set it up and hold the courts" })[0]);
    await act(async () => {});
    const sent = posts.at(-1)!.body.rules as { swiss: Record<string, unknown>; scoring: { tablePoints: unknown; pointsInHalves: boolean } };
    expect(sent.swiss.acceleration).toEqual({ method: "baku" });
    expect(sent.scoring).toMatchObject({ tablePoints: { win: 2, draw: 1, loss: 0 }, pointsInHalves: true });
    // Choosing another template takes the choice away, and what is sent is standard.
    fireEvent.change(screen.getByLabelText("Starting from"), { target: { value: "racket_best_of_3" } });
    expect(screen.queryByLabelText("Pairing")).toBeNull();
    fireEvent.change(screen.getByPlaceholderText("Open Singles, November"), { target: { value: "Badminton Swiss" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Set it up and hold the courts" })[0]);
    await act(async () => {});
    expect((posts.at(-1)!.body.rules as { swiss: Record<string, unknown> }).swiss).not.toHaveProperty("acceleration");
  });
});
