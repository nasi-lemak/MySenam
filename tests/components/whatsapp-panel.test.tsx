// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { WhatsAppEditor } from "../../src/components/admin/WhatsAppEditor";
import ChatLink from "../../src/components/ChatLink";
import { translator } from "../../src/lib/i18n";

let fetchMock: ReturnType<typeof vi.fn>;
const json = (body: unknown, ok = true) => ({ ok, json: async () => body });

beforeEach(() => {
  fetchMock = vi.fn(async () => json({}));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const state = (over = {}) => ({
  mode: "urgent",
  available: true,
  prepaid: true,
  balance: 0,
  pack: { messages: 200, price: 20 },
  packs: [],
  usage: { venueId: 1, month: "2026-10", paid: 12, urgent: 4, free: 3 },
  chatReplies: true,
  canPayOnline: true,
  ...over,
});

async function open(isOwner = false) {
  render(<WhatsAppEditor venueId={1} isOwner={isOwner} />);
  await act(async () => screen.getByRole("button", { name: /WhatsApp messages/ }).click());
}

describe("the WhatsApp panel", () => {
  it("is urgent only to begin with, and buying credit only comes with everything", async () => {
    fetchMock.mockImplementation(async (_u: string, init?: RequestInit) =>
      json(init?.method === "POST" ? state({ mode: "all" }) : state())
    );
    await open();
    expect(screen.getByText(/get it by email with a calendar invite/)).toBeTruthy();
    expect((screen.getByRole("radio", { name: /Urgent only/ }) as HTMLInputElement).checked).toBe(true);
    expect(screen.getByText(/This month: 4 urgent \(included\), 12 from credit, 3 as replies/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Buy 200 messages/ })).toBeNull();
    await act(async () => screen.getByRole("radio", { name: /Everything/ }).click());
    expect(JSON.parse((fetchMock.mock.calls.at(-1)![1] as RequestInit).body as string)).toEqual({ venueId: 1, action: "mode", mode: "all" });
    expect(screen.getByText(/go by email only until you buy more/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Buy 200 messages/ })).toBeTruthy();
  });

  it("estimates what a month would take, and buys a pack", async () => {
    fetchMock.mockImplementation(async (_u: string, init?: RequestInit) =>
      json(
        init?.method === "POST"
          ? state({ mode: "all", packs: [{ id: 4, venueId: 1, messages: 200, amount: 20, status: "due", createdAt: "2026-10-18 01:00:00", paidAt: null, paidVia: null }] })
          : state({ mode: "all" })
      )
    );
    await open();
    fireEvent.change(screen.getByLabelText("Bookings a month"), { target: { value: "500" } });
    expect(screen.getByTestId("estimate").textContent).toMatch(/550 messages a month: 3 packs, about RM60.00/);
    await act(async () => screen.getByRole("button", { name: "Buy 200 messages · RM20" }).click());
    expect(screen.getByText(/waiting for payment/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Pay online" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Mark paid" })).toBeNull();
  });

  it("lets the owner mark a pack paid, give messages, and shows refusals", async () => {
    fetchMock.mockImplementation(async (_u: string, init?: RequestInit) => {
      if (init?.method !== "POST") return json(state({ mode: "all", balance: 5, packs: [{ id: 4, venueId: 1, messages: 200, amount: 20, status: "due", createdAt: "2026-10-18", paidAt: null, paidVia: null }] }));
      const body = JSON.parse(init.body as string);
      return body.action === "grant" ? json({ error: "How many messages?" }, false) : json(state({ mode: "all", balance: 205 }));
    });
    await open(true);
    expect(screen.getByText(/^5 messages left/)).toBeTruthy();
    await act(async () => screen.getByRole("button", { name: /Give messages/ }).click());
    expect(screen.getByText("How many messages?")).toBeTruthy();
    await act(async () => screen.getByRole("button", { name: "Mark paid" }).click());
    expect(screen.getByText(/205 messages left/)).toBeTruthy();
  });

  it("says when the site cannot send WhatsApp at all", async () => {
    fetchMock.mockImplementation(async () => json(state({ available: false })));
    await open();
    expect(screen.getByText(/not set up on this site yet/)).toBeTruthy();
    expect(screen.queryByRole("radio")).toBeNull();
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
