// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { ClassMovePanel } from "../../src/components/admin/ClassMovePanel";
import { ClassMoveRequestList } from "../../src/components/admin/ClassMoveRequests";
import { StaffMayProvider } from "../../src/components/admin/StaffMay";

/**
 * Front desk's class moves that wait for a manager (lib/class-move-requests.ts): the desk is told why a move needs approval and sends it for
 * approval (nothing is said to have moved); a manager sees the request and approves it or declines it with a reason; the desk sees it waiting.
 */

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const session = {
  id: 5, courtId: 2, courtName: "Studio", venueId: 1, venueName: "V", venueArea: "A", sport: "gym", name: "Yoga", instructor: "Mei",
  date: "2026-11-20", startMin: 1140, endMin: 1200, startHour: 19, endHour: 20, capacity: 8, price: 25, status: "scheduled",
  seriesCode: null, enrolled: 2, who: "anyone", coachId: null,
} as never;

const preview = {
  ok: true,
  scope: "one" as const,
  windowDays: 7,
  blocked: false,
  skipped: [],
  sessions: [
    {
      classId: 5,
      name: "Yoga",
      seriesCode: null,
      from: { date: "2026-11-20", startMin: 1140, endMin: 1200, courtId: 2, courtName: "Studio" },
      to: { date: "2026-12-30", startMin: 1140, endMin: 1200, courtId: 2, courtName: "Studio" },
      enrolled: 2,
      waiting: 0,
      people: [],
    },
  ],
  notices: [],
  approval: { required: true, reasons: [{ code: "far", kind: "exceptional", n: 40, limit: 14 }] },
};

const request = (over: Record<string, unknown> = {}) => ({
  id: 7,
  venueId: 1,
  classId: 5,
  className: "Yoga",
  scope: "one" as const,
  sessions: 1,
  from: { date: "2026-11-20", startMin: 1140, endMin: 1200, courtId: 2, courtName: "Studio" },
  to: { date: "2026-12-30", startMin: 1140, endMin: 1200, courtId: 2, courtName: "Studio" },
  enrolled: 2,
  waiting: 0,
  requestedBy: "Dan Desk",
  requestedByMe: false,
  note: "Floor work.",
  reasons: [{ code: "far", kind: "exceptional", n: 40, limit: 14 }],
  status: "open",
  createdAt: "2026-11-05T10:00:00.000Z",
  expiresAt: "2026-11-12T10:00:00.000Z",
  decidedBy: null,
  decidedAt: null,
  decisionNote: null,
  closedReason: null,
  moveId: null,
  ...over,
});

describe("a desk's move that needs approval", () => {
  it("says why, offers to send it for approval with a note, and says it was sent and not moved", async () => {
    const calls: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}"));
        calls.push(body);
        return body.preview ? json(preview) : json({ requested: true, request: request() }, 202);
      })
    );
    const done = vi.fn();
    render(<ClassMovePanel session={session} courts={[]} onDone={done} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("New date"), { target: { value: "2026-12-30" } });
    await act(async () => {
      fireEvent.click(screen.getByText("See what it would do"));
    });
    expect(screen.getByTestId("move-approval").textContent).toContain("A manager must approve this move");
    expect(screen.getByTestId("move-approval").textContent).toContain("it moves a session 40 days (the limit is 14)");
    fireEvent.change(screen.getByLabelText("Note for the manager (optional)"), { target: { value: "Floor work." } });
    await act(async () => {
      fireEvent.click(screen.getByText("Send for approval"));
    });
    expect(calls[1]).toMatchObject({ date: "2026-12-30", note: "Floor work." });
    expect(done).toHaveBeenCalledWith("Sent to a manager for approval. Nothing has moved and nobody has been told.");
  });
});

describe("the requests waiting", () => {
  it("a manager approves one: the class moves and the list is read again", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url, body: JSON.parse(String(init?.body ?? "{}")) });
        return json({ request: request({ status: "approved" }), moveId: 3, classes: [{}], told: 2 });
      })
    );
    const changed = vi.fn();
    const notice = vi.fn();
    render(<ClassMoveRequestList requests={[request()] as never} onChanged={changed} onNotice={notice} />);
    expect(screen.getByText(/Class moves waiting for approval \(1\)/)).toBeTruthy();
    expect(screen.getByText(/Needs approval because: it moves a session 40 days/)).toBeTruthy();
    expect(screen.getByText("Note: Floor work.")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByText("Approve and move"));
    });
    expect(calls[0]).toEqual({ url: "/api/admin/class-move-requests/7", body: { approve: true } });
    expect(notice).toHaveBeenCalledWith("Approved and moved. 2 people were told.");
    expect(changed).toHaveBeenCalled();
  });

  it("a manager declines with a reason, which is required", async () => {
    const calls: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        calls.push(JSON.parse(String(init?.body ?? "{}")));
        return json({ request: request({ status: "declined" }) });
      })
    );
    render(<ClassMoveRequestList requests={[request()] as never} onChanged={() => {}} />);
    fireEvent.click(screen.getByText("Decline"));
    const send = screen.getByText("Decline the request") as HTMLButtonElement;
    expect(send.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Reason for declining"), { target: { value: "Keep it." } });
    expect(send.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(send);
    });
    expect(calls[0]).toEqual({ decline: true, reason: "Keep it." });
  });

  it("the desk sees it waiting, with no buttons, and the outcome of what it asked", () => {
    render(
      <StaffMayProvider may={{ classMoveDecide: false }}>
        <ClassMoveRequestList
          requests={[request({ requestedByMe: true }), request({ id: 8, status: "declined", decidedBy: "Mona Manager", decisionNote: "Keep it." }), request({ id: 9, status: "closed", closedReason: "started" })] as never}
          onChanged={() => {}}
        />
      </StaffMayProvider>
    );
    expect(screen.getByText("Waiting for a manager")).toBeTruthy();
    expect(screen.queryByText("Approve and move")).toBeNull();
    expect(screen.getByText("Declined by Mona Manager: Keep it.")).toBeTruthy();
    expect(screen.getByText("Closed: the class has begun")).toBeTruthy();
  });
});
