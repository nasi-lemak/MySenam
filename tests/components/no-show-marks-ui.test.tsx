// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { NoShowMarksPanel } from "../../src/components/admin/NoShowMarksPanel";
import { PeopleAttention, peopleLineCount } from "../../src/components/admin/PeopleAttention";
import type { PeopleAttention as PeopleData } from "../../src/lib/people-attention";

/**
 * The staff side of a host's no-show marks (ADR 0072): the list a manager decides from, with a note that is asked for and sent, and the
 * needs-attention lines about people.
 */

let fetchMock: ReturnType<typeof vi.fn>;
const json = (body: unknown, ok = true, status = ok ? 200 : 400) => ({ ok, status, json: async () => body });

beforeEach(() => {
  fetchMock = vi.fn(async () => json({ marks: [], hosts: [] }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const mark = (id: number, over = {}) => ({
  id,
  gameId: 3,
  venueId: 1,
  venueName: "Arena One",
  date: "2026-11-05",
  startHour: 19,
  playerName: "Aisyah",
  hostName: "Boon",
  reason: "Did not turn up, no message.",
  status: "disputed",
  scope: "venue",
  markedAt: "2026-11-05 21:00:00",
  answer: "I was there at the start.",
  answeredAt: "2026-11-06 08:00:00",
  reviewedBy: null,
  reviewedAt: null,
  reviewNote: null,
  platformNote: null,
  waitingDays: 1,
  may: { reverse: true, uphold: true, platform: false },
  ...over,
});

describe("the no-show marks panel", () => {
  it("lists a mark with its reason, the player's answer and where it counts, and decides it with a note", async () => {
    fetchMock.mockImplementation(async (_u: string, init?: RequestInit) =>
      init?.method === "POST" ? json({ marks: [], hosts: [] }) : json({ marks: [mark(7)], hosts: [] })
    );
    vi.spyOn(window, "prompt").mockReturnValue("Court staff confirm they were on court.");
    render(<NoShowMarksPanel />);
    await act(async () => {});
    expect(String(fetchMock.mock.calls[0][0])).toBe("/api/admin/no-show-marks?show=review");
    expect(screen.getByText(/Aisyah at Arena One/)).toBeTruthy();
    expect(screen.getByText("Reason given: Did not turn up, no message.")).toBeTruthy();
    expect(screen.getByText("The player's answer: I was there at the start.")).toBeTruthy();
    expect(screen.getByText(/At this venue only/)).toBeTruthy();
    // A manager is not offered the owner's decision.
    expect(screen.queryByText("Make it count at every venue")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByText("Take the mark off"));
    });
    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST")!;
    expect(post[0]).toBe("/api/admin/no-show-marks");
    expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({ id: 7, decision: "reverse", note: "Court staff confirm they were on court." });
  });

  it("sends nothing when the note prompt is cancelled, and says a refusal in the staff language", async () => {
    fetchMock.mockImplementation(async (_u: string, init?: RequestInit) =>
      init?.method === "POST" ? json({ error: "That mark is not waiting for a decision.", code: "NS_STATE" }, false, 409) : json({ marks: [mark(8, { reason: null, may: { reverse: true, uphold: true, platform: true } })], hosts: [] })
    );
    const prompt = vi.spyOn(window, "prompt").mockReturnValueOnce(null);
    render(<NoShowMarksPanel />);
    await act(async () => {});
    expect(screen.getByText(/Recorded before reasons were kept/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByText("Let it stand"));
    });
    expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toHaveLength(0);
    // The owner's third decision asks for a justification, not just a note.
    prompt.mockReturnValueOnce("Many complaints.");
    await act(async () => {
      fireEvent.click(screen.getByText("Make it count at every venue"));
    });
    expect(String(prompt.mock.calls[1][0])).toMatch(/justification/);
    expect(screen.getByText("That mark is not waiting for a decision.")).toBeTruthy();
  });
});

describe("the people block of needs-attention", () => {
  const data = (over: Partial<PeopleData> = {}): PeopleData => ({
    noShow: { answersWaiting: 2, oldestWaitingDays: 3, legacyPlatform: 0, hosts: [{ hostId: 4, name: "Boon", reversed: 3, marked: 4 }] },
    expiring: [
      { kind: "pass", id: 1, code: "PS1", venueId: 1, venueName: "Arena One", what: "10 sessions", holder: "Aisyah", expiresOn: "2026-11-12", daysLeft: 5, left: 6, told: true },
      { kind: "voucher", id: 2, code: "GV-1", venueId: 1, venueName: "Arena One", what: "GV-1", holder: null, expiresOn: "2026-11-15", daysLeft: 8, left: 60, told: false },
    ],
    low: [{ id: 3, code: "PS9", venueId: 1, venueName: "Arena One", what: "5 sessions", holder: "Chen", left: 1, expiresOn: "2027-01-01" }],
    strikes: [{ venueId: 1, venueName: "Arena One", name: "Gina", phone: "0125551001", strikes: 3, limit: 3, out: true, lastOn: "2026-11-06" }],
    coaches: [{ coachId: 5, coach: "Tala", venueId: 1, venueName: "Arena One", lessons: 4, firstDate: "2026-11-09", hasLink: false }],
    ...over,
  });

  it("counts its lines, and is empty with nothing to say", () => {
    expect(peopleLineCount(data())).toBe(1 + 1 + 1 + 1 + 1 + 1);
    expect(peopleLineCount({ noShow: null, expiring: [], low: [], strikes: [], coaches: [] })).toBe(0);
    expect(peopleLineCount(null)).toBe(0);
  });

  it("says what is waiting, what ends, who is at the limit and which coaches nobody can tell", () => {
    render(<PeopleAttention data={data()} />);
    expect(screen.getByText(/2 players' answers to no-show marks are waiting for you \(the oldest 3 day\(s\)\)/)).toBeTruthy();
    expect(screen.getByText(/Boon marked 4 players in the last 6 months and a reviewer took 3 of the marks off/)).toBeTruthy();
    expect(screen.getByText(/2 passes, memberships or vouchers end within 14 days/)).toBeTruthy();
    expect(screen.getByText(/Pass PS1 \(10 sessions\), Aisyah: 6 entries left, ends 2026-11-12 \(Arena One\)\./)).toBeTruthy();
    expect(screen.getByText(/The holder is emailed once\./).closest("li")?.textContent).toContain("PS1");
    expect(screen.getByText(/Gift voucher GV-1 \(worth/).closest("li")?.textContent).not.toContain("emailed");
    expect(screen.getByText(/1 pass is down to its last entries/)).toBeTruthy();
    expect(screen.getByText(/Gina, 0125551001: 3 of 3 at Arena One/)).toBeTruthy();
    expect(screen.getByText(/At the limit: must pay online to book/)).toBeTruthy();
    expect(screen.getByText(/1 coach has lessons coming and no email address/)).toBeTruthy();
    expect(screen.getByText(/Tala \(Arena One\): 4 lesson\(s\) from 2026-11-09\./)).toBeTruthy();
  });
});
