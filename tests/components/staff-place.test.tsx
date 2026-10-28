// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { REFRESH_MS, UpdatedNote, useAddressed, useAutoRefresh, useTabInAddress } from "../../src/components/admin/place";
import { ScheduleTab } from "../../src/components/admin/ScheduleTab";
import { LeaguesTab } from "../../src/components/admin/LeaguesTab";
import { TournamentsTab } from "../../src/components/admin/TournamentsTab";

/**
 * The staff dashboard keeps its place in the address (audit R8 X2-13), the
 * day list and the schedule read themselves again while open (X2-14), and a
 * list that could not be read says so rather than "None yet" (X2-7).
 */

const TABS = ["bookings", "schedule", "reports"] as const;
type Tab = (typeof TABS)[number];

function Tabs() {
  const [tab, setTab] = useTabInAddress<Tab>(TABS, "bookings");
  return (
    <div>
      <p data-testid="tab">{tab}</p>
      {TABS.map((t) => (
        <button key={t} onClick={() => setTab(t)} aria-current={tab === t ? "page" : undefined}>
          {t}
        </button>
      ))}
    </div>
  );
}

function Venue({ ids }: { ids: number[] }) {
  const [venue, setVenue] = useAddressed("venue", ids[0], (id) => ids.includes(id));
  return (
    <button data-testid="venue" onClick={() => setVenue(ids[ids.length - 1])}>
      {venue}
    </button>
  );
}

const go = (path: string) => window.history.replaceState(null, "", path);

beforeEach(() => go("/admin"));
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("the dashboard's place in its address", () => {
  it("opens on the tab in the address, adds a step for each tab, and Back returns", async () => {
    go("/admin?tab=schedule");
    render(<Tabs />);
    expect(screen.getByTestId("tab").textContent).toBe("schedule");
    expect(screen.getByRole("button", { name: "schedule" }).getAttribute("aria-current")).toBe("page");
    await act(async () => screen.getByRole("button", { name: "reports" }).click());
    expect(window.location.search).toBe("?tab=reports");
    await act(async () => {
      window.history.back();
      await new Promise((r) => setTimeout(r, 20));
    });
    expect(screen.getByTestId("tab").textContent).toBe("schedule");
  });

  it("a tab that is not one opens on the first", () => {
    go("/admin?tab=nonsense");
    render(<Tabs />);
    expect(screen.getByTestId("tab").textContent).toBe("bookings");
  });

  it("keeps a venue in the address, only one this account manages, without adding steps", async () => {
    go("/admin?tab=schedule&venue=9");
    render(<Venue ids={[3, 9]} />);
    expect(screen.getByTestId("venue").textContent).toBe("9");
    const steps = window.history.length;
    go("/admin?tab=schedule&venue=3");
    await act(async () => screen.getByTestId("venue").click());
    expect(new URLSearchParams(window.location.search).get("venue")).toBe("9");
    expect(new URLSearchParams(window.location.search).get("tab")).toBe("schedule");
    expect(window.history.length).toBe(steps);
  });

  it("ignores a venue in the address the account does not manage", () => {
    go("/admin?venue=42");
    render(<Venue ids={[3, 9]} />);
    expect(screen.getByTestId("venue").textContent).toBe("3");
  });
});

describe("a screen that keeps itself up to date", () => {
  function Refreshing({ load }: { load: () => void }) {
    const { updatedAt } = useAutoRefresh(load);
    return <UpdatedNote at={updatedAt} />;
  }

  it("reads again every minute while visible, not while hidden, and at once on coming back", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
    let visibility: DocumentVisibilityState = "visible";
    vi.spyOn(document, "visibilityState", "get").mockImplementation(() => visibility);
    const load = vi.fn();
    render(<Refreshing load={load} />);
    expect(load).not.toHaveBeenCalled();
    await act(async () => void vi.advanceTimersByTime(REFRESH_MS));
    expect(load).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("updated-note").textContent).toMatch(/^Updated /);

    visibility = "hidden";
    await act(async () => void vi.advanceTimersByTime(REFRESH_MS * 3));
    expect(load).toHaveBeenCalledTimes(1);

    visibility = "visible";
    await act(async () => void document.dispatchEvent(new Event("visibilitychange")));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("the schedule reads the venue and day from the address, refreshes, and keeps what is being typed", async () => {
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    go("/admin?tab=schedule&venue=2&date=2030-01-08");
    const fetchMock = vi.fn(async (_url: string) => ({ ok: true, status: 200, json: async () => ({ courts: [] }) }));
    vi.stubGlobal("fetch", fetchMock);
    render(<ScheduleTab venues={[{ id: 1, name: "One", courts: [] }, { id: 2, name: "Two", courts: [] }] as never} />);
    await act(async () => void (await Promise.resolve()));
    const slotReads = () => fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.startsWith("/api/admin/slots"));
    expect(slotReads()).toEqual(["/api/admin/slots?venueId=2&date=2030-01-08"]);
    fireEvent.change(screen.getByLabelText(/reason/i), { target: { value: "Floor repair" } });
    await act(async () => void vi.advanceTimersByTime(REFRESH_MS));
    expect(slotReads()).toHaveLength(2);
    expect((screen.getByLabelText(/reason/i) as HTMLInputElement).value).toBe("Floor repair");
    // A change of day goes into the address.
    fireEvent.change(screen.getByLabelText("Date"), { target: { value: "2030-01-09" } });
    expect(new URLSearchParams(window.location.search).get("date")).toBe("2030-01-09");
  });
});

describe("a list that could not be read", () => {
  const venues = [{ id: 1, name: "Arena", courts: [] }] as never;
  const proxyPage = { ok: false, status: 502, json: async () => JSON.parse("<html>502</html>") };

  it("leagues: says so with Try again, never None yet", async () => {
    let fail = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => (fail ? proxyPage : { ok: true, status: 200, json: async () => ({ leagues: [], templates: [] }) }))
    );
    render(<LeaguesTab venues={venues} />);
    await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
    expect(screen.getByRole("alert").textContent).toContain("The site did not answer properly");
    expect(screen.queryByText("None yet. Set one up below.")).toBeNull();
    fail = false;
    await act(async () => screen.getByRole("button", { name: "Try again" }).click());
    await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
    expect(screen.queryByRole("button", { name: "Try again" })).toBeNull();
  });

  it("tournaments: the same", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => proxyPage));
    render(<TournamentsTab venues={venues} />);
    await act(async () => void (await new Promise((r) => setTimeout(r, 0))));
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(screen.queryByText(/None yet/)).toBeNull();
  });
});
