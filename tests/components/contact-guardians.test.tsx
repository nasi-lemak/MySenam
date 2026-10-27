// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import ManagedPeople from "../../src/components/ManagedPeople";
import { AttentionPanel } from "../../src/components/admin/AttentionPanel";
import { ParticipantsPanel } from "../../src/components/admin/ParticipantsPanel";
import { LanguageProvider } from "../../src/components/Language";

/**
 * Guardians recorded by name and number on screen (lib/contact-guardians.ts):
 * front desk sends a code to the number recorded for one and enters it as
 * they read it back, and gives them a code to take the relationship over;
 * the manager's own corrections stay a manager's; without phone messaging a
 * manager records an agreement given in person; Needs attention lists who is
 * still to be told; a guardian with an account gives a code to one recorded
 * at a venue.
 */

let calls: { url: string; method: string; body: Record<string, unknown> | null }[];

function stub(routes: Record<string, unknown>) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const u = new URL(String(url), "http://localhost");
      calls.push({ url: u.pathname + u.search, method: init?.method ?? "GET", body: init?.body ? JSON.parse(init.body) : null });
      const key = Object.keys(routes).find((k) => `${init?.method ?? "GET"} ${u.pathname}${u.search}`.startsWith(k) || u.pathname === k || `${u.pathname}${u.search}`.startsWith(k));
      return { ok: true, status: 200, json: async () => (key ? routes[key] : { ok: true }) };
    })
  );
}

beforeEach(() => {
  vi.stubGlobal("prompt", vi.fn(() => "Mother here in person, no SMS"));
});
afterEach(() => vi.unstubAllGlobals());

const CHILD = (codesPossible = true) => ({
  codesPossible,
  participants: [
    {
      id: 41,
      displayName: "Alya",
      birthYear: 2016,
      linked: false,
      inductionId: null,
      guardians: [
        { id: 5, name: "Puan Aminah", relationship: "parent", provenance: "counter", account: false, suspended: false, review: null, reviewNote: null, contactVerified: false, claimed: false },
      ],
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
          contactConsent: true,
          agreed: null,
          exception: null,
          createdAt: "",
        },
      ],
      noticeTasks: [{ id: 3, guardianName: "Puan Aminah", change: "request", why: "unverified_number" }],
    },
  ],
});

async function find() {
  await act(async () => void fireEvent.change(screen.getByLabelText("Guardian's phone number"), { target: { value: "0177000001" } }));
  await act(async () => void fireEvent.click(screen.getByText("Look up")));
}

describe("the participants panel at the front desk", () => {
  it("sends a code to the recorded guardian's number, enters it, and gives a code to take the relationship over; no manager's actions", async () => {
    stub({ "/api/admin/participants?": CHILD(), "/api/admin/participants/41/contact-guardians": { ok: true, expiresAt: "2026-10-27T10:00:00.000Z", channel: "sms", code: "ABCDE-FGHJK" } });
    render(<ParticipantsPanel venues={[{ id: 3, name: "Guardian Centre" } as never]} role="desk" />);
    expect(screen.queryByText("Show what needs review")).toBeNull();
    await find();
    expect(screen.queryByText("Pause")).toBeNull();
    expect(screen.queryByText("Revoke")).toBeNull();
    expect(screen.queryByText("Record an exception")).toBeNull();
    expect(screen.getByText("number not checked")).toBeTruthy();
    expect(screen.getByText(/Not yet told: Puan Aminah/)).toBeTruthy();

    await act(async () => void fireEvent.click(screen.getByText("Ask Puan Aminah to agree: send a code to their number")));
    expect(calls.find((c) => c.method === "POST")).toEqual({
      url: "/api/admin/participants/41/contact-guardians",
      method: "POST",
      body: { venueId: 3, action: "sendCode", guardianId: 5, purpose: "agree", requestId: 9 },
    });
    await act(async () => void fireEvent.change(screen.getByLabelText("The code they read out"), { target: { value: "123456" } }));
    await act(async () => void fireEvent.click(screen.getByText("Enter the code")));
    expect(calls.filter((c) => c.method === "POST").at(-1)!.body).toEqual({ venueId: 3, action: "confirmCode", guardianId: 5, purpose: "agree", code: "123456", requestId: 9 });

    await act(async () => void fireEvent.click(screen.getByText("Code to take it over with an account")));
    expect(calls.filter((c) => c.method === "POST").at(-1)!.body).toEqual({ venueId: 3, action: "claimCode", guardianId: 5 });
    expect(screen.getByText(/Give Puan Aminah this code, shown only now: ABCDE-FGHJK/)).toBeTruthy();

    await act(async () => void fireEvent.click(screen.getByText("I have told them")));
    expect(calls.filter((c) => c.method === "POST").at(-1)).toEqual({ url: "/api/admin/attention", method: "POST", body: { action: "guardianTold", taskId: 3, how: "told" } });
  });

  it("without phone messaging, a manager records the agreement given in person, with a reason", async () => {
    stub({ "/api/admin/participants?": CHILD(false) });
    render(<ParticipantsPanel venues={[{ id: 3, name: "Guardian Centre" } as never]} role="manager" />);
    await find();
    expect(screen.getByText(/no code can be sent/)).toBeTruthy();
    expect(screen.queryByText("Ask Puan Aminah to agree: send a code to their number")).toBeNull();
    await act(async () => void fireEvent.click(screen.getByText("Record Puan Aminah's agreement given in person")));
    expect(calls.filter((c) => c.method === "POST").at(-1)!.body).toEqual({
      venueId: 3,
      action: "inPerson",
      guardianId: 5,
      requestId: 9,
      reason: "Mother here in person, no SMS",
    });
  });
});

describe("needs attention", () => {
  it("lists guardians still to be told, and a manager's reviews waiting", async () => {
    stub({
      "GET /api/admin/attention": {
        open: [],
        recent: [],
        refundsOverdue: [],
        guardianTasks: [{ id: 7, participantId: 41, displayName: "Alya", guardianName: "Puan Aminah", phone: "0177000001", venueId: 3, venueName: "Guardian Centre", change: "added", why: "unverified_number", createdAt: "" }],
        guardianReviews: [{ venueId: 3, venueName: "Guardian Centre", waiting: 2, datesDue: 1 }],
      },
      "POST /api/admin/attention": { guardianTasks: [] },
    });
    render(<AttentionPanel />);
    await act(async () => {});
    expect(screen.getByText(/Tell Puan Aminah, a guardian of Alya recorded by name and number: another guardian was added/)).toBeTruthy();
    expect(screen.getByText(/Guardian Centre: 2 to look at, 1 exception review dates come/)).toBeTruthy();
    await act(async () => void fireEvent.click(screen.getByText("I have told them")));
    expect(calls.filter((c) => c.method === "POST").at(-1)!.body).toEqual({ taskId: 7, action: "guardianTold", how: "told" });
    expect(screen.queryByText(/Tell Puan Aminah/)).toBeNull();
  });

  it("says when a WhatsApp notice did not reach the guardian", async () => {
    stub({
      "GET /api/admin/attention": {
        open: [],
        recent: [],
        refundsOverdue: [],
        guardianTasks: [{ id: 8, participantId: 42, displayName: "Bunga", guardianName: "Puan Rosnah", phone: "0177000002", venueId: 3, venueName: "Guardian Centre", change: "request", why: "not_delivered", createdAt: "" }],
        guardianReviews: [],
      },
    });
    render(<AttentionPanel />);
    await act(async () => {});
    expect(screen.getByText(/Tell Puan Rosnah, a guardian of Bunga recorded by name and number/)).toBeTruthy();
    expect(screen.getByText(/the WhatsApp notice did not reach them/)).toBeTruthy();
  });
});

describe("the people page", () => {
  it("gives a code to a guardian a venue recorded, and says when a code took a relationship over", async () => {
    stub({
      "GET /api/my/people": {
        people: [{ id: 41, displayName: "Alya", birthYear: 2016, relationship: "parent", authorityDeclaredAt: "", createdAt: "", archivedAt: null, otherGuardians: 1, linked: false, recordedGuardians: 1 }],
        own: null,
        requests: { toAnswer: [], pending: [], paused: [], changes: [] },
      },
      "POST /api/my/people/invites": { code: "ABCDE-FGHJK", expiresAt: "2026-11-03T00:00:00.000Z" },
      "POST /api/my/people/accept": { as: "claimed", person: { id: 41, displayName: "Alya" } },
    });
    render(
      <LanguageProvider locale="en">
        <ManagedPeople />
      </LanguageProvider>
    );
    await act(async () => {});
    await act(async () => void fireEvent.click(screen.getByText("Code for a guardian a venue recorded")));
    expect(calls.find((c) => c.method === "POST")).toEqual({ url: "/api/my/people/invites", method: "POST", body: { id: 41, purpose: "claim" } });
    expect(screen.getByText(/A code for Alya's guardian recorded at a venue: ABCDE-FGHJK/)).toBeTruthy();
    expect(screen.getByText(/Prove that number on this account first/)).toBeTruthy();
  });
});
