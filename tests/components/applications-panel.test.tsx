// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { ApplicationsPanel } from "../../src/components/admin/ApplicationsPanel";
import { REVIEW_CHECKS } from "../../src/lib/review-checks";

/**
 * The platform owner's approvals: the evidence a venue is real, set out, and
 * no approving until the checks only a person can do have been done.
 */

let fetchMock: ReturnType<typeof vi.fn>;
const json = (body: unknown, ok = true) => ({ ok, json: async () => body });

const APPLICATION = {
  id: 7,
  businessName: "Smash Hall",
  area: "Cheras",
  address: "12 Jalan Cheras",
  venuePhone: "03-9100 0000",
  contactName: "Wei Ling",
  email: "wl@smashhall.my",
  message: null,
  status: "pending",
  reason: null,
  venueId: null,
  createdAt: "2026-10-17 01:00:00",
  decidedAt: null,
  businessId: null,
  forBusiness: null,
  pin: null,
  found: null,
  pinPlace: "Taman Connaught, Ipoh, Perak, Malaysia",
  emailCheck: "unsent",
  reviewChecks: [],
  location: { distanceM: null, nearby: [], warnings: ["The pin is 181 km from where the address leads."] },
};

beforeEach(() => {
  fetchMock = vi.fn(async (_url: string, init?: RequestInit) =>
    init?.method === "POST" ? json({ emailed: true }) : json({ marketplace: true, applications: [APPLICATION] })
  );
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("confirm", () => true);
});
afterEach(() => vi.unstubAllGlobals());

describe("an application waiting", () => {
  it("shows what doesn't add up, and whether its email was confirmed", async () => {
    render(<ApplicationsPanel onChange={() => {}} />);
    await act(async () => {});
    expect(screen.getByText(/181 km from where the address leads/)).toBeTruthy();
    expect(screen.getByText(/this install cannot send email/)).toBeTruthy();
    expect(screen.getByText(/Taman Connaught, Ipoh/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "03-9100 0000" }).getAttribute("href")).toBe("tel:0391000000");
  });

  it("cannot be approved until every check is ticked, and says which were", async () => {
    render(<ApplicationsPanel onChange={() => {}} />);
    await act(async () => {});
    const approve = screen.getByRole("button", { name: "Approve" }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);

    const boxes = screen.getAllByRole("checkbox");
    expect(boxes).toHaveLength(REVIEW_CHECKS.length);
    for (const box of boxes.slice(0, -1)) fireEvent.click(box);
    expect(approve.disabled).toBe(true);
    fireEvent.click(boxes[boxes.length - 1]);
    expect(approve.disabled).toBe(false);

    await act(async () => {
      fireEvent.click(approve);
    });
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(JSON.parse(post[1].body)).toMatchObject({
      id: 7,
      decision: "approve",
      checks: REVIEW_CHECKS.map((c) => c.id),
    });
  });
});
