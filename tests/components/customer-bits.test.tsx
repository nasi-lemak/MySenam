// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

import AuthNav from "../../src/components/AuthNav";
import CheckInQr from "../../src/components/CheckInQr";
import LiveOccupancy from "../../src/components/LiveOccupancy";
import MyPasses from "../../src/components/MyPasses";
import MyWaitlist from "../../src/components/MyWaitlist";
import Wallet from "../../src/components/Wallet";
import { LanguageProvider } from "../../src/components/Language";

vi.mock("next/navigation", () => ({ usePathname: () => "/" }));

let fetchMock: ReturnType<typeof vi.fn>;
const json = (body: unknown, ok = true) => ({ ok, json: async () => body });

beforeEach(() => {
  fetchMock = vi.fn(async () => json({}));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function show(node: React.ReactNode, locale: "en" | "ms" = "en") {
  return render(<LanguageProvider locale={locale}>{node}</LanguageProvider>);
}

describe("the sign-in chip", () => {
  it("invites a stranger to sign in", async () => {
    fetchMock.mockImplementation(async () => json({ user: null }));
    show(<AuthNav />);
    await act(async () => {});
    const link = screen.getByRole("link", { name: "Sign in" });
    expect(link.getAttribute("href")).toBe("/login");
  });

  it("greets a customer by their first name only", async () => {
    fetchMock.mockImplementation(async () =>
      json({ user: { id: 1, name: "Nurul Hana binti Ismail", email: "n@e.com", phone: "01" } })
    );
    show(<AuthNav />);
    await act(async () => {});
    const link = screen.getByRole("link", { name: /Nurul/ });
    expect(link.getAttribute("href")).toBe("/account");
    expect(link.textContent).not.toContain("binti");
  });

  it("says it in Malay", async () => {
    fetchMock.mockImplementation(async () => json({ user: null }));
    show(<AuthNav />, "ms");
    await act(async () => {});
    expect(screen.getByRole("link", { name: "Log masuk" })).toBeTruthy();
  });
});

describe("the check-in code", () => {
  it("keeps the code hidden until it is asked for", async () => {
    show(<CheckInQr token="abc123" />);
    expect(screen.queryByRole("img")).toBeNull();
    await act(async () => screen.getByRole("button").click());
    const img = screen.getByRole("img");
    expect(img.getAttribute("src")).toContain("token=abc123");
    expect(img.getAttribute("alt")).toBe("Scan this code at the venue to check in");
  });

  it("hides it again", async () => {
    show(<CheckInQr token="abc123" />);
    await act(async () => screen.getByRole("button").click());
    await act(async () => screen.getByRole("button", { name: /Hide/ }).click());
    expect(screen.queryByRole("img")).toBeNull();
  });
});

describe("how busy it is", () => {
  const live = (over: Record<string, unknown> = {}) => ({
    occupancy: [
      {
        courtId: 2,
        courtName: "Gym Floor",
        sport: "gym",
        capacity: 40,
        present: 9,
        level: "quiet",
        ...over,
      },
    ],
    asOf: "2026-10-01T02:30:00Z",
  });

  it("says nothing when there is no shared facility to count", async () => {
    fetchMock.mockImplementation(async () => json(live({ capacity: 1, present: 0 })));
    const { container } = show(<LiveOccupancy venueId={1} />);
    await act(async () => {});
    expect(container.textContent).toBe("");
  });

  it("shows the headcount and how full that is", async () => {
    fetchMock.mockImplementation(async () => json(live()));
    show(<LiveOccupancy venueId={1} />);
    await act(async () => {});
    expect(screen.getByText("Here right now")).toBeTruthy();
    expect(screen.getByText("9/40 in")).toBeTruthy();
    expect(screen.getByText("Quiet")).toBeTruthy();
  });

  it("names the crowd level in Malay too", async () => {
    fetchMock.mockImplementation(async () => json(live({ level: "full", present: 40 })));
    show(<LiveOccupancy venueId={1} />, "ms");
    await act(async () => {});
    expect(screen.getByText("Penuh")).toBeTruthy();
    expect(screen.getByText("40/40 masuk")).toBeTruthy();
  });

  it("leaves the last reading up when a refresh fails", async () => {
    fetchMock.mockImplementationOnce(async () => json(live()));
    show(<LiveOccupancy venueId={1} />);
    await act(async () => {});
    fetchMock.mockImplementation(async () => {
      throw new Error("offline");
    });
    await act(async () => {});
    expect(screen.getByText("9/40 in")).toBeTruthy();
  });
});

describe("stored credit", () => {
  it("stays out of the way for somebody who holds none", async () => {
    fetchMock.mockImplementation(async () => ({ ok: false, json: async () => ({}) }));
    const { container } = show(<Wallet />);
    await act(async () => {});
    expect(container.textContent).toBe("");
  });

  it("shows the balance, and the history only on request", async () => {
    fetchMock.mockImplementation(async () =>
      json({
        balance: 80,
        entries: [
          { id: 1, amount: 100, reason: "Counter top-up" },
          { id: 2, amount: -20, reason: "Booking MS-1" },
        ],
      })
    );
    show(<Wallet />);
    await act(async () => {});
    expect(screen.getByText("RM80")).toBeTruthy();
    expect(screen.queryByText("Counter top-up")).toBeNull();

    await act(async () => screen.getByRole("button", { name: "Show history" }).click());
    expect(screen.getByText("Counter top-up")).toBeTruthy();
    // A spend reads as a spend, not as a negative number.
    expect(screen.getByText("−RM20")).toBeTruthy();
    expect(screen.getByText("+RM100")).toBeTruthy();
  });
});

describe("passes", () => {
  const pass = {
    id: 1,
    code: "PS-ABC123",
    name: "10-hour badminton pass",
    venueId: 1,
    venueName: "Arena MySenam",
    sport: "badminton",
    entries: 10,
    remaining: 7,
    expiresOn: "2027-02-19",
    unusableReason: null,
  };

  it("says nothing when there are none", async () => {
    fetchMock.mockImplementation(async () => json({ passes: [] }));
    const { container } = show(<MyPasses />);
    await act(async () => {});
    expect(container.textContent).toBe("");
  });

  it("shows what is left, what is spent and when it runs out", async () => {
    fetchMock.mockImplementation(async () => json({ passes: [pass] }));
    show(<MyPasses />);
    await act(async () => {});
    expect(screen.getByText("7")).toBeTruthy();
    expect(screen.getByText("of 10 left")).toBeTruthy();
    expect(screen.getByText("3 used")).toBeTruthy();
    expect(screen.getByText("Valid until 2027-02-19")).toBeTruthy();
  });

  it("says why a pass cannot be used instead of its expiry date", async () => {
    fetchMock.mockImplementation(async () =>
      json({ passes: [{ ...pass, unusableReason: "This pass was cancelled." }] })
    );
    show(<MyPasses />);
    await act(async () => {});
    expect(screen.getByText("This pass was cancelled.")).toBeTruthy();
    expect(screen.queryByText(/Valid until/)).toBeNull();
  });

  it("calls a pass with no sport what it is", async () => {
    fetchMock.mockImplementation(async () => json({ passes: [{ ...pass, sport: null }] }));
    show(<MyPasses />, "ms");
    await act(async () => {});
    expect(screen.getByText(/apa-apa sukan/)).toBeTruthy();
  });
});

describe("a place in a queue", () => {
  it("says nothing when you are not waiting for anything", async () => {
    fetchMock.mockImplementation(async () => json({ entries: [] }));
    const { container } = show(<MyWaitlist phone="0191234567" />);
    await act(async () => {});
    expect(container.textContent).toBe("");
  });

  it("offers the claim link, with how long is left", async () => {
    fetchMock.mockImplementation(async () =>
      json({
        entries: [
          {
            id: 4,
            label: "Yoga Flow",
            status: "offered",
            offerToken: "tok123",
            expiresInSeconds: 300,
          },
        ],
      })
    );
    show(<MyWaitlist phone="0191234567" />);
    await act(async () => {});
    expect(screen.getByText(/5 min left/)).toBeTruthy();
    expect(screen.getByRole("link", { name: "Claim place" }).getAttribute("href")).toBe(
      "/waitlist/tok123"
    );
  });

  it("offers to leave a queue you are only waiting in", async () => {
    fetchMock.mockImplementation(async () =>
      json({ entries: [{ id: 4, label: "Yoga Flow", status: "waiting" }] })
    );
    show(<MyWaitlist phone="0191234567" />);
    await act(async () => {});
    expect(screen.getByText("Waiting for a place")).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Claim place" })).toBeNull();
    expect(screen.getByRole("button", { name: "Leave" })).toBeTruthy();
  });

  it("asks before taking you out of the queue", async () => {
    fetchMock.mockImplementation(async () =>
      json({ entries: [{ id: 4, label: "Yoga Flow", status: "waiting" }] })
    );
    const confirm = vi.fn(() => false);
    vi.stubGlobal("confirm", confirm);
    show(<MyWaitlist phone="0191234567" />);
    await act(async () => {});
    await act(async () => screen.getByRole("button", { name: "Leave" }).click());
    expect(confirm).toHaveBeenCalled();
    expect(fetchMock.mock.calls.filter((c) => c[1]?.method === "DELETE")).toHaveLength(0);
  });
});
