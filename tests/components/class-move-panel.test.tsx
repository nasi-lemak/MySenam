// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { ClassEditor } from "../../src/components/admin/ClassEditor";
import { ClassMovePanel } from "../../src/components/admin/ClassMovePanel";

/**
 * The screens for moving a class and for naming one of the venue's coaches as its instructor: asked first, what it would do and
 * what is in the way; moved only when nothing is; and a coach chosen sends the coach, not a typed name.
 */

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const session = {
  id: 5, courtId: 2, courtName: "Studio", venueId: 1, venueName: "V", venueArea: "A", sport: "gym", name: "Yoga", instructor: "Mei",
  date: "2026-11-20", startMin: 1140, endMin: 1200, startHour: 19, endHour: 20, capacity: 8, price: 25, status: "scheduled",
  seriesCode: "CL-ABCDEF", enrolled: 2, who: "anyone", coachId: null,
} as never;

const preview = (conflict?: unknown) => ({
  ok: true,
  scope: "one",
  windowDays: 7,
  blocked: conflict !== undefined,
  skipped: [{ classId: 9, date: "2026-11-13", reason: "started" }],
  sessions: [
    {
      classId: 5,
      name: "Yoga",
      seriesCode: "CL-ABCDEF",
      from: { date: "2026-11-20", startMin: 1140, endMin: 1200, courtId: 2, courtName: "Studio" },
      to: { date: "2026-11-21", startMin: 1080, endMin: 1140, courtId: 2, courtName: "Studio" },
      enrolled: 2,
      waiting: 1,
      people: [{ bookingId: 1, code: "AAA111", name: "Ann Lee", participantName: null, paymentStatus: "paid", pass: true, membership: false }],
      ...(conflict ? { conflict } : {}),
    },
  ],
  notices: [{ name: "Ann Lee", kind: "enrolled", locale: "en", channels: ["email"], text: "Hi Ann, the venue changed it." }],
});

describe("moving a class", () => {
  it("asks first what it would do, then moves what was asked, and says who was told", async () => {
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        const body = JSON.parse(String(init?.body ?? "{}"));
        calls.push({ url, body });
        return body.preview ? json(preview()) : json({ classes: [{}, {}], told: 3, skipped: [] });
      })
    );
    const done = vi.fn();
    render(<ClassMovePanel session={session} courts={[{ id: 2, name: "Studio", capacity: 8 }, { id: 3, name: "Hall", capacity: 12 }]} onDone={done} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText("New date"), { target: { value: "2026-11-21" } });
    fireEvent.change(screen.getByLabelText("New start"), { target: { value: "18:00" } });
    fireEvent.change(screen.getByLabelText("What to move"), { target: { value: "term" } });
    fireEvent.change(screen.getByLabelText("Court"), { target: { value: "3" } });
    await act(async () => {
      fireEvent.click(screen.getByText("See what it would do"));
    });
    expect(calls[0]).toEqual({ url: "/api/admin/classes/5/move", body: { date: "2026-11-21", start: 1080, scope: "term", courtId: 3, preview: true } });
    // Who is in it, who waits, what is left alone and what each person will be told.
    expect(screen.getByText("2 enrolled · 1 waiting")).toBeTruthy();
    expect(screen.getByText("pass entry")).toBeTruthy();
    expect(screen.getByText(/already begun, left where it is/)).toBeTruthy();
    expect(screen.getByText(/Each person may cancel for everything back for 7 days/)).toBeTruthy();
    expect(screen.getByText("Hi Ann, the venue changed it.")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByText("Move it and tell everyone"));
    });
    expect(calls[1].body).toEqual({ date: "2026-11-21", start: 1080, scope: "term", courtId: 3 });
    expect(done).toHaveBeenCalledWith("Moved 2 sessions; 3 told.");
  });

  it("will not offer the move while something is in the way, and says what", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json(preview({ error: "Studio has another class on 2026-11-21 at that time.", code: "CLSA_MOVE_CLASS", vars: { court: "Studio", date: "2026-11-21" } }))));
    render(<ClassMovePanel session={session} courts={[]} onDone={() => {}} onClose={() => {}} />);
    await act(async () => {
      fireEvent.click(screen.getByText("See what it would do"));
    });
    expect(screen.getByText(/Cannot be moved: Studio has another class/)).toBeTruthy();
    expect(screen.getByText("Resolve what is in the way to move it.")).toBeTruthy();
    expect(screen.queryByText("Move it and tell everyone")).toBeNull();
  });

  it("shows the refusal of a move, naming the other sessions in the way", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        json(
          {
            error: "Studio has bookings or blocks on 2026-11-21 in those hours.",
            code: "CLSA_MOVE_BOOKED",
            vars: { court: "Studio", date: "2026-11-21" },
            conflicts: [
              { classId: 5, date: "2026-11-20", error: "x", code: "CLSA_MOVE_BOOKED", vars: { court: "Studio", date: "2026-11-21" } },
              { classId: 6, date: "2026-11-27", error: "Studio has another class on 2026-11-28 at that time.", code: "CLSA_MOVE_CLASS", vars: { court: "Studio", date: "2026-11-28" } },
            ],
          },
          409
        )
      )
    );
    render(<ClassMovePanel session={session} courts={[]} onDone={() => {}} onClose={() => {}} />);
    await act(async () => {
      fireEvent.click(screen.getByText("See what it would do"));
    });
    await waitFor(() => expect(screen.getByText(/has bookings or blocks on 2026-11-21.*another class on 2026-11-28/)).toBeTruthy());
  });

  it("offers one scope only for a class that is not in a series", () => {
    vi.stubGlobal("fetch", vi.fn());
    render(<ClassMovePanel session={{ ...(session as object), seriesCode: null } as never} courts={[]} onDone={() => {}} onClose={() => {}} />);
    expect(screen.queryByLabelText("What to move")).toBeNull();
  });
});

describe("a coach as a class's instructor", () => {
  const coaches = {
    coaches: [
      { id: 7, name: "Ana Lim", active: true, sports: ["gym"] },
      { id: 8, name: "Tennis Tan", active: true, sports: ["tennis"] },
      { id: 9, name: "Retired Ray", active: false, sports: ["gym"] },
    ],
  };

  it("offers the venue's active coaches of the activity, and sends the coach, not a name", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => (init?.method === "PATCH" ? json({ classes: [{}], offered: 0 }) : json(coaches)));
    vi.stubGlobal("fetch", fetchMock);
    const done = vi.fn();
    await act(async () => {
      render(<ClassEditor session={session} onDone={done} onClose={() => {}} />);
    });
    const select = await screen.findByLabelText("Taught by");
    expect(Array.from((select as HTMLSelectElement).options).map((o) => o.text)).toEqual(["A name only (typed below)", "Coach: Ana Lim"]);
    await act(async () => {
      fireEvent.change(select, { target: { value: "7" } });
    });
    // The typed name goes while a coach is chosen.
    expect(screen.queryByLabelText("Instructor")).toBeNull();
    expect(screen.getByText(/held for the session's time as a lesson's is/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByText("Save changes"));
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/classes/5", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ coachId: 7 }) }));
  });

  it("makes a class a name only again, with the typed name", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => (init?.method === "PATCH" ? json({ classes: [{}], offered: 0 }) : json(coaches)));
    vi.stubGlobal("fetch", fetchMock);
    const coached = { ...(session as object), coachId: 7, instructor: "Ana Lim" } as never;
    await act(async () => {
      render(<ClassEditor session={coached} onDone={() => {}} onClose={() => {}} />);
    });
    const select = await screen.findByLabelText("Taught by");
    await act(async () => {
      fireEvent.change(select, { target: { value: "" } });
    });
    fireEvent.change(screen.getByLabelText("Instructor"), { target: { value: "Guest Teacher" } });
    await act(async () => {
      fireEvent.click(screen.getByText("Save changes"));
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/classes/5", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ coachId: null, instructor: "Guest Teacher" }) }));
  });
});
