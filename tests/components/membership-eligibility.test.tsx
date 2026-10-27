// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import MembershipEligibility from "../../src/components/MembershipEligibility";

/**
 * What the booking form says about a members-only session before booking
 * (components/MembershipEligibility.tsx; lib/entitlements.ts `memberCover`):
 * each person by whether a membership covers them on the session's date, not
 * today, why not, and where to renew.
 */

describe("the customer's eligibility message", () => {
  it("does not call somebody eligible because their membership is live today: it says when it ends, and links to renew", () => {
    render(
      <MembershipEligibility
        date="2026-11-27"
        lines={[
          { participantId: null, name: "Puan Aminah", covered: true, renew: "" },
          { participantId: 12, name: "Aina", covered: false, lapse: { kind: "ended", until: "2026-11-15" }, renew: "/venue/4#membership" },
        ]}
      />
    );
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(screen.getByText(/Members only on 2026-11-27/)).toBeTruthy();
    expect(screen.getByText(/You: a member on 2026-11-27/)).toBeTruthy();
    expect(screen.getByText(/Aina's membership ends on 2026-11-15, before this session on 2026-11-27\./)).toBeTruthy();
    const link = screen.getByRole("link", { name: "Renew or buy a membership" });
    expect(link.getAttribute("href")).toBe("/venue/4#membership");
  });

  it("says why for a cancelled or missing membership, and to ask the venue where it renews only at the counter", () => {
    render(
      <MembershipEligibility
        date="2026-11-27"
        lines={[
          { participantId: null, name: "Puan Aminah", covered: false, lapse: { kind: "none" }, renew: "" },
          { participantId: 13, name: "Badrul", covered: false, lapse: { kind: "cancelled" }, renew: "" },
        ]}
      />
    );
    expect(screen.getByText(/You have no membership here that covers 2026-11-27\./)).toBeTruthy();
    expect(screen.getByText(/Badrul's membership was cancelled\./)).toBeTruthy();
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("Ask the venue to renew it at the counter.")).toBeTruthy();
  });

  it("shows only a quiet confirmation when everybody is covered on the day, and nothing for no one", () => {
    const { container, rerender } = render(
      <MembershipEligibility date="2026-11-27" lines={[{ participantId: 12, name: "Aina", covered: true, renew: "" }]} />
    );
    expect(screen.getByRole("status")).toBeTruthy();
    expect(screen.getByText(/Aina: a member on 2026-11-27/)).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    rerender(<MembershipEligibility date="2026-11-27" lines={[]} />);
    expect(container.textContent).toBe("");
  });
});
