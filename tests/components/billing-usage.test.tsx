// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { BillingPanel } from "../../src/components/admin/BillingPanel";
import ChatLink from "../../src/components/ChatLink";
import { translator } from "../../src/lib/i18n";

let fetchMock: ReturnType<typeof vi.fn>;
const json = (body: unknown, ok = true) => ({ ok, json: async () => body });

beforeEach(() => {
  fetchMock = vi.fn(async () => json({}));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const usage = (over = {}) => ({ venueId: 1, month: "2026-10", paid: 120, free: 30, included: 300, unitPrice: 0.08, over: 0, amount: 0, ...over });
const invoice = {
  id: 9,
  venueId: 1,
  businessId: null,
  venueName: "Arena",
  lines: [],
  period: "2026-11",
  amount: 23,
  status: "due",
  issuedOn: "2026-11-01",
  dueOn: "2026-11-15",
  paidAt: null,
  paidVia: null,
  overdue: false,
  usage: [{ venueId: 1, venueName: "Arena", month: "2026-10", messages: 340, included: 300, unitPrice: 0.075, amount: 3 }],
};

describe("the WhatsApp meter", () => {
  it("shows staff how far into the allowance they are, and what went free", async () => {
    fetchMock.mockImplementation(async () => json({ marketplace: true, invoices: [invoice], usage: [{ ...usage(), venueName: "Arena" }], canPayOnline: false }));
    render(<BillingPanel isOwner={false} />);
    await act(async () => {});
    expect(screen.getByText("120 of 300 included")).toBeTruthy();
    expect(screen.getByRole("meter").getAttribute("aria-valuenow")).toBe("120");
    expect(screen.getByText(/30 more went free/)).toBeTruthy();
    expect(screen.getByText(/WhatsApp in 2026-10: 340 sent, 300 included → 40 × RM0.075 = RM3.00/)).toBeTruthy();
  });

  it("warns once the allowance is past", async () => {
    fetchMock.mockImplementation(async () =>
      json({ marketplace: true, invoices: [], usage: [{ ...usage({ paid: 350, over: 50, amount: 4 }), venueName: "Arena" }, { ...usage({ venueId: 2, included: 0, paid: 0, free: 0 }), venueName: "Branch" }], canPayOnline: false })
    );
    render(<BillingPanel isOwner={false} />);
    await act(async () => {});
    expect(screen.getByText(/50 over the allowance: RM4.00 so far/)).toBeTruthy();
    expect(screen.getByText(/Branch: WhatsApp this month/)).toBeTruthy();
  });

  it("lets the owner set a venue's allowance and rate", async () => {
    fetchMock.mockImplementation(async (_url: string, init?: RequestInit) =>
      init?.method === "POST"
        ? json({ ok: true })
        : json({
            marketplace: true,
            invoices: [],
            defaultFee: 20,
            messageDefaults: { included: 300, unitPrice: 0.08 },
            plans: [{ venueId: 1, venueName: "Arena", monthlyFee: null, effectiveFee: 20, billingStartsOn: "2026-10-01", whatsappIncluded: null, whatsappPrice: 0.05, usage: usage({ unitPrice: 0.05, paid: 400, over: 100, amount: 5 }) }],
            canPayOnline: false,
          })
    );
    render(<BillingPanel isOwner />);
    await act(async () => {});
    expect(screen.getByText(/\+RM5.00/)).toBeTruthy();
    await act(async () => screen.getByRole("button", { name: "Change" }).click());
    fireEvent.change(screen.getByLabelText("WhatsApp messages included"), { target: { value: "1000" } });
    expect((screen.getByLabelText("Each extra WhatsApp message") as HTMLInputElement).value).toBe("0.05");
    await act(async () => screen.getByRole("button", { name: "Save" }).click());
    const post = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === "POST")!;
    expect(JSON.parse((post[1] as RequestInit).body as string)).toMatchObject({ action: "setPlan", whatsappIncluded: "1000", whatsappPrice: "0.05" });
  });
});

describe("the chat button", () => {
  it("opens a chat with the code typed in, or is not there", () => {
    const t = translator("en");
    const { container, rerender } = render(<ChatLink t={t} number="601123456789" code="MS-ABC234" />);
    expect(container.querySelector("a")!.getAttribute("href")).toBe(
      `https://wa.me/601123456789?text=${encodeURIComponent("Hi! Please send me booking MS-ABC234.")}`
    );
    rerender(<ChatLink t={t} number={null} code="MS-ABC234" />);
    expect(container.querySelector("a")).toBeNull();
  });
});
