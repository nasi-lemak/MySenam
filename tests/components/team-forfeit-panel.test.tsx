// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import { TeamLeaguesPanel } from "../../src/components/admin/TeamLeaguesPanel";
import { StaffMayProvider } from "../../src/components/admin/StaffMay";
import { staffMay } from "../../src/lib/roles";
import type { ManagedVenue } from "../../src/components/admin/shared";

/**
 * The staff screen for forfeits in a league of teams (lib/team-forfeits.ts): a manager sees the forfeit buttons and a waiting request to
 * confirm or decline; the front desk sees neither the forfeit buttons nor the decision, only a way to ask a manager for one.
 */

const fixture = {
  id: 31,
  leg: 1,
  round: 1,
  nightNo: 1,
  date: "2026-12-05",
  startMin: 540,
  minutes: 135,
  courtId: 1,
  courtName: "Court 1",
  home: { id: 1, name: "Red Rackets" },
  away: { id: 2, name: "Blue Birds" },
  status: "scheduled",
  version: 4,
  forfeitBy: null,
  reportedBy: null,
  result: null,
  rubbers: [],
  forfeitRequests: [
    {
      id: 5,
      fixtureId: 31,
      forfeitTeam: { id: 2, name: "Blue Birds" },
      by: "Red Rackets",
      byKind: "captain",
      reason: "no_show",
      note: "Nobody here at 9:30",
      status: "open",
      createdAt: "",
      expiresAt: "",
      decidedBy: null,
      decidedAt: null,
      decisionNote: null,
      closedReason: null,
      mine: false,
    },
  ],
};
const league = {
  id: 7,
  venueId: 1,
  name: "Premier",
  sport: "badminton",
  status: "scheduled",
  legs: 1,
  startsOn: "2026-12-01",
  endsOn: "2027-02-01",
  rules: { scoring: { kind: "sets", bestOf: 3 } },
  rubbers: ["singles"],
  rubberMinutes: 45,
  courts: [{ id: 1, name: "Court 1" }],
  nights: [],
  teams: 2,
  entered: [],
  fixtures: [fixture],
  standings: [],
};

const sent: { url: string; method: string; body: unknown }[] = [];
beforeEach(() => {
  sent.length = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const method = init?.method ?? "GET";
      if (method !== "GET") sent.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined });
      if (url.startsWith("/api/admin/team-leagues?")) return { ok: true, json: async () => ({ leagues: [league], templates: [], courts: [] }) };
      return { ok: true, json: async () => ({ league }) };
    })
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const venue = { id: 1, name: "Arena", timeZone: "Asia/Kuala_Lumpur", courts: [] } as unknown as ManagedVenue;

async function open(role: "manager" | "desk") {
  render(

      <StaffMayProvider may={staffMay(role)}>
        <TeamLeaguesPanel venue={venue} />
      </StaffMayProvider>

  );
  fireEvent.click(screen.getByText("Leagues of teams"));
  await act(async () => {});
  fireEvent.click(await screen.findByRole("button", { name: "Open" }));
  await act(async () => {});
}

describe("forfeits on the staff screen", () => {
  it("shows a manager the forfeit buttons and the waiting request, and gives a forfeit through the forfeit address", async () => {
    await open("manager");
    expect(screen.getByText(/Forfeit requested by Red Rackets: Blue Birds to forfeit/)).toBeTruthy();
    expect(screen.getByText(/Nobody here at 9:30/)).toBeTruthy();
    expect(screen.queryByText("Ask for a forfeit")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Forfeit by Blue Birds" }));
    await act(async () => {});
    expect(sent.at(-1)).toEqual({ url: "/api/admin/team-leagues/7/fixtures/31/forfeit", method: "POST", body: { forfeitBy: 2, version: 4 } });
    fireEvent.click(screen.getByRole("button", { name: "Confirm the forfeit" }));
    await act(async () => {});
    expect(sent.at(-1)).toEqual({ url: "/api/admin/team-leagues/7/forfeit-requests/5", method: "POST", body: { confirm: true, version: 4 } });
    fireEvent.click(screen.getByRole("button", { name: "Decline…" }));
    fireEvent.change(screen.getByLabelText("Why it is declined"), { target: { value: "They are on their way" } });
    fireEvent.click(screen.getByRole("button", { name: "Decline the request" }));
    await act(async () => {});
    expect(sent.at(-1)).toEqual({ url: "/api/admin/team-leagues/7/forfeit-requests/5", method: "POST", body: { decline: true, reason: "They are on their way" } });
  });

  it("shows the front desk no forfeit button and no decision, only the request and a way to ask a manager", async () => {
    await open("desk");
    expect(screen.getByText(/Forfeit requested by Red Rackets: Blue Birds to forfeit/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Forfeit by Blue Birds" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Forfeit by Red Rackets" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Confirm the forfeit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Decline…" })).toBeNull();
    expect(screen.getByText("A manager gives forfeits. You can ask for one.")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Ask for a forfeit" }));
    fireEvent.change(screen.getByLabelText("Reason"), { target: { value: "told_us" } });
    fireEvent.click(screen.getByRole("button", { name: "Send the request" }));
    await act(async () => {});
    expect(sent.at(-1)).toEqual({ url: "/api/admin/team-leagues/7/fixtures/31/forfeit-requests", method: "POST", body: { forfeitTeam: 1, reason: "told_us", note: "" } });
    // The result form is still the desk's.
    expect(screen.getByRole("button", { name: "Enter the result" })).toBeTruthy();
  });
});
