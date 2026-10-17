import { describe, expect, it } from "vitest";
import { boxSizes, intoBoxes, ladder, seasonMoves } from "../src/lib/boxes";

/** How many boxes, how big, who moves, and who goes where next season. */

describe("boxes", () => {
  it("are the size asked, the odd ones over spread from the top, between three and six", () => {
    expect(boxSizes(8, 4)).toEqual([4, 4]);
    expect(boxSizes(9, 4)).toEqual([5, 4]);
    expect(boxSizes(10, 4)).toEqual([5, 5]);
    expect(boxSizes(7, 4)).toEqual([4, 3]);
    expect(boxSizes(13, 5)).toEqual([5, 4, 4]);
    expect(boxSizes(14, 6)).toEqual([5, 5, 4]);
    // Five can't make two boxes of three: one box of five.
    expect(boxSizes(5, 4)).toEqual([5]);
    expect(boxSizes(3, 6)).toEqual([3]);
    expect(boxSizes(0, 4)).toEqual([]);
    expect(intoBoxes([1, 2, 3, 4, 5, 6, 7], [4, 3])).toEqual([
      [1, 2, 3, 4],
      [5, 6, 7],
    ]);
  });
});

describe("moves", () => {
  it("send the best up and the worst down, but not off the top or bottom", () => {
    const moves = seasonMoves(
      [
        ["a1", "a2", "a3", "a4"],
        ["b1", "b2", "b3", "b4"],
        ["c1", "c2", "c3"],
      ],
      1
    );
    expect([...moves.entries()].filter(([, m]) => m !== "stay")).toEqual([
      ["a4", "down"],
      ["b1", "up"],
      ["b4", "down"],
      ["c1", "up"],
    ]);
  });

  it("never move more than half a box", () => {
    const moves = seasonMoves([["a1", "a2", "a3"], ["b1", "b2", "b3"]], 2);
    expect(moves.get("a2")).toBe("stay");
    expect(moves.get("a3")).toBe("down");
    expect(moves.get("b1")).toBe("up");
    expect(moves.get("b2")).toBe("stay");
  });
});

describe("next season", () => {
  it("puts movers in their new box, newcomers placed by staff at its foot, and the rest at the bottom by level", () => {
    const order = ladder([
      { id: 1, last: { box: 1, finish: 1, move: "stay" }, level: 0 },
      { id: 2, last: { box: 1, finish: 3, move: "down" }, level: 0 },
      { id: 3, last: { box: 2, finish: 1, move: "up" }, level: 0 },
      { id: 4, last: { box: 2, finish: 2, move: "stay" }, level: 0 },
      { id: 5, last: null, level: 2 },
      { id: 6, last: null, startBox: 1, level: 0 },
      { id: 7, last: null, level: 4 },
      { id: 8, last: { box: 1, finish: 2, move: "stay" }, level: 0 },
    ]);
    // Box 1: stayers by finish, the one coming up, the newcomer staff placed.
    // Box 2: the one coming down first, then who stayed; then newcomers, best level first.
    expect(order).toEqual([1, 8, 3, 6, 2, 4, 7, 5]);
  });

  it("in a first season, is level and then who joined first", () => {
    expect(
      ladder([
        { id: 1, level: 1 },
        { id: 2, level: 3 },
        { id: 3, level: 0 },
        { id: 4, level: 3 },
      ])
    ).toEqual([2, 4, 1, 3]);
  });
});
