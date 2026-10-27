// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { WaitlistJoin, WaitlistQueue } from "../../src/components/admin/WaitlistJoin";
import type { WaitlistEntry } from "../../src/lib/types";

/**
 * "Add to the waiting list" at the counter (components/admin/WaitlistJoin.tsx;
 * docs/features/booking.md#at-the-counter-and-through-the-api): from a taken
 * cell of the schedule or a full class, staff type the caller's name and
 * number and pick who it is for among the people the venue knows on that
 * number; the day's queues say who made each entry, and only an entry the
 * venue made can be taken off here.
 */

const MUM = "0123000077";
let sent: { url: string; method: string; body: Record<string, unknown> }[];

beforeEach(() => {
  sent = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const u = new URL(String(url), "http://localhost");
      if (init?.method && init.method !== "GET") {
        sent.push({ url: u.pathname, method: init.method, body: JSON.parse(init.body!) });
        return { ok: true, status: 201, json: async () => ({ entry: { id: 9 }, position: 2 }) };
      }
      if (u.pathname === "/api/admin/participants")
        return {
          ok: true,
          status: 200,
          json: async () => ({
            participants:
              u.searchParams.get("phone") === MUM
                ? [{ id: 41, displayName: "Irfan", birthYear: 2016, linked: false, guardians: [], inductionId: null, requests: [] }]
                : [],
          }),
        };
      return { ok: true, status: 200, json: async () => ({ entries: QUEUE }) };
    })
  );
  vi.stubGlobal("confirm", () => true);
});
afterEach(() => vi.unstubAllGlobals());

const entry = (id: number, madeBy: "customer" | "staff" | "api", name: string): WaitlistEntry => ({
  id,
  classId: null,
  courtId: 5,
  date: "2026-11-03",
  startMin: 18 * 60,
  endMin: 19 * 60,
  startHour: 18,
  endHour: 19,
  name,
  phone: "0123000000",
  status: "waiting",
  offeredAt: null,
  offerToken: null,
  locale: "en",
  createdAt: "2026-10-27 08:00:00",
  label: "Court 1 · 2026-11-03 6:00 PM",
  madeBy,
  madeByName: madeBy === "staff" ? "Dina Desk" : null,
});
const QUEUE = [entry(1, "customer", "Online Olivia"), entry(2, "staff", "Counter Carl"), entry(3, "api", "System Sam")];

describe("adding a caller to a waiting list at the counter", () => {
  it("sends the time, the caller and the people ticked, and says their place in the queue", async () => {
    const done = vi.fn();
    render(<WaitlistJoin venueId={3} target={{ courtId: 5, date: "2026-11-03", start: 18 * 60, end: 19 * 60 }} label="Court 1, 6:00 PM" onDone={done} onClose={() => {}} />);
    expect(screen.getByText("Waiting list for Court 1, 6:00 PM")).toBeTruthy();
    await act(async () => void fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Puan Aminah" } }));
    await act(async () => void fireEvent.change(screen.getByLabelText("Phone"), { target: { value: MUM } }));
    await act(async () => void fireEvent.click(screen.getByText("For somebody on this number (a child)?")));
    await act(async () => void fireEvent.click(screen.getByLabelText(/Irfan/)));
    await act(async () => void fireEvent.click(screen.getByText("Add them")));
    expect(sent).toEqual([
      {
        url: "/api/admin/waitlist",
        method: "POST",
        body: { venueId: 3, courtId: 5, date: "2026-11-03", start: 18 * 60, end: 19 * 60, name: "Puan Aminah", phone: MUM, participantIds: [41], customerTakesPart: false },
      },
    ]);
    expect(screen.getByText("Added: number 2 in the queue.")).toBeTruthy();
    expect(done).toHaveBeenCalledWith({ id: 9 }, 2);
  });

  it("a women-only class asks staff to say so, and sends what they said", async () => {
    render(<WaitlistJoin venueId={3} target={{ classId: 12, who: "women" }} label="Ladies' circuit" />);
    await act(async () => void fireEvent.click(screen.getByText("Add to the waiting list")));
    await act(async () => void fireEvent.change(screen.getByLabelText("Name"), { target: { value: "Puan Siti" } }));
    await act(async () => void fireEvent.change(screen.getByLabelText("Phone"), { target: { value: "0123000088" } }));
    await act(async () => void fireEvent.click(screen.getByLabelText("Women only: I confirm everybody this is for is a woman")));
    await act(async () => void fireEvent.click(screen.getByText("Add them")));
    expect(sent[0].body).toEqual({ venueId: 3, classId: 12, name: "Puan Siti", phone: "0123000088", confirmWho: true });
  });
});

describe("the day's queues", () => {
  it("say who made each entry; only those the venue made can be taken off", async () => {
    render(<WaitlistQueue venueId={3} date="2026-11-03" />);
    await act(async () => {});
    expect(screen.getByText("Waiting (3)")).toBeTruthy();
    expect(screen.getByText("Online")).toBeTruthy();
    expect(screen.getByText("At the counter (Dina Desk)")).toBeTruthy();
    expect(screen.getByText("Through the API")).toBeTruthy();
    const removes = screen.getAllByText("Remove");
    expect(removes).toHaveLength(2);
    await act(async () => void fireEvent.click(removes[0]));
    expect(sent).toEqual([{ url: "/api/admin/waitlist", method: "DELETE", body: { venueId: 3, entryId: 2 } }]);
  });
});
