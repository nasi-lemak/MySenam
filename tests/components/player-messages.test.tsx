// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import MessagesPage from "../../src/app/messages/page";
import { MessageReportsPanel } from "../../src/components/admin/MessageReportsPanel";
import { MessagesLink } from "../../src/components/MessagesLink";
import { LanguageProvider } from "../../src/components/Language";

/**
 * The player's Messages page (the first screen, the list grouped by context, one conversation with its live region, block and report) and
 * the manager's panel of reports (docs/features/player-messages.md).
 */

let fetchMock: ReturnType<typeof vi.fn>;
const json = (body: unknown, ok = true, status = ok ? 200 : 400) => ({ ok, status, json: async () => body });
const info = { kind: "game", id: 7, venueId: 1, venueName: "Bangsar Courts", name: null, sport: "badminton", date: "2026-11-20", startMin: 1200, ended: false, endedAt: null };
const settings = (over = {}) => ({ enabled: true, emailNotices: true, explained: true, adult: true, ...over });
const thread = (over = {}) => ({ kind: "game", id: 7, info, phase: "open", people: 2, canSend: true, whyNot: null, muted: false, threadId: 3, messages: [], latestId: 0, ...over });

beforeEach(() => {
  fetchMock = vi.fn(async () => json({}));
  vi.stubGlobal("fetch", fetchMock);
  window.history.replaceState(null, "", "/messages");
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const urls = () => fetchMock.mock.calls.map(([u]) => String(u));
const page = () =>
  render(
    <LanguageProvider locale="en">
      <MessagesPage />
    </LanguageProvider>
  );

describe("the first screen", () => {
  it("says what messages are and turns them on only after it is read, and tells somebody who has not said they are an adult why not", async () => {
    fetchMock.mockImplementation(async (u: string, init?: RequestInit) => {
      if (init?.method === "PUT") return json({ settings: settings() });
      return json({ settings: settings({ enabled: false, explained: false }), threads: [], unread: 0 });
    });
    page();
    await act(async () => {});
    expect(screen.getByText("Let people I play with message me")).toBeTruthy();
    expect(screen.getByText(/never shown, and a message cannot contain a phone number/)).toBeTruthy();
    expect(screen.getByText(/block someone and report a message/)).toBeTruthy();
    const turnOn = screen.getByText("Turn on messages") as HTMLButtonElement;
    expect(turnOn.disabled).toBe(true);
    fireEvent.click(screen.getByLabelText("I have read this"));
    expect(turnOn.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(turnOn);
    });
    const put = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "PUT")!;
    expect(put[0]).toBe("/api/messages/settings");
    expect(JSON.parse(String((put[1] as RequestInit).body))).toEqual({ enabled: true, understood: true });
  });

  it("offers no switch to somebody who has not said they are 18 or over", async () => {
    fetchMock.mockImplementation(async () => json({ settings: settings({ enabled: false, explained: false, adult: false }), threads: [], unread: 0 }));
    page();
    await act(async () => {});
    expect(screen.queryByText("Turn on messages")).toBeNull();
    expect(screen.getByText(/You have not said you are 18 or over/)).toBeTruthy();
  });
});

describe("the list", () => {
  it("groups conversations by what they belong to, with unread counts in words and no directory", async () => {
    fetchMock.mockImplementation(async () =>
      json({
        settings: settings(),
        unread: 2,
        threads: [
          { kind: "game", id: 7, info, phase: "open", people: 2, unread: 2, muted: false, lastAt: "2026-11-05 10:00:00" },
          { kind: "team", id: 3, info: { ...info, kind: "team", id: 3, name: "Shuttle Club", sport: "badminton", date: null, venueName: null }, phase: "open", people: 1, unread: 0, muted: true, lastAt: null },
        ],
      })
    );
    page();
    await act(async () => {});
    expect(screen.getByText("2 new")).toBeTruthy();
    expect(screen.getByText("Team Shuttle Club")).toBeTruthy();
    expect(screen.getByText("muted")).toBeTruthy();
    expect(screen.getByText("2 people to write to")).toBeTruthy();
    expect(screen.getByText("1 person to write to")).toBeTruthy();
    // No search box, no field for a name or an address.
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("searchbox")).toBeNull();
  });
});

describe("one conversation", () => {
  const open = async (view: object) => {
    window.history.replaceState(null, "", "/messages?open=game:7");
    fetchMock.mockImplementation(async (u: string, init?: RequestInit) => {
      const url = String(u);
      if (url.startsWith("/api/messages/game/7")) {
        if (init?.method === "POST") return json({ message: { id: 9 } }, true, 201);
        return json(view);
      }
      return json({ settings: settings(), threads: [], unread: 0 });
    });
    page();
    await act(async () => {});
  };

  it("shows messages as plain text, guardians by the child's short name, an erased sender as a former member, and keeps the reader's own on their side", async () => {
    await open(
      thread({
        messages: [
          { id: 1, mine: false, from: { n: "Priya" }, body: "see https://example.com/x <b>bold</b>", at: "2026-11-05 10:00:00" },
          { id: 2, mine: false, from: { g: ["Aina L."] }, body: "we will be there", at: "2026-11-05 10:01:00" },
          { id: 3, mine: false, from: null, body: null, at: "2026-11-05 10:02:00" },
          { id: 4, mine: true, from: { n: "Me" }, body: "great", at: "2026-11-05 10:03:00" },
        ],
        latestId: 4,
      })
    );
    expect(urls()).toContain("/api/messages/game/7?read=1");
    // Plain text: the link is not a link and the tag is not a tag.
    expect(screen.getByText("see https://example.com/x <b>bold</b>")).toBeTruthy();
    expect(document.querySelector("a[href^='https://example.com']")).toBeNull();
    expect(document.querySelector("img")).toBeNull();
    expect(screen.getByText("Guardian of Aina L.")).toBeTruthy();
    expect(screen.getByText("A former member")).toBeTruthy();
    expect(screen.getByText("message removed")).toBeTruthy();
    expect(screen.getByText("You")).toBeTruthy();
    // Block and report for what others wrote, never for one's own or a removed one.
    expect(screen.getAllByText("Block")).toHaveLength(2);
    expect(screen.getAllByText("Report")).toHaveLength(2);
  });

  it("sends a message, shows a refusal in words, and offers no box once it has ended", async () => {
    await open(thread());
    const box = screen.getByLabelText("Write a message") as HTMLTextAreaElement;
    expect(box.maxLength).toBe(1000);
    fireEvent.change(box, { target: { value: "call me 0123456789" } });
    fetchMock.mockImplementationOnce(async () => json({ error: "Phone numbers and email addresses cannot be sent in messages.", code: "PM_CONTACT" }, false, 400));
    await act(async () => {
      fireEvent.click(screen.getByText("Send"));
    });
    expect(screen.getByRole("alert").textContent).toBe("Phone numbers and email addresses cannot be sent in messages.");
    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST")!;
    expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({ body: "call me 0123456789" });
  });

  it("says a finished conversation can be read, not written to", async () => {
    await open(thread({ phase: "read_only", canSend: false, whyNot: "PM_READ_ONLY" }));
    expect(screen.queryByLabelText("Write a message")).toBeNull();
    expect(screen.getByText("This conversation has ended. It can be read for a while longer, not written to.")).toBeTruthy();
  });

  it("announces new messages politely in a live region as polling brings them, without moving focus", async () => {
    vi.useFakeTimers();
    window.history.replaceState(null, "", "/messages?open=game:7");
    let calls = 0;
    fetchMock.mockImplementation(async (u: string) => {
      const url = String(u);
      if (url.startsWith("/api/messages/game/7")) {
        calls++;
        return json(
          calls === 1 ? thread() : thread({ messages: [{ id: 5, mine: false, from: { n: "Priya" }, body: "running late", at: "2026-11-05 10:00:00" }], latestId: 5 })
        );
      }
      return json({ settings: settings(), threads: [], unread: 0 });
    });
    page();
    await act(async () => {});
    const box = screen.getByLabelText("Write a message");
    box.focus();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_500);
    });
    expect(urls().some((u) => u.includes("after=0") || u.includes("&after="))).toBe(false);
    expect(screen.getByText("running late")).toBeTruthy();
    const live = document.querySelector("[aria-live='polite']")!;
    expect(live.getAttribute("role")).toBe("status");
    expect(live.textContent).toBe("1 new message");
    expect(document.activeElement).toBe(box);
  });

  it("blocks a sender and reports a message through the conversation's own routes", async () => {
    await open(thread({ messages: [{ id: 1, mine: false, from: { n: "Priya" }, body: "hello", at: "2026-11-05 10:00:00" }], latestId: 1 }));
    await act(async () => {
      fireEvent.click(screen.getByText("Block"));
    });
    const block = fetchMock.mock.calls.find(([u]) => String(u) === "/api/messages/game/7/block")!;
    expect(JSON.parse(String((block[1] as RequestInit).body))).toEqual({ messageId: 1 });
    fireEvent.click(screen.getByText("Report"));
    fireEvent.change(screen.getByLabelText("What is it about?"), { target: { value: "abuse" } });
    await act(async () => {
      fireEvent.click(screen.getByText("Send report"));
    });
    const report = fetchMock.mock.calls.find(([u]) => String(u) === "/api/messages/game/7/report")!;
    expect(JSON.parse(String((report[1] as RequestInit).body))).toMatchObject({ messageId: 1, reason: "abuse" });
  });
});

describe("the entry point", () => {
  it("is a plain link into the Messages page on that context", () => {
    render(
      <LanguageProvider locale="en">
        <MessagesLink kind="tournament-match" id={12} what="match" />
      </LanguageProvider>
    );
    const link = screen.getByText("Messages for this match") as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/messages?open=tournament-match:12");
  });
});

describe("the managers' panel of reports", () => {
  const report = (over = {}) => ({
    id: 5,
    createdAt: "2026-11-05 10:00:00",
    status: "open",
    outcome: null,
    reason: "abuse",
    note: "rude",
    kind: "game",
    contextId: 7,
    venueId: 1,
    threadId: 3,
    threadState: "open",
    reporter: { n: "Priya" },
    reported: { userId: 42, label: { g: ["Aina L."] }, suspended: false, reporters: 2 },
    reviewedBy: null,
    reviewedAt: null,
    lines: [
      { id: 1, from: { n: "Priya" }, body: "morning", at: "2026-11-05 09:59:00", flagged: false },
      { id: 2, from: { g: ["Aina L."] }, body: "bad words", at: "2026-11-05 10:00:00", flagged: true },
    ],
    ...over,
  });

  it("shows the frozen copy with the reported line marked, and acts by number with a reason", async () => {
    fetchMock.mockImplementation(async (_u: string, init?: RequestInit) =>
      init?.method === "POST" ? json({ ok: true }) : json({ reports: [report()], suspensions: [], scope: "venue" })
    );
    render(<MessageReportsPanel />);
    await act(async () => {});
    expect(urls()[0]).toBe("/api/admin/message-moderation?status=open");
    expect(screen.getByText("Open game 7")).toBeTruthy();
    expect(screen.getByText("Reported by Priya")).toBeTruthy();
    expect(screen.getByText(/About Guardian of Aina L\. \(account 42\); reported by 2 different people in 30 days/)).toBeTruthy();
    expect(screen.getByText("bad words")).toBeTruthy();
    expect(screen.getByText(/reported message/)).toBeTruthy();
    fireEvent.change(screen.getAllByLabelText("Reason (kept in the activity log)")[0], { target: { value: "abusive to a child" } });
    await act(async () => {
      fireEvent.click(screen.getByText("Suspend their messaging"));
    });
    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST")!;
    expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({ action: "suspend", userId: 42, reportId: 5, reason: "abusive to a child" });
    await act(async () => {
      fireEvent.click(screen.getByText("Pause conversation"));
    });
    const posts = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST");
    expect(JSON.parse(String((posts[1][1] as RequestInit).body))).toMatchObject({ action: "thread", id: 3, state: "muted" });
  });

  it("lists suspensions, and an automatic one can be kept or lifted", async () => {
    fetchMock.mockImplementation(async () =>
      json({ reports: [], scope: "platform", suspensions: [{ id: 9, userId: 42, who: "Pat", source: "automatic", venueId: null, reason: "Reported by 3 different people within 30 days", adminName: null, createdAt: "2026-11-05 10:00:00", pendingReview: true }] })
    );
    render(<MessageReportsPanel />);
    await act(async () => {});
    expect(screen.getByText(/Pat \(account 42\)/)).toBeTruthy();
    expect(screen.getByText("Keep it in place")).toBeTruthy();
    expect(screen.getByText("Lift suspension")).toBeTruthy();
  });
});
