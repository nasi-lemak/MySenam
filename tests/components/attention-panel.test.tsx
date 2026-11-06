// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

import { AttentionPanel } from "../../src/components/admin/AttentionPanel";
import { LanguageProvider } from "../../src/components/Language";

let fetchMock: ReturnType<typeof vi.fn>;
const json = (body: unknown, ok = true) => ({ ok, json: async () => body });

beforeEach(() => {
  fetchMock = vi.fn(async () => json({ open: [], recent: [] }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const notice = (over = {}) => ({
  id: 1,
  venueId: 1,
  bookingId: 9,
  kind: "cancelled",
  name: "Nurul Hana",
  phone: "0161234567",
  email: null,
  date: "2026-10-25",
  startHour: 18,
  summary: "Arena cancelled booking MS-ABC234: Court 1 at Arena, 2026-10-25, 6:00 PM to 7:00 PM.",
  createdAt: "2026-10-18 10:00:00",
  ackedAt: null,
  resolvedAt: null,
  resolution: null,
  messages: [],
  reach: "unreachable",
  ...over,
});

describe("the needs-attention panel", () => {
  it("says what the venue did in the staff language, where the notice kept its phrase; an older one as stored", async () => {
    const phrase = {
      key: "srv.urgent.cancelled",
      vars: {
        venue: "Arena",
        code: "MS-ABC234",
        where: { key: "srv.urgent.where", vars: { court: "Court 1", venue: "Arena" } },
        when: { key: "srv.urgent.when", vars: { date: "2026-10-25", from: "6:00 PM", to: "7:00 PM" } },
      },
    };
    fetchMock.mockImplementation(async () => json({ open: [notice({ summaryPhrase: phrase }), notice({ id: 3, summaryPhrase: null, summary: "Stored long ago." })], recent: [] }));
    render(
      <LanguageProvider locale="zh">
        <AttentionPanel />
      </LanguageProvider>
    );
    await act(async () => {});
    expect(screen.getByText("Arena 取消了预订 MS-ABC234：Arena 的 Court 1，2026-10-25，6:00 PM 至 7:00 PM。")).toBeTruthy();
    expect(screen.getByText("Stored long ago.")).toBeTruthy();
  });

  it("lists fixtures on a lost court with one action to move the day, tournaments nobody drew, and the messaging lines (ADR 0059)", async () => {
    const stranded = { kind: "tournament", id: 5, ownerId: 7, name: "Spring Cup", venueId: 1, date: "2026-11-20", startMin: 540, minutes: 30, courtId: 2, courtName: "Court 2", why: "outage" };
    fetchMock.mockImplementation(async (url: string, init?: { method?: string; body?: string }) =>
      init?.method === "POST"
        ? json({ moved: 2 })
        : json({
            open: [],
            recent: [],
            competitions: {
              stranded: [stranded, { ...stranded, id: 6 }],
              undrawn: [{ id: 8, name: "Autumn Open", venueId: 1, startsOn: "2026-11-06", endsOn: "2026-11-06", status: "open", entered: 3, held: [{ courtName: "Court 1", date: "2026-11-06", startMin: 540, endMin: 720 }] }],
            },
            messageModeration: { openReports: 2, oldestOpenReport: "2026-11-01 10:00:00", waitingDays: 5, suspensionsToReview: [{ id: 4, since: "2026-11-01 10:00:00", reviewBy: "2026-11-15 10:00:00", overdue: false }], reviewRequests: 1 },
          })
    );
    const { container } = render(
      <LanguageProvider locale="en">
        <AttentionPanel />
      </LanguageProvider>
    );
    await act(async () => {});
    const text = container.textContent ?? "";
    expect(text).toContain("Spring Cup: 2 fixture(s) still to play on 2026-11-20");
    expect(text).toContain("court out of service");
    expect(text).toContain("Autumn Open was to start on 2026-11-06 and has not been drawn (3 entered)");
    expect(text).toContain("Court 1 2026-11-06");
    expect(text).toContain("2 report(s) of messages are open, the oldest for 5 day(s).");
    expect(text).toContain("Messaging suspension 4 was made by the rule: review it by 2026-11-15.");
    expect(text).toContain("1 request for a review of a messaging suspension is waiting");
    // One action moves the day: it posts to the tournament with the day to move to.
    const input = container.querySelector('input[type="date"]') as HTMLInputElement;
    const { fireEvent } = await import("@testing-library/react");
    await act(async () => {
      fireEvent.change(input, { target: { value: "2026-11-21" } });
    });
    await act(async () => {
      fireEvent.click(screen.getByText("Move the day"));
    });
    const call = fetchMock.mock.calls.find((c) => (c[1] as { method?: string } | undefined)?.method === "POST")!;
    expect(call[0]).toBe("/api/admin/tournaments/7");
    expect(JSON.parse((call[1] as { body: string }).body)).toEqual({ action: "postpone_day", from: "2026-11-20", to: "2026-11-21" });
    expect(container.textContent).toContain("2 fixture(s) moved to 2026-11-21");
  });

  it("is not there when nothing needs attention", async () => {
    const { container } = render(<AttentionPanel />);
    await act(async () => {});
    expect(container.innerHTML).toBe("");
  });

  it("asks for a call where nothing reached the customer, and closes once they are told", async () => {
    const delivered = notice({
      id: 2,
      email: "mei@example.my",
      reach: "delivered",
      messages: [
        { id: 5, channel: "whatsapp", status: "sent", sentAt: "x", deliveredAt: "y", readAt: null, error: null },
        { id: 6, channel: "email", status: "sent", sentAt: "x", deliveredAt: null, readAt: null, error: null },
      ],
    });
    fetchMock.mockImplementation(async (_u: string, init?: RequestInit) =>
      init?.method === "POST"
        ? json({ open: [delivered], recent: [notice({ reach: "told", resolvedAt: "z", resolution: "told" })] })
        : json({ open: [notice(), delivered], recent: [] })
    );
    render(<AttentionPanel />);
    await act(async () => {});
    expect(screen.getByRole("heading", { name: "Needs attention (2)" })).toBeTruthy();
    expect(screen.getByText("No email or WhatsApp — call them")).toBeTruthy();
    expect(screen.getByText("Delivered to phone, not yet seen")).toBeTruthy();
    expect(screen.getByText("WhatsApp delivered · Email sent")).toBeTruthy();
    expect(screen.getAllByRole("link", { name: "0161234567" })[0].getAttribute("href")).toBe("tel:0161234567");
    await act(async () => screen.getAllByRole("button", { name: "I have told them" })[0].click());
    expect(screen.getByRole("heading", { name: "Needs attention (1)" })).toBeTruthy();
    await act(async () => screen.getByRole("button", { name: /Closed this week/ }).click());
    expect(screen.getByText("Told by staff")).toBeTruthy();
  });

  it("refreshes when staff cancel something, and shows a refusal", async () => {
    fetchMock.mockImplementation(async (_u: string, init?: RequestInit) =>
      init?.method === "POST" ? json({ error: "That is already closed." }, false) : json({ open: [notice()], recent: [] })
    );
    render(<AttentionPanel />);
    await act(async () => {});
    const calls = fetchMock.mock.calls.length;
    await act(async () => void window.dispatchEvent(new Event("attention:refresh")));
    expect(fetchMock.mock.calls.length).toBe(calls + 1);
    await act(async () => screen.getByRole("button", { name: "I have told them" }).click());
    expect(screen.getByText("That is already closed.")).toBeTruthy();
  });
});
