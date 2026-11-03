/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { daysBetween, mayChallenge, readSettings, replay, DEFAULT_SETTINGS, type EventData, type EventKind, type LadderEvent } from "../src/lib/ladders";
import { seededRandom } from "../src/lib/swiss";

/**
 * The ladder's replay and the challenge rules, apart from the database (ADR 0033): the published rank rule against
 * hand-worked ladders, and properties of the replay over random ledgers.
 */

let ord = 0;
const ev = (kind: EventKind, playerId: number, other: number | null = null, data: EventData = {}, on = "2030-01-01"): LadderEvent => ({ ord: ++ord, kind, playerId, otherId: other, on, data });
const joins = (...ids: number[]) => ids.map((id) => ev("join", id));
const order = (events: LadderEvent[]) => replay(events).map((r) => r.playerId);

describe("the rank rule", () => {
  it("puts newcomers at the bottom, in the order they joined", () => {
    expect(order(joins(1, 2, 3, 4, 5))).toEqual([1, 2, 3, 4, 5]);
  });

  it("gives a winning challenger the challenged's rank and moves everybody between down one", () => {
    // 5 challenges 3 and wins: 5 takes rank 3; 3 and 4 move down.
    expect(order([...joins(1, 2, 3, 4, 5), ev("result", 5, 3, { challengerWon: true })])).toEqual([1, 2, 5, 3, 4]);
    // The challenger one place below and winning swaps.
    expect(order([...joins(1, 2, 3), ev("result", 3, 2, { challengerWon: true })])).toEqual([1, 3, 2]);
  });

  it("changes nothing when the challenged wins", () => {
    expect(order([...joins(1, 2, 3, 4), ev("result", 4, 2, { challengerWon: false })])).toEqual([1, 2, 3, 4]);
  });

  it("moves nobody for a result whose challenger is already above the challenged (a replay after a correction is always defined)", () => {
    expect(order([...joins(1, 2, 3), ev("result", 1, 3, { challengerWon: true })])).toEqual([1, 2, 3]);
  });

  it("closes the gap for a leaver and a manager's removal, and ignores events about somebody not there", () => {
    expect(order([...joins(1, 2, 3, 4), ev("leave", 2)])).toEqual([1, 3, 4]);
    expect(order([...joins(1, 2, 3, 4), ev("remove", 1), ev("leave", 99), ev("drop", 99, null, { places: 2 }), ev("result", 99, 1, { challengerWon: true })])).toEqual([2, 3, 4]);
  });

  it("drops a player down p places and moves those they pass up one, never below the bottom", () => {
    expect(order([...joins(1, 2, 3, 4, 5), ev("drop", 1, null, { places: 2 })])).toEqual([2, 3, 1, 4, 5]);
    expect(order([...joins(1, 2, 3), ev("drop", 2, null, { places: 9 })])).toEqual([1, 3, 2]);
  });

  it("moves somebody to a rank for a manager, and adds a newcomer at a rank", () => {
    expect(order([...joins(1, 2, 3, 4), ev("move", 4, null, { toRank: 1 })])).toEqual([4, 1, 2, 3]);
    expect(order([...joins(1, 2, 3), ev("join", 9, null, { toRank: 2 })])).toEqual([1, 9, 2, 3]);
    expect(order([...joins(1, 2, 3), ev("move", 1, null, { toRank: 99 })])).toEqual([2, 3, 1]);
  });

  it("is the same whatever order the events are given in: they are replayed by their place in the ledger", () => {
    const events = [...joins(1, 2, 3, 4, 5), ev("result", 4, 2, { challengerWon: true }), ev("drop", 1, null, { places: 1 })];
    expect(order([...events].reverse())).toEqual(order(events));
  });

  it("keeps a corrected result in its place: replacing an event changes every rank after it and nothing before", () => {
    const base = joins(1, 2, 3, 4, 5);
    const first = ev("result", 4, 2, { challengerWon: true });
    const later = [ev("result", 5, 3, { challengerWon: true }), ev("result", 3, 4, { challengerWon: true })];
    const asPlayed = order([...base, first, ...later]);
    // The first result corrected to a win for the challenged: the same later events, replayed on the corrected ladder.
    const corrected = order([...base, { ...first, data: { challengerWon: false } }, ...later]);
    expect(asPlayed).not.toEqual(corrected);
    // Nothing before the corrected event moved.
    expect(order([...base])).toEqual([1, 2, 3, 4, 5]);
    // And replaying the corrected ledger from scratch twice is the same.
    expect(order([...base, { ...first, data: { challengerWon: false } }, ...later])).toEqual(corrected);
  });
});

describe("activity, freezes and what a replay remembers", () => {
  it("counts a played result as activity for both, a forfeit only for the winner, a drop as the player's own", () => {
    const rows = replay([...joins(1, 2, 3).map((e) => ({ ...e, on: "2030-01-01" })), ev("result", 3, 2, { challengerWon: true, forfeit: true }, "2030-02-01"), ev("result", 2, 1, { challengerWon: false }, "2030-03-01"), ev("drop", 1, null, { places: 1 }, "2030-04-01")]);
    const by = new Map(rows.map((r) => [r.playerId, r]));
    // 3 won by forfeit on 1 Feb: active. 2 lost by forfeit then played 1 on 1 March: active then. 1 dropped on 1 April.
    expect(by.get(3)!.activeOn).toBe("2030-02-01");
    expect(by.get(2)!.activeOn).toBe("2030-03-01");
    expect(by.get(1)!.activeOn).toBe("2030-04-01");
  });

  it("freezes until a day and thaws, restarting the idleness count", () => {
    const rows = replay([...joins(1, 2), ev("freeze", 1, null, { until: "2030-02-10" }, "2030-02-01")]);
    expect(rows.find((r) => r.playerId === 1)!.frozenUntil).toBe("2030-02-10");
    const after = replay([...joins(1, 2), ev("freeze", 1, null, { until: "2030-02-10" }, "2030-02-01"), ev("thaw", 1, null, {}, "2030-02-11")]);
    expect(after.find((r) => r.playerId === 1)).toMatchObject({ frozenUntil: null, activeOn: "2030-02-11" });
  });

  it("has the same ladder as a fresh replay however many random events it has: always every present player once", () => {
    for (let seed = 1; seed <= 25; seed++) {
      const rand = seededRandom(seed);
      const events: LadderEvent[] = [];
      let o = 0;
      const add = (kind: EventKind, p: number, other: number | null = null, data: EventData = {}) => events.push({ ord: ++o, kind, playerId: p, otherId: other, on: "2030-01-01", data });
      for (let i = 1; i <= 8; i++) add("join", i);
      for (let step = 0; step < 60; step++) {
        const p = 1 + Math.floor(rand() * 10);
        const q = 1 + Math.floor(rand() * 10);
        const pick = rand();
        if (pick < 0.5) add("result", p, q, { challengerWon: rand() < 0.5, forfeit: rand() < 0.2 });
        else if (pick < 0.65) add("drop", p, null, { places: 1 + Math.floor(rand() * 3) });
        else if (pick < 0.75) add("move", p, null, { toRank: 1 + Math.floor(rand() * 9) });
        else if (pick < 0.82) add("leave", p);
        else if (pick < 0.9) add("join", p);
        else if (pick < 0.95) add("freeze", p, null, { until: "2030-03-01" });
        else add("thaw", p);
      }
      const a = replay(events);
      const b = replay(JSON.parse(JSON.stringify(events)) as LadderEvent[]);
      expect(b).toEqual(a);
      expect(a.map((r) => r.rank)).toEqual(a.map((_, i) => i + 1));
      expect(new Set(a.map((r) => r.playerId)).size).toBe(a.length);
      // Every prefix is itself a ladder: a replay never depends on what comes after.
      for (let cut = 0; cut < events.length; cut += 17) {
        const prefix = replay(events.slice(0, cut));
        expect(new Set(prefix.map((r) => r.playerId)).size).toBe(prefix.length);
      }
    }
  });
});

describe("who may challenge whom", () => {
  const ranks = (frozen: Record<number, string> = {}) => replay(joins(1, 2, 3, 4, 5, 6).map((e) => ({ ...e }))).map((r) => ({ ...r, frozenUntil: frozen[r.playerId] ?? null }));
  const ctx = (over: Partial<{ busy: number[]; together: [string, string][]; today: string }> = {}) => ({
    today: over.today ?? "2030-02-01",
    busy: new Set(over.busy ?? []),
    lastTogether: new Map(over.together ?? []),
    names: new Map([1, 2, 3, 4, 5, 6].map((i) => [i, `P${i}`])),
  });
  const rules = { reach: 3, cooldownDays: 14 };

  it("allows a player within reach above, and says why not for the rest", () => {
    expect(mayChallenge(ranks(), rules, 5, 3, ctx())).toBeNull();
    expect(mayChallenge(ranks(), rules, 5, 2, ctx())).toBeNull();
    expect(mayChallenge(ranks(), rules, 5, 1, ctx())).toMatchObject({ code: "LD_REACH", vars: { n: 4, k: 3 } });
    expect(mayChallenge(ranks(), rules, 3, 5, ctx())).toMatchObject({ code: "LD_NOT_ABOVE" });
    expect(mayChallenge(ranks(), rules, 3, 3, ctx())).toMatchObject({ code: "LD_SELF" });
    expect(mayChallenge(ranks(), rules, 3, 99, ctx())).toMatchObject({ code: "LD_NOT_ON" });
  });

  it("refuses a frozen player either way, an open challenge on either side, and the same opponent within the cooldown", () => {
    expect(mayChallenge(ranks({ 5: "2030-02-20" }), rules, 5, 4, ctx())).toMatchObject({ code: "LD_FROZEN_ME", vars: { date: "2030-02-20" } });
    expect(mayChallenge(ranks({ 4: "2030-02-20" }), rules, 5, 4, ctx())).toMatchObject({ code: "LD_FROZEN_THEM" });
    expect(mayChallenge(ranks(), rules, 5, 4, ctx({ busy: [5] }))).toMatchObject({ code: "LD_BUSY_ME" });
    expect(mayChallenge(ranks(), rules, 5, 4, ctx({ busy: [4] }))).toMatchObject({ code: "LD_BUSY_THEM" });
    const together: [string, string][] = [["4:5", "2030-01-25"]];
    expect(mayChallenge(ranks(), rules, 5, 4, ctx({ together }))).toMatchObject({ code: "LD_COOLDOWN", vars: { until: "2030-02-08" } });
    expect(mayChallenge(ranks(), rules, 5, 4, ctx({ together, today: "2030-02-08" }))).toBeNull();
    expect(mayChallenge(ranks(), { reach: 3, cooldownDays: 0 }, 5, 4, ctx({ together }))).toBeNull();
  });
});

describe("settings", () => {
  it("lay what is given over the defaults, and refuse what is out of range", () => {
    expect(readSettings(undefined)).toEqual({ ok: true, settings: DEFAULT_SETTINGS });
    expect(readSettings({ reach: 5, declineIs: "forfeit" })).toMatchObject({ ok: true, settings: { reach: 5, declineIs: "forfeit", respondDays: 3 } });
    expect(readSettings({ reach: 0 })).toMatchObject({ ok: false });
    expect(readSettings({ respondDays: 30 })).toMatchObject({ ok: false });
    expect(readSettings({ inactiveDays: 0 })).toMatchObject({ ok: true });
    expect(readSettings({ declineIs: "maybe" as never })).toMatchObject({ ok: false });
  });

  it("counts whole days between dates", () => {
    expect(daysBetween("2030-01-01", "2030-01-31")).toBe(30);
    expect(daysBetween("2030-03-01", "2030-02-01")).toBe(-28);
  });
});
