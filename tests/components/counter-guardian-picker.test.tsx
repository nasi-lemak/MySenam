// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { ParticipantPicker } from "../../src/components/admin/ParticipantPicker";

/**
 * "An adult not on record asks to become a guardian" at the counter
 * (components/admin/ParticipantPicker.tsx;
 * docs/features/venue-operations.md#another-guardian-by-invitation): the
 * child the venue knows is found by a recorded guardian's number, and the
 * adult typed for the booking is given an invitation code for their own
 * account. Nothing is granted: the child is not chosen for the booking, and
 * the adult's number finds nobody until an existing guardian agrees.
 */

const MUM = "0123000001";
const DAD = "0123000002";
const IRFAN = {
  id: 41,
  displayName: "Irfan",
  birthYear: 2016,
  linked: false,
  guardians: [{ id: 1, name: "Puan Aminah", relationship: "parent", provenance: "counter", account: false, suspended: false, review: null, reviewNote: null }],
  inductionId: null,
  requests: [],
};

let posts: { url: string; body: Record<string, unknown> }[];

beforeEach(() => {
  posts = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const u = new URL(String(url), "http://localhost");
      if (init?.method === "POST") {
        const body = JSON.parse(init.body!);
        posts.push({ url: u.pathname, body });
        return {
          ok: true,
          status: 201,
          json: async () => ({ request: { id: 7, code: "ABCDE-FGHJK", expiresAt: "2026-11-03T00:00:00.000Z", consentPossible: false } }),
        };
      }
      const phone = u.searchParams.get("phone");
      return { ok: true, status: 200, json: async () => ({ participants: phone === MUM ? [IRFAN] : [] }) };
    })
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("inviting the adult at the counter to become a guardian of a child the venue knows", () => {
  it("finds the child by the other guardian's number, makes a code for the adult's own account, and chooses nobody", async () => {
    const changes: { values: { id: number }[] }[] = [];
    render(
      <ParticipantPicker
        venueId={3}
        phone={DAD}
        guardianName="Encik Rahman"
        many={{ values: [], holderTakesPart: false, onChange: (values) => changes.push({ values }) }}
      />
    );
    await act(async () => void fireEvent.click(screen.getByText("For somebody on this number (a child)?")));
    expect(screen.getByText("Nobody this venue knows on this number.")).toBeTruthy();
    await act(async () => void fireEvent.click(screen.getByText("An adult not on record asks to become a guardian of a child we know?")));
    const box = screen.getByTestId("add-guardian");
    expect(within(box).getByText(/Encik Rahman then gets a code to accept signed in to their own MySenam account/)).toBeTruthy();
    await act(async () => void fireEvent.change(within(box).getByLabelText("A recorded guardian's number"), { target: { value: MUM } }));
    await act(async () => void fireEvent.click(within(box).getByText("Find")));
    await act(async () => void fireEvent.click(within(box).getByLabelText(/Irfan/)));
    // No declaration typed in by staff: the adult declares on their own account.
    expect(within(box).queryByRole("checkbox")).toBeNull();
    await act(async () =>
      void fireEvent.change(within(box).getByLabelText(/Email of Encik Rahman's MySenam account/), { target: { value: "rahman@example.my" } })
    );
    await act(async () => void fireEvent.click(within(box).getByText("Make an invitation code for Encik Rahman")));
    expect(posts.at(-1)).toEqual({ url: "/api/admin/participants/41/guardians", body: { venueId: 3, proposedName: "Encik Rahman", email: "rahman@example.my" } });
    const shown = within(box).getByRole("status");
    expect(shown.textContent).toContain("ABCDE-FGHJK");
    expect(shown.textContent).toContain("cannot book for Irfan");
    expect(shown.textContent).toContain("a manager has to record an exception");
    // Nothing granted: the child is not chosen for the booking.
    expect(changes).toHaveLength(0);
  });

  it("asks for the adult's name and number first", async () => {
    render(<ParticipantPicker venueId={3} phone={DAD} guardianName="" />);
    await act(async () => void fireEvent.click(screen.getByText("For somebody on this number (a child)?")));
    await act(async () => void fireEvent.click(screen.getByText("An adult not on record asks to become a guardian of a child we know?")));
    expect(screen.getByText("Type the adult's name and number above first.")).toBeTruthy();
  });
});
