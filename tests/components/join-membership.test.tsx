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

    const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ error: "stop here" }, { status: 409 }));
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /Join/ }));
    });
    expect(JSON.parse(String((fetch.mock.calls[0][1] as RequestInit).body))).toEqual({ planId: 7, autoRenew: true });
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
