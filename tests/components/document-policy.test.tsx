// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import DocumentPolicy from "../../src/components/admin/DocumentPolicy";
import type { RetentionPolicy } from "../../src/lib/retention-policy";

/**
 * The platform owner's retention periods (lib/retention-policy.ts; ADR 0024):
 * each recorded review shown as the owner's record, not verified by MySenam,
 * per jurisdiction, with what is still provisional; never as approval; and a
 * review sent with its whole provenance.
 */

let fetchMock: ReturnType<typeof vi.fn>;
const json = (body: unknown, ok = true) => ({ ok, json: async () => body });

const REVIEW = {
  id: 1,
  jurisdiction: "MY" as const,
  reviewerName: "Aisha Rahman",
  reviewerRole: "Advocate & Solicitor",
  firm: "Rahman & Co",
  scope: ["documentDays", "reviewDays", "recordDays", "quarantineDays"] as RetentionPolicy["coverage"]["MY"]["covered"],
  reviewedOn: "2026-10-20",
  adviceReference: "Letter RC/2026/114",
  basis: "Reviewed against the retention principle.",
  periods: "90/30/365/7",
  recordedBy: "Pat Owner",
  recordedAt: "2026-10-21T00:00:00.000Z",
};

const policy = (over: Partial<RetentionPolicy> = {}): RetentionPolicy => ({
  documentDays: 90,
  reviewDays: 30,
  recordDays: 365,
  quarantineDays: 7,
  changedAt: null,
  changedBy: null,
  home: "MY",
  provisional: false,
  coverage: {
    MY: { reviews: [REVIEW], covered: REVIEW.scope, provisional: [] },
    SG: { reviews: [], covered: [], provisional: ["documentDays", "reviewDays", "recordDays", "quarantineDays"] },
  },
  ...over,
});

beforeEach(() => {
  fetchMock = vi.fn(async (_url: string, init?: RequestInit) => (init?.method === "POST" ? json({ policy: policy() }) : json({ policy: policy(), bounds: {}, events: [] })));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("the retention periods", () => {
  it("show each review as the owner's record, not verified by MySenam, and what each jurisdiction still has provisional", async () => {
    render(<DocumentPolicy />);
    await act(async () => {});
    expect(screen.getByText(/Every period has a review recorded for Malaysia: recorded by the platform owner, not verified by MySenam\./)).toBeTruthy();
    expect(
      screen.getByText(
        "Malaysia: Aisha Rahman (Advocate & Solicitor), Rahman & Co, reviewed documents after the decision, the review window, closed applications, refused or unscannable documents on 2026-10-20. Written advice: Letter RC/2026/114. Recorded by Pat Owner, not verified by MySenam. Basis: Reviewed against the retention principle."
      )
    ).toBeTruthy();
    expect(screen.getByText("Singapore: provisional for documents after the decision, the review window, closed applications, refused or unscannable documents.")).toBeTruthy();
    expect(screen.getByText(/does not make these periods legally approved/)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(/periods are (legally )?approved/i);
  });

  it("say provisional where the install's own country is not covered for every period", async () => {
    fetchMock.mockImplementation(async () =>
      json({ policy: policy({ provisional: true, coverage: { MY: { reviews: [], covered: [], provisional: REVIEW.scope }, SG: { reviews: [], covered: [], provisional: REVIEW.scope } } }), events: [] })
    );
    render(<DocumentPolicy />);
    await act(async () => {});
    expect(screen.getByText(/Provisional: .* no review is recorded for every period in Malaysia\./)).toBeTruthy();
  });

  it("send a review with its jurisdictions, periods, reviewer, role, firm, day and the reference to the written advice", async () => {
    render(<DocumentPolicy />);
    await act(async () => {});
    fireEvent.click(screen.getByLabelText("Singapore"));
    fireEvent.click(screen.getByLabelText("closed applications"));
    fireEvent.change(screen.getByLabelText("Day of the review"), { target: { value: "2026-10-22" } });
    fireEvent.change(screen.getByLabelText("Reviewer's name"), { target: { value: "Tan Wei Ming" } });
    fireEvent.change(screen.getByLabelText("Role or qualification, as they state it"), { target: { value: "Advocate & Solicitor (Singapore)" } });
    fireEvent.change(screen.getByLabelText("Firm or organisation"), { target: { value: "Tan LLP" } });
    fireEvent.change(screen.getByLabelText("Reference to the written advice (kept outside MySenam)"), { target: { value: "Memo TL-88" } });
    fireEvent.change(screen.getByLabelText("What the review was based on"), { target: { value: "Reviewed against the PDPA retention obligation." } });
    await act(async () => {
      fireEvent.click(screen.getByText("Record the review"));
    });
    const sent = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(JSON.parse(String(sent[1].body))).toEqual({
      action: "review",
      jurisdictions: ["SG"],
      scope: ["recordDays"],
      reviewedOn: "2026-10-22",
      reviewerName: "Tan Wei Ming",
      reviewerRole: "Advocate & Solicitor (Singapore)",
      firm: "Tan LLP",
      adviceReference: "Memo TL-88",
      basis: "Reviewed against the PDPA retention obligation.",
    });
  });
});

describe("scanning a failed document again", () => {
  const FAILED = {
    id: 41,
    requestId: 7,
    venueId: 1,
    venueName: "Panahan Rawang",
    sport: "archery",
    contentType: "application/pdf",
    size: 2048,
    failure: "unscannable",
    error: "too_large: size limit exceeded",
    failedAt: "2026-10-27T01:00:00.000Z",
    storedAt: "2026-10-27T01:00:00.000Z",
    legacyReason: null,
    intact: true,
    manualRetries: 0,
    retries: [],
  };

  // The owner learns what the scan that followed found, not only that it was asked for (found by Documents I, tests/uat/round4.uat.ts).
  it.each([
    [{ status: "clean", alreadyQueued: false }, "Scanned again: it passed, and can now be opened."],
    [{ status: "rejected", alreadyQueued: false }, "Scanned again: the scan refused it, and its content was removed."],
    [{ status: "failed", alreadyQueued: false }, "Scanned again: it still could not be scanned."],
    [{ status: "pending", alreadyQueued: false }, "Put back in quarantine to be scanned."],
    [{ status: "pending", alreadyQueued: true }, "It is already waiting for a scan."],
  ])("says what the scan found: %j", async (after, said) => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
      init?.method === "POST" ? json(after) : json({ policy: policy(), events: [], failed: [FAILED] })
    );
    render(<DocumentPolicy />);
    await act(async () => {});
    fireEvent.change(screen.getByLabelText("Why scan it again"), { target: { value: "Scanner restarted after an update" } });
    await act(async () => {
      fireEvent.click(screen.getByText("Scan again"));
    });
    const sent = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
    expect(JSON.parse(String(sent[1].body))).toEqual({ action: "retry", documentId: 41, reason: "Scanner restarted after an update" });
    expect(screen.getByText(said)).toBeTruthy();
  });
});
