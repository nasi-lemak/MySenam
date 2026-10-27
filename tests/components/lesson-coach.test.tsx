// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { LessonCoach } from "../../src/components/admin/LessonCoach";

/**
 * Choosing the coach a lesson being moved goes with (staff): its own, or
 * another active coach of the venue for its sport.
 */

let fetchMock: ReturnType<typeof vi.fn>;
const coach = (id: number, name: string, over: Record<string, unknown> = {}) => ({ id, venueId: 1, name, bio: null, sports: ["tennis"], rate: 80, active: true, hours: [], timeOff: [], ...over });

beforeEach(() => {
  fetchMock = vi.fn(async () => ({
    ok: true,
    json: async () => ({
      coaches: [coach(1, "Ana Lim"), coach(2, "Ben Tan"), coach(3, "Cara Ong", { active: false }), coach(4, "Sam Swim", { sports: ["swimming"] })],
    }),
  }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("the lesson's coach when moving it", () => {
  it("offers its own coach first, then the venue's other active coaches for the sport, and says what that means", async () => {
    const chosen: number[] = [];
    render(<LessonCoach venueId={1} sport="tennis" coachId={1} coachName="Ana Lim" value={1} onChange={(id) => chosen.push(id)} />);
    await act(async () => {});
    expect(fetchMock.mock.calls[0][0]).toBe("/api/admin/coaches?venueId=1");
    const options = screen.getAllByRole("option").map((o) => o.textContent);
    expect(options).toEqual(["Ana Lim (as booked)", "Ben Tan"]);
    expect(screen.getByText(/Another coach only while nothing has been paid on the lesson/)).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "2" } });
    expect(chosen).toEqual([2]);
  });
});
