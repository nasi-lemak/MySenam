// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { ClassEditor } from "../../src/components/admin/ClassEditor";
import { TournamentDetailsEditor } from "../../src/components/admin/TournamentDetailsEditor";
import { BookingAlertsEditor } from "../../src/components/admin/BookingAlertsEditor";

/**
 * The staff screens for changing a class or a tournament after it is set up
 * (X1-12), and for hearing about customers' online cancellations and changes
 * (X1-11): each sends only what was changed, and says what happened.
 */

afterEach(() => vi.unstubAllGlobals());

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("changing a class", () => {
  const session = {
    id: 5, courtId: 2, courtName: "Studio", venueId: 1, venueName: "V", venueArea: "A", sport: "gym", name: "Yoga", instructor: "Mei",
    date: "2026-11-20", startMin: 1140, endMin: 1200, startHour: 19, endHour: 20, capacity: 8, price: 25, status: "scheduled",
    seriesCode: "CL-ABCDEF", enrolled: 6, who: "anyone",
  } as never;

  it("sends only the places and the series, and says a place went to the waiting list", async () => {
    const fetchMock = vi.fn(async () => json({ classes: [{}, {}], offered: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    const done = vi.fn();
    render(<ClassEditor session={session} onDone={done} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText(/^Places/), { target: { value: "10" } });
    fireEvent.click(screen.getByLabelText(/Also every later session/));
    await act(async () => {
      fireEvent.click(screen.getByText("Save changes"));
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/classes/5", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ capacity: 10, series: true }) }));
    expect(done).toHaveBeenCalledWith("Changed 2 sessions. The first person waiting has been offered a place.");
    // It tells staff who enrolled keeps their price.
    expect(screen.getByText(/keeps the price they enrolled at/)).toBeTruthy();
  });

  it("shows the server's refusal", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => json({ error: "Capacity must be at least 1." }, 409)));
    render(<ClassEditor session={session} onDone={() => {}} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText(/^Places/), { target: { value: "3" } });
    await act(async () => {
      fireEvent.click(screen.getByText("Save changes"));
    });
    expect(screen.getByText("Capacity must be at least 1.")).toBeTruthy();
  });
});

describe("changing a tournament's details", () => {
  const tn = { id: 9, name: "Club Open", description: null, entriesCloseOn: null, maxEntries: 8, entryFee: 20, startsOn: "2026-12-01", entered: 8 } as never;

  it("sends the fee and places changed, and says who came off the waiting list", async () => {
    const fetchMock = vi.fn(async () => json({ tournament: { id: 9 }, promoted: 2 }));
    vi.stubGlobal("fetch", fetchMock);
    const saved = vi.fn();
    render(<TournamentDetailsEditor tn={tn} onSaved={saved} onClose={() => {}} />);
    fireEvent.change(screen.getByLabelText(/Most entries/), { target: { value: "10" } });
    fireEvent.change(screen.getByLabelText(/Entry fee for new entries/), { target: { value: "25" } });
    await act(async () => {
      fireEvent.click(screen.getByText("Save changes"));
    });
    expect(fetchMock).toHaveBeenCalledWith("/api/admin/tournaments/9", expect.objectContaining({ method: "PATCH", body: JSON.stringify({ maxEntries: 10, entryFee: 25 }) }));
    expect(saved).toHaveBeenCalledWith({ id: 9 }, "Saved. 2 entries came in off the waiting list.");
  });
});

describe("alerts for online cancellations and changes", () => {
  it("are offered beside new-booking alerts and saved with how far ahead", async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? json({ alerts: { email: "desk@arena.my", phone: null }, changes: { cancellations: true, changes: false, withinHours: 48 } })
        : json({ alerts: { email: "desk@arena.my", phone: null }, changes: { cancellations: false, changes: false, withinHours: 24 } })
    );
    vi.stubGlobal("fetch", fetchMock);
    await act(async () => {
      render(<BookingAlertsEditor venueId={3} />);
    });
    // The window is asked only once something is ticked.
    expect(screen.queryByText(/For bookings starting within/)).toBeNull();
    fireEvent.click(screen.getByLabelText("cancels a booking"));
    fireEvent.change(screen.getByLabelText(/For bookings starting within/), { target: { value: "48" } });
    await act(async () => {
      fireEvent.click(screen.getByText("Save"));
    });
    const posted = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "POST")!;
    expect(JSON.parse(String((posted[1] as RequestInit).body))).toEqual({
      venueId: 3, email: "desk@arena.my", phone: "", cancellations: true, changes: false, withinHours: 48,
    });
  });
});
