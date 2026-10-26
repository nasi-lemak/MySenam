// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, within } from "@testing-library/react";

import { ParticipantPicker } from "../../src/components/admin/ParticipantPicker";

/**
 * "Add this adult as a guardian" at the counter (components/admin/ParticipantPicker.tsx;
 * docs/features/venue-operations.md#a-second-guardian-at-the-counter): the
 * child the venue knows is found by a recorded guardian's number, the adult
 * typed for the booking declares their relationship and authority, and the
 * same child (no new one) is then chosen for the booking.
 */

const MUM = "0123000001";
const DAD = "0123000002";
const IRFAN = { id: 41, displayName: "Irfan", birthYear: 2016, linked: false, guardians: [{ id: 1, name: "Puan Aminah", relationship: "parent", provenance: "counter", account: false }], inductionId: null };

let dadIsGuardian = false;
let posts: { url: string; body: Record<string, unknown> }[];

beforeEach(() => {
  dadIsGuardian = false;
  posts = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
      const u = new URL(String(url), "http://localhost");
      if (init?.method === "POST") {
        const body = JSON.parse(init.body!);
        posts.push({ url: u.pathname, body });
        if (body.authority !== true) return { ok: false, status: 400, json: async () => ({ error: "Confirm the guardian declared to you that they are the parent, legal guardian or another person with authority to act for them.", code: "PTC_COUNTER_AUTHORITY" }) };
        dadIsGuardian = true;
        return { ok: true, status: 201, json: async () => ({ ok: true, guardianId: 2 }) };
      }
      const phone = u.searchParams.get("phone");
      const found = phone === MUM || (phone === DAD && dadIsGuardian) ? [IRFAN] : [];
      return { ok: true, status: 200, json: async () => ({ participants: found }) };
    })
  );
});
afterEach(() => vi.unstubAllGlobals());

describe("adding the adult at the counter as a guardian of a child the venue knows", () => {
  it("finds the child by the other guardian's number, records the declaration, and picks the same child", async () => {
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
    // Nobody on the father's number yet.
    expect(screen.getByText("Nobody this venue knows on this number.")).toBeTruthy();
    await act(async () => void fireEvent.click(screen.getByText("A child we know, whose guardian on record has another number?")));
    const box = screen.getByTestId("add-guardian");
    expect(within(box).getByText(/Encik Rahman is not on record as their guardian/)).toBeTruthy();
    await act(async () => void fireEvent.change(within(box).getByLabelText("A recorded guardian's number"), { target: { value: MUM } }));
    await act(async () => void fireEvent.click(within(box).getByText("Find")));
    await act(async () => void fireEvent.click(within(box).getByLabelText(/Irfan/)));
    expect((within(box).getByLabelText("The guardian is their") as HTMLSelectElement).value).toBe("parent");

    // Without the declaration: refused, said, nothing chosen.
    await act(async () => void fireEvent.click(within(box).getByText("Add Encik Rahman as their guardian")));
    expect(screen.getByText(/Confirm the guardian declared to you/)).toBeTruthy();
    expect(changes).toHaveLength(0);

    await act(async () =>
      void fireEvent.click(within(box).getByLabelText("Encik Rahman told me they are Irfan's parent, legal guardian or another person with authority to act for them."))
    );
    await act(async () => void fireEvent.click(within(box).getByText("Add Encik Rahman as their guardian")));
    expect(posts.at(-1)).toEqual({
      url: "/api/admin/participants/41/guardians",
      body: { venueId: 3, guardianName: "Encik Rahman", guardianPhone: DAD, relationship: "parent", authority: true },
    });
    // The same child, now on the father's number, chosen for the booking.
    expect(changes.at(-1)!.values.map((v) => v.id)).toEqual([41]);
    expect(screen.queryByTestId("add-guardian")).toBeNull();
    expect(screen.getByText("Irfan")).toBeTruthy();
  });

  it("asks for the adult's name and number first", async () => {
    render(<ParticipantPicker venueId={3} phone={DAD} guardianName="" />);
    await act(async () => void fireEvent.click(screen.getByText("For somebody on this number (a child)?")));
    await act(async () => void fireEvent.click(screen.getByText("A child we know, whose guardian on record has another number?")));
    expect(screen.getByText("Type the adult's name and number above first.")).toBeTruthy();
  });
});
