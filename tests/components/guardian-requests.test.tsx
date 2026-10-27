// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import ManagedPeople from "../../src/components/ManagedPeople";
import { ParticipantsPanel } from "../../src/components/admin/ParticipantsPanel";
import { LanguageProvider } from "../../src/components/Language";

/**
 * Guardian requests on screen (lib/guardian-requests.ts;
 * docs/features/booking.md#booking-for-somebody-else): an existing
 * guardian answers another adult's request and reports a change as a
 * mistake from their people page; the adult whose request waits sees that
 * it is pending and nothing else; a manager sees requests waiting, records
 * the narrow exception, and pauses or keeps a flagged guardian.
 */

let calls: { url: string; method: string; body: Record<string, unknown> | null }[];

function stub(routes: Record<string, unknown>) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const u = new URL(String(url), "http://localhost");
      calls.push({ url: u.pathname + u.search, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : null });
      const key = Object.keys(routes).find((k) => u.pathname === k || `${u.pathname}${u.search}`.startsWith(k));
      return { ok: true, status: 200, json: async () => (key ? routes[key] : { ok: true }) };
    })
  );
}

beforeEach(() => {
  vi.stubGlobal("prompt", vi.fn(() => "Not somebody we know"));
});
afterEach(() => vi.unstubAllGlobals());

const PERSON = { id: 41, displayName: "Irfan", birthYear: 2016, relationship: "parent", authorityDeclaredAt: "", createdAt: "", archivedAt: null, otherGuardians: 1, linked: false };

describe("the people page", () => {
  it("asks an existing guardian to agree or refuse, and lets them report a change as a mistake", async () => {
    stub({
      "/api/my/people": {
        people: [PERSON],
        own: null,
        requests: {
          toAnswer: [{ id: 9, participantId: 41, displayName: "Irfan", proposedName: "Encik Rahman", relationship: "parent", startedBy: "Dewi Desk", venueName: "Guardian Centre", acceptedAt: "" }],
          pending: [],
          paused: [],
          changes: [{ participantId: 41, guardianshipId: 77, kind: "added", at: "2026-10-27T03:00:00.000Z", reported: false }],
        },
      },
    });
    render(
      <LanguageProvider locale="en">
        <ManagedPeople />
      </LanguageProvider>
    );
    await act(async () => {});
    expect(screen.getByText("Waiting for your answer")).toBeTruthy();
    expect(screen.getByText(/Encik Rahman asked to become Irfan's guardian, as their parent\./)).toBeTruthy();
    expect(screen.getByText(/Started by Dewi Desk at Guardian Centre\./)).toBeTruthy();
    await act(async () => void fireEvent.click(screen.getByText("Agree")));
    expect(calls.find((c) => c.method === "POST")).toEqual({ url: "/api/my/people/requests", method: "POST", body: { id: 9, agree: true } });
    await act(async () => void fireEvent.click(screen.getByText("Refuse")));
    expect(calls.filter((c) => c.method === "POST").at(-1)).toEqual({ url: "/api/my/people/requests", method: "POST", body: { id: 9, agree: false, reason: "Not somebody we know" } });
    expect(screen.getByText(/Another guardian was added on/)).toBeTruthy();
    await act(async () => void fireEvent.click(screen.getByText("Report a mistake")));
    expect(calls.filter((c) => c.method === "POST").at(-1)).toEqual({
      url: "/api/my/people/report",
      method: "POST",
      body: { id: 41, guardianshipId: 77, note: "Not somebody we know" },
    });
  });

  it("tells the adult whose request waits that it is pending, and shows nothing of the child beyond the name", async () => {
    stub({
      "/api/my/people": { people: [], own: null, requests: { toAnswer: [], pending: [{ id: 3, displayName: "Irfan", since: "" }], paused: [{ displayName: "Aisha", since: "" }], changes: [] } },
    });
    render(
      <LanguageProvider locale="en">
        <ManagedPeople />
      </LanguageProvider>
    );
    await act(async () => {});
    expect(screen.getByText("Your request to act for Irfan is waiting for one of their guardians to agree, or for the venue.")).toBeTruthy();
    expect(screen.getByText(/Acting for Aisha is paused while the venue looks at it/)).toBeTruthy();
    expect(screen.queryByText("Share with another guardian")).toBeNull();
  });
});

describe("the manager's participants panel", () => {
  it("shows a request no guardian can agree to online, records the exception, and pauses a flagged guardian", async () => {
    const found = {
      participants: [
        {
          id: 41,
          displayName: "Irfan",
          birthYear: 2016,
          linked: false,
          inductionId: null,
          guardians: [{ id: 5, name: "Encik Lim", relationship: "parent", provenance: "counter", account: false, suspended: false, review: "counter-shortcut", reviewNote: null }],
          requests: [
            {
              id: 9,
              status: "awaiting_consent",
              initiatedAs: "staff",
              initiatedBy: "Dewi Desk",
              proposedName: "Encik Rahman",
              acceptedName: "Encik Rahman",
              relationship: "parent",
              consentPossible: false,
              exception: null,
              createdAt: "",
            },
          ],
        },
      ],
    };
    stub({ "/api/admin/participants?": found, "/api/admin/participants/41": { ok: true, active: true } });
    render(<ParticipantsPanel venues={[{ id: 3, name: "Guardian Centre" } as never]} />);
    await act(async () => void fireEvent.click(screen.getByText("Show what needs review")));
    expect(calls[0].url).toBe("/api/admin/participants?venueId=3&review=1");
    expect(screen.getByText(/added at the counter before invitations were required/)).toBeTruthy();
    expect(screen.getByText(/Encik Rahman accepted on their own account \(declared parent\); waiting for an existing guardian's agreement/)).toBeTruthy();
    expect(screen.getByText("No guardian on record can agree online.")).toBeTruthy();

    await act(async () => void fireEvent.click(screen.getByText("Record an exception")));
    const box = screen.getByText("Record the exception").closest("div")!.parentElement!;
    await act(async () => void fireEvent.change(within(box).getByLabelText("Why"), { target: { value: "custody_dispute" } }));
    await act(async () => void fireEvent.change(within(box).getByLabelText("In a few words (kept on record)"), { target: { value: "Court order seen at the desk" } }));
    await act(async () => void fireEvent.change(within(box).getByLabelText(/Look at it again by/), { target: { value: "2026-12-01" } }));
    await act(async () => void fireEvent.click(within(box).getByText("Record the exception")));
    expect(calls.find((c) => c.method === "PATCH")).toEqual({
      url: "/api/admin/participants/41",
      method: "PATCH",
      body: { venueId: 3, action: "exception", requestId: 9, category: "custody_dispute", reason: "Court order seen at the desk", reviewOn: "2026-12-01", suppressNotice: false },
    });

    await act(async () => void fireEvent.click(screen.getByText("Pause")));
    expect(calls.filter((c) => c.method === "PATCH").at(-1)?.body).toEqual({ venueId: 3, action: "suspendGuardian", guardianId: 5, reason: "Not somebody we know" });
  });
});
