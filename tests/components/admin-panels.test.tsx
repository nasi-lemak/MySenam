// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { FirstRun } from "../../src/components/admin/FirstRun";
import { MessagesPanel } from "../../src/components/admin/MessagesPanel";

/**
 * Two panels where getting the UI wrong costs something real: one throws data
 * away, and one is the only place anybody finds out a customer was never told.
 */

let fetchMock: ReturnType<typeof vi.fn>;

function json(body: unknown, ok = true) {
  return { ok, json: async () => body };
}

beforeEach(() => {
  fetchMock = vi.fn(async () => json({}));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const VENUE = { id: 1, name: "Arena MySenam", courts: [] } as never;

describe("the first-run panel", () => {
  it("says nothing at all on an install that is already trading", async () => {
    fetchMock.mockImplementation(async () =>
      json({ empty: false, seeded: true, stale: false, refreshable: true })
    );
    const { container } = render(<FirstRun onSeeded={() => {}} />);
    await act(async () => {});
    expect(container.textContent).toBe("");
  });

  it("offers the demo on an empty install", async () => {
    fetchMock.mockImplementation(async () => json({ empty: true, seeded: false }));
    render(<FirstRun onSeeded={() => {}} />);
    await act(async () => {});
    expect(screen.getByText(/Nothing has been booked here yet/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /Load demo data/ })).toBeTruthy();
  });

  it("offers to reload a demo that has run out, and says when it was written", async () => {
    fetchMock.mockImplementation(async () =>
      json({
        empty: false,
        seeded: true,
        stale: true,
        refreshable: true,
        seededOn: "2026-09-10",
        runsTo: "2026-09-20",
      })
    );
    render(<FirstRun onSeeded={() => {}} />);
    await act(async () => {});
    expect(screen.getByText(/This demo has run out/)).toBeTruthy();
    expect(screen.getByText(/10 Sept 2026/)).toBeTruthy();
    expect(screen.getByText(/20 Sept 2026/)).toBeTruthy();
  });

  /** A reload clears every booking. One stray click should not do that. */
  it("asks before throwing anything away, and backing out sends nothing", async () => {
    fetchMock.mockImplementation(async () =>
      json({ empty: false, seeded: true, stale: true, refreshable: true })
    );
    render(<FirstRun onSeeded={() => {}} />);
    await act(async () => {});

    await act(async () => screen.getByRole("button", { name: /Reload the demo/ }).click());
    expect(screen.getByRole("button", { name: /Yes — clear it/ })).toBeTruthy();

    await act(async () => screen.getByRole("button", { name: /Leave it alone/ }).click());
    expect(screen.getByRole("button", { name: /Reload the demo/ })).toBeTruthy();
    // The only call made was the one that read the state.
    expect(fetchMock.mock.calls.filter((c) => c[1]?.method === "POST")).toHaveLength(0);
  });

  it("only posts once the second button is pressed", async () => {
    fetchMock.mockImplementation(async (_url: string, opts?: { method?: string }) =>
      opts?.method === "POST"
        ? json({ ok: true, bookings: 2941, extras: ["a pass"] })
        : json({ empty: false, seeded: true, stale: true, refreshable: true })
    );
    render(<FirstRun onSeeded={() => {}} />);
    await act(async () => {});
    await act(async () => screen.getByRole("button", { name: /Reload the demo/ }).click());
    await act(async () => screen.getByRole("button", { name: /Yes — clear it/ }).click());

    const posts = fetchMock.mock.calls.filter((c) => c[1]?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0][1].body)).toEqual({ refresh: true });
    expect(screen.getByText(/2941 bookings written/)).toBeTruthy();
  });
});

describe("the messages panel", () => {
  const summary = { queued: 0, sent: 0, failed: 0, abandoned: 0, transport: null };
  const message = {
    id: 7,
    bookingId: 3,
    venueId: 1,
    kind: "booking_confirmed",
    channel: "whatsapp",
    recipient: "0191234567",
    locale: "ms",
    subject: "Tempahan MS-1 disahkan",
    body: "Hai Siti, tempahan anda telah disahkan.",
    status: "queued",
    attempts: 0,
    lastError: null,
    createdAt: "2026-10-01 02:47:00",
    nextAttemptAt: "2026-10-01 02:47:00",
    sentAt: null,
    dedupeKey: "confirmed:MS-1",
  };

  it("says plainly that nothing is being sent when nothing can be", async () => {
    fetchMock.mockImplementation(async () =>
      json({ messages: [message], summary: { ...summary, queued: 1 } })
    );
    render(<MessagesPanel venues={[VENUE]} />);
    await act(async () => {});
    expect(screen.getByText(/Nothing is being sent yet/)).toBeTruthy();
    expect(screen.getByText(/queued — 1 of them so far/)).toBeTruthy();
  });

  it("counts what went where once a transport exists", async () => {
    fetchMock.mockImplementation(async () =>
      json({
        messages: [{ ...message, status: "sent", sentAt: "2026-10-01 02:47:05" }],
        summary: { ...summary, sent: 3, failed: 1, transport: "log" },
      })
    );
    render(<MessagesPanel venues={[VENUE]} />);
    await act(async () => {});
    expect(screen.queryByText(/Nothing is being sent yet/)).toBeNull();
    expect(screen.getByText(/via log/)).toBeTruthy();
    expect(screen.getByText("Sent:").parentElement?.textContent).toContain("3");
  });

  it("keeps the message body out of the way until it is asked for", async () => {
    fetchMock.mockImplementation(async () => json({ messages: [message], summary }));
    render(<MessagesPanel venues={[VENUE]} />);
    await act(async () => {});
    expect(screen.queryByText(/tempahan anda telah disahkan/)).toBeNull();
    await act(async () => screen.getByRole("button", { name: "Booking confirmed" }).click());
    expect(screen.getByText(/tempahan anda telah disahkan/)).toBeTruthy();
  });

  it("lets staff correct a wrong number and send there instead", async () => {
    fetchMock.mockImplementation(async (_url: string, opts?: { method?: string }) =>
      opts?.method === "POST"
        ? json({ message: { ...message, recipient: "0171112222", status: "queued" } })
        : json({ messages: [{ ...message, status: "abandoned", attempts: 5 }], summary })
    );
    render(<MessagesPanel venues={[VENUE]} />);
    await act(async () => {});

    await act(async () => screen.getByRole("button", { name: /wrong number/ }).click());
    const field = screen.getByDisplayValue("0191234567");
    // fireEvent, not a raw dispatch: React intercepts the value setter, so a
    // hand-made input event changes the DOM without telling the component.
    await act(async () => void fireEvent.change(field, { target: { value: "0171112222" } }));
    await act(async () => screen.getByRole("button", { name: /Send there/ }).click());

    const posts = fetchMock.mock.calls.filter((c) => c[1]?.method === "POST");
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0][1].body)).toEqual({ id: 7, recipient: "0171112222" });
  });

  it("does not offer to resend something already sent", async () => {
    fetchMock.mockImplementation(async () =>
      json({ messages: [{ ...message, status: "sent" }], summary })
    );
    render(<MessagesPanel venues={[VENUE]} />);
    await act(async () => {});
    expect(screen.queryByRole("button", { name: /Try again/ })).toBeNull();
  });
});
