// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import JoinMembership from "../../src/components/JoinMembership";
import type { MembershipPlan } from "../../src/lib/membership-plans";

/** The membership box on a venue page, where its gateway can renew by itself. */

const plans = [{ id: 7, venueId: 1, name: "Quarterly", months: 3, price: 120 }] as MembershipPlan[];

afterEach(() => vi.restoreAllMocks());

describe("joining", () => {
  it("offers renewing automatically only where the gateway can, and sends the choice", async () => {
    const { rerender } = render(<JoinMembership venueId={1} plans={plans} standing={{ kind: "join" }} />);
    expect(screen.queryByRole("checkbox")).toBeNull();

    rerender(<JoinMembership venueId={1} plans={plans} standing={{ kind: "join" }} canAutoRenew />);
    const box = screen.getByRole("checkbox");
    expect((box as HTMLInputElement).checked).toBe(false);
    fireEvent.click(box);

    // Choosing a plan shows its price and dates first; paying sends the choice.
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ price: 120, startsOn: "2026-10-27", expiresOn: "2027-01-26", renewing: false, holder: null, covers: [] }))
      .mockResolvedValue(Response.json({ error: "stop here" }, { status: 409 }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Join/ }));
    });
    expect(fetch.mock.calls[0][0]).toBe("/api/my/membership/quote");
    expect(screen.getByText(/Quarterly for Me: from 2026-10-27 to 2027-01-26/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Pay/ }));
    });
    expect(fetch.mock.calls[1][0]).toBe("/api/my/membership");
    expect(JSON.parse(String((fetch.mock.calls[1][1] as RequestInit).body))).toEqual({ planId: 7, autoRenew: true });
    expect(screen.getByText("stop here")).toBeTruthy();
  });
});

describe("a membership that renews itself", () => {
  it("says when, and stops on request", async () => {
    render(
      <JoinMembership
        venueId={1}
        plans={plans}
        standing={{ kind: "early", until: "2027-01-20", from: "2026-12-06" }}
        canAutoRenew
        renewal={{ id: 3, venueId: 1, planId: 7, until: "2027-01-20" }}
      />
    );
    expect(screen.getByText(/Renews by itself when this membership ends on 2027-01-20/)).toBeTruthy();
    expect(screen.queryByRole("checkbox")).toBeNull();
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ ok: true }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Stop renewing" }));
    });
    expect(fetch.mock.calls[0][0]).toBe("/api/my/membership?renewal=3");
    expect((fetch.mock.calls[0][1] as RequestInit).method).toBe("DELETE");
    expect(screen.getByText(/Nothing more will be charged/)).toBeTruthy();
  });
});

/** Buying for somebody the account looks after, or a family (lib/membership-purchases.ts). */
const forPeople = [
  { id: 7, venueId: 1, name: "Swimmer", months: 3, price: 120, ratePercent: null, aheadDays: null, scope: "participant", offeredFor: "individual", familyLimit: null },
  { id: 8, venueId: 1, name: "Family", months: 12, price: 300, ratePercent: null, aheadDays: null, scope: "booking", offeredFor: "family", familyLimit: 2 },
] as MembershipPlan[];
const people = [
  { id: 41, name: "Alya" },
  { id: 42, name: "Bilal" },
  { id: 43, name: "Chen" },
];

describe("buying for somebody looked after", () => {
  it("asks whom it is for, shows the price and dates for them, and pays for them", async () => {
    render(<JoinMembership venueId={1} plans={forPeople} standing={{ kind: "join" }} people={people} />);
    expect(screen.getByText("For you, or somebody you look after")).toBeTruthy();
    expect(screen.getByText("Family: you and up to 2 people you look after")).toBeTruthy();
    const fetch = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(Response.json({ price: 120, startsOn: "2026-10-27", expiresOn: "2027-01-26", renewing: false, holder: { id: 42, name: "Bilal" }, covers: [] }))
      .mockResolvedValue(Response.json({ error: "stop here" }, { status: 409 }));
    fireEvent.click(screen.getAllByRole("button", { name: /Join/ })[0]);
    // Nothing is asked of the server until somebody is chosen and the price asked for.
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("radio", { name: "Bilal" }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "See the price and dates" }));
    });
    expect(JSON.parse(String((fetch.mock.calls[0][1] as RequestInit).body))).toEqual({ planId: 7, participantId: 42 });
    expect(screen.getByText("Swimmer for Bilal: from 2026-10-27 to 2027-01-26.")).toBeTruthy();
    expect(screen.getByText(/starts only once the payment is confirmed/)).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Pay/ }));
    });
    expect(JSON.parse(String((fetch.mock.calls[1][1] as RequestInit).body))).toEqual({ planId: 7, participantId: 42, autoRenew: false });
  });

  it("a family plan lets no more be chosen than its limit, and sends whom it covers", async () => {
    render(<JoinMembership venueId={1} plans={forPeople} standing={{ kind: "join" }} people={people} />);
    fireEvent.click(screen.getAllByRole("button", { name: /Join/ })[1]);
    const quoteButton = screen.getByRole("button", { name: "See the price and dates" });
    expect((quoteButton as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Alya" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "Chen" }));
    expect((screen.getByRole("checkbox", { name: "Bilal" }) as HTMLInputElement).disabled).toBe(true);
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ price: 300, startsOn: "2026-10-27", expiresOn: "2027-10-26", renewing: true, holder: null, covers: [{ id: 41, name: "Alya" }, { id: 43, name: "Chen" }] })
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "See the price and dates" }));
    });
    expect(JSON.parse(String((fetch.mock.calls[0][1] as RequestInit).body))).toEqual({ planId: 8, covers: [41, 43] });
    expect(screen.getByText("Family for Me, Alya, Chen: from 2026-10-27 to 2027-10-26.")).toBeTruthy();
    expect(screen.getByText("It runs on from the membership held now.")).toBeTruthy();
  });

  it("says a refusal by its code, in the customer's words", async () => {
    render(<JoinMembership venueId={1} plans={forPeople} standing={{ kind: "join" }} people={people} />);
    fireEvent.click(screen.getAllByRole("button", { name: /Join/ })[0]);
    fireEvent.click(screen.getByRole("radio", { name: "Alya" }));
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({ error: "x", code: "MBO_ALREADY_COVERED", vars: { name: "Alya", until: "2027-01-01" } }, { status: 409 })
    );
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "See the price and dates" }));
    });
    expect(screen.getByText("Alya is already a member here until 2027-01-01.")).toBeTruthy();
  });

  it("with nobody looked after, says where to add them", () => {
    render(<JoinMembership venueId={1} plans={forPeople} standing={{ kind: "join" }} />);
    fireEvent.click(screen.getAllByRole("button", { name: /Join/ })[1]);
    expect(screen.getByText(/Nobody you look after can be chosen here/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "People you look after" }).getAttribute("href")).toBe("/account");
  });
});

describe("a family membership bought here", () => {
  it("adds and takes off whom it covers, within its limit, at the same price", async () => {
    render(
      <JoinMembership
        venueId={1}
        plans={forPeople}
        standing={{ kind: "renew", until: "2027-10-26" }}
        people={people}
        families={[{ id: 90, code: "MB-FAM", expiresOn: "2027-10-26", limit: 2, covers: [{ id: 41, name: "Alya" }] }]}
      />
    );
    expect(screen.getByText("Family membership MB-FAM, until 2027-10-26")).toBeTruthy();
    expect(screen.getByText(/nothing is charged for adding somebody/)).toBeTruthy();
    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ membership: { covers: [{ id: 41, name: "Alya" }, { id: 42, name: "Bilal" }] } }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Add Bilal" }));
    });
    expect(fetch.mock.calls[0][0]).toBe("/api/my/membership");
    expect((fetch.mock.calls[0][1] as RequestInit).method).toBe("PATCH");
    expect(JSON.parse(String((fetch.mock.calls[0][1] as RequestInit).body))).toEqual({ membershipId: 90, covers: [41, 42] });
    // Full now: nobody more to add.
    expect(screen.queryByRole("button", { name: "Add Chen" })).toBeNull();
    expect(screen.getByText("It covers as many people as its plan allows (2).")).toBeTruthy();
    fetch.mockResolvedValue(Response.json({ membership: { covers: [{ id: 42, name: "Bilal" }] } }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Take Alya off" }));
    });
    expect(JSON.parse(String((fetch.mock.calls[1][1] as RequestInit).body))).toEqual({ membershipId: 90, covers: [42] });
  });

  it("lists each membership renewing by itself, with whose it is", () => {
    render(
      <JoinMembership
        venueId={1}
        plans={forPeople}
        standing={{ kind: "join" }}
        people={people}
        renewals={[{ id: 5, venueId: 1, planId: 7, until: "2027-01-26", holderParticipantId: 42, holderName: "Bilal" }]}
      />
    );
    expect(screen.getByText(/Bilal's membership renews by itself when it ends on 2027-01-26/)).toBeTruthy();
    fireEvent.click(screen.getAllByRole("button", { name: /Join/ })[0]);
    // Bilal's renews already: not offered again.
    expect(screen.queryByRole("radio", { name: "Bilal" })).toBeNull();
    expect(screen.getByRole("radio", { name: "Alya" })).toBeTruthy();
  });
});
