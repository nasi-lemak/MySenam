// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { LessonCoach } from "../../src/components/admin/LessonCoach";

/**
 * Choosing the coach a lesson being moved goes with (staff): its own, or
 * another active coach of the venue for its sport; what that does to the
 * price shown first, and, on a paid lesson, the manager's choice to keep the
 * price as paid or adjust it (lib/lesson-coaches.ts).
 */

let fetchMock: ReturnType<typeof vi.fn>;
const coach = (id: number, name: string, over: Record<string, unknown> = {}) => ({ id, venueId: 1, name, bio: null, sports: ["tennis"], rate: 80, active: true, hours: [], timeOff: [], ...over });
const terms = (over: Record<string, unknown> = {}) => ({
  fromCoach: { id: 1, name: "Ana Lim" },
  toCoach: { id: 2, name: "Ben Tan" },
  fromFee: 80,
  toFee: 100,
  difference: 20,
  paid: false,
  refundHow: null,
  owed: 0,
  refund: 0,
  absorbed: 0,
  ...over,
});
let termsReply: { status: number; body: unknown };

beforeEach(() => {
  termsReply = { status: 200, body: { keep: terms(), adjust: terms() } };
  fetchMock = vi.fn(async (url: string) =>
    url.startsWith("/api/admin/bookings/lesson-coach")
      ? { ok: termsReply.status === 200, status: termsReply.status, json: async () => termsReply.body }
      : {
          ok: true,
          json: async () => ({
            coaches: [coach(1, "Ana Lim"), coach(2, "Ben Tan"), coach(3, "Cara Ong", { active: false }), coach(4, "Sam Swim", { sports: ["swimming"] })],
          }),
        }
  );
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
    expect(screen.getByText(/Another coach is a manager's change/)).toBeTruthy();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "2" } });
    expect(chosen).toEqual([2]);
    // Its own coach: nothing to ask about the money.
    expect(fetchMock.mock.calls.some((c) => String(c[0]).startsWith("/api/admin/bookings/lesson-coach"))).toBe(false);
  });

  it("another coach, not yet paid: the fees and the new price are shown before any time is chosen", async () => {
    render(<LessonCoach venueId={1} sport="tennis" coachId={1} coachName="Ana Lim" value={2} onChange={() => {}} code="MS-ABC123" />);
    await act(async () => {});
    expect(fetchMock.mock.calls.map((c) => c[0])).toContain("/api/admin/bookings/lesson-coach?code=MS-ABC123&coachId=2");
    const shown = screen.getByTestId("coach-terms").textContent ?? "";
    expect(shown).toContain("Ana Lim's fee for this lesson");
    expect(shown).toContain("Ben Tan's");
    expect(shown).toContain("Not paid yet: the price goes up by");
    expect(shown).toContain("The customer and both coaches are told");
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
  });

  it("another coach, paid: keep the price as paid or adjust it, each saying what it does", async () => {
    termsReply = {
      status: 200,
      body: { keep: terms({ paid: true, absorbed: 20, refundHow: "credit" }), adjust: terms({ paid: true, owed: 20, refundHow: "credit" }) },
    };
    const picked: string[] = [];
    const { rerender } = render(
      <LessonCoach venueId={1} sport="tennis" coachId={1} coachName="Ana Lim" value={2} onChange={() => {}} code="MS-ABC123" paid money={null} onMoney={(m) => picked.push(m)} />
    );
    await act(async () => {});
    const shown = screen.getByTestId("coach-terms").textContent ?? "";
    expect(shown).toContain("It is paid. Choose what happens to the price");
    expect(shown).toContain("the venue absorbs the");
    expect(shown).toContain("more owed by the customer, taken at the counter");
    const [keep, adjust] = screen.getAllByRole("radio") as HTMLInputElement[];
    expect(keep.checked || adjust.checked).toBe(false);
    fireEvent.click(adjust);
    expect(picked).toEqual(["adjust"]);
    rerender(<LessonCoach venueId={1} sport="tennis" coachId={1} coachName="Ana Lim" value={2} onChange={() => {}} code="MS-ABC123" paid money="adjust" onMoney={(m) => picked.push(m)} />);
    expect((screen.getAllByRole("radio")[1] as HTMLInputElement).checked).toBe(true);

    // A cheaper coach, paid online: what goes back and how.
    termsReply = { status: 200, body: { keep: terms({ paid: true, toFee: 60, difference: -20, absorbed: -20, refundHow: "online" }), adjust: terms({ paid: true, toFee: 60, difference: -20, refund: 20, refundHow: "online" }) } };
    rerender(<LessonCoach venueId={1} sport="tennis" coachId={1} coachName="Ana Lim" value={3} onChange={() => {}} code="MS-ABC123" paid money={null} />);
    await act(async () => {});
    const cheaper = screen.getByTestId("coach-terms").textContent ?? "";
    expect(cheaper).toContain("back on the online payment, with a credit note");
    expect(cheaper).toContain("the venue keeps the");
  });

  it("says why when the lesson cannot go to another coach", async () => {
    termsReply = { status: 409, body: { error: "This lesson was paid with a lesson pack for Ana Lim.", code: "LESSON_COACH_PASS", vars: { name: "Ana Lim" } } };
    render(<LessonCoach venueId={1} sport="tennis" coachId={1} coachName="Ana Lim" value={2} onChange={() => {}} code="MS-ABC123" paid />);
    await act(async () => {});
    expect(screen.getByTestId("coach-refused").textContent).toContain("lesson pack for Ana Lim");
    expect(screen.queryByTestId("coach-terms")).toBeNull();
  });
});
