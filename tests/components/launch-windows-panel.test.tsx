// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { LaunchWindowsPanel } from "../../src/components/admin/LaunchWindowsPanel";
import type { Court } from "../../src/lib/types";

/**
 * The staff screen for launch and tide windows (ADR 0037): a tide table pasted in is checked row by row and
 * a fault is named by its line; a rule is saved with minutes, not hours; and what a change leaves outside a
 * window is listed, with nothing said to have been cancelled.
 */

let fetchMock: ReturnType<typeof vi.fn>;
const json = (body: unknown, ok = true, status = ok ? 200 : 400) => ({ ok, status, json: async () => body });
const courts = [{ id: 7, name: "Kayaks", sport: "kayak", activities: [] }] as unknown as Court[];
const stranded = {
  kind: "booking",
  ref: "MS-ABC123",
  id: 1,
  date: "2026-11-20",
  startMin: 12 * 60,
  endMin: 13 * 60,
  courtId: 7,
  court: "Kayaks",
  name: "Aina",
  phone: "0123456789",
  why: "LAUNCH_WINDOW",
  windows: [{ start: 430, end: 640 }],
  returnBuffer: 0,
};

beforeEach(() => {
  fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    if (url.startsWith("/api/admin/tides") && init?.method === "POST") {
      const body = JSON.parse(init.body ?? "{}");
      if (String(body.csv).includes("zz"))
        return json({ ok: false, error: "1 row has a fault: nothing was stored.", errors: [{ line: 3, code: "time", vars: { value: "zz" } }], warnings: [], rows: 2 }, false);
      return json({ ok: true, added: 2, changed: 0, unchanged: 0, rows: 2, from: "2026-11-20", until: "2026-11-20", warnings: [], preview: body.preview === true, station: body.station });
    }
    if (url.startsWith("/api/admin/launch-windows")) return json({ rules: [], stations: [], stranded: [stranded], kept: [] });
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("the launch and tide windows screen", () => {
  it("says it is not a forecast or a safety system, and lists what is outside a window without saying it was cancelled", async () => {
    render(<LaunchWindowsPanel venueId={3} courts={courts} />);
    await act(async () => {});
    expect(screen.getByText(/not a safety system/)).toBeTruthy();
    expect(screen.getByText(/never shown to customers as one/)).toBeTruthy();
    const list = screen.getByTestId("launch-stranded");
    expect(list.textContent).toContain("MS-ABC123");
    expect(list.textContent).toContain("Aina");
    expect(list.textContent).toMatch(/None has been cancelled/);
    expect(screen.getByLabelText("Keep MS-ABC123 as booked")).toBeTruthy();
  });

  it("names a faulty row of a pasted table by its line and stores nothing", async () => {
    render(<LaunchWindowsPanel venueId={3} courts={courts} />);
    await act(async () => {});
    fireEvent.change(screen.getByLabelText("Tide table (CSV)"), { target: { value: "date,time,type,height_m\n2026-11-20,zz,high,3" } });
    await act(async () => {
      fireEvent.click(screen.getByText("Check"));
    });
    const faults = screen.getByTestId("tide-faults");
    expect(faults.textContent).toContain("Line 3");
    expect(faults.textContent).toContain("“zz” is not a time");
    expect(screen.getByText("1 row has a fault. Nothing was stored.")).toBeTruthy();
  });

  it("checks a good table without storing it, then imports it", async () => {
    render(<LaunchWindowsPanel venueId={3} courts={courts} />);
    await act(async () => {});
    fireEvent.change(screen.getByLabelText("Tide table (CSV)"), { target: { value: "date,time,type,height_m\n2026-11-20,05:00,low,0.5" } });
    await act(async () => {
      fireEvent.click(screen.getByText("Check"));
    });
    expect(screen.getByText(/Nothing is stored until you import/)).toBeTruthy();
    const posts = () => fetchMock.mock.calls.filter((c) => String(c[0]).startsWith("/api/admin/tides")).map((c) => JSON.parse(c[1].body));
    expect(posts()[0]).toMatchObject({ action: "import", preview: true, times: "venue" });
  });
});

describe("how firmly a window holds (ADR 0046)", () => {
  const rule = (strength: "advisory" | "hard") => ({
    id: 5,
    courtId: 7,
    sport: null,
    source: "weekly",
    weekly: Array.from({ length: 7 }, () => ({ from: 430, to: 640 })),
    station: null,
    tide: null,
    minWindowMin: 0,
    returnBufferMin: 0,
    strength,
  });
  const report = { settings: { enabled: true, reasonMin: 15, weeklyAlert: 5, own: { reasonMin: false, weeklyAlert: false } }, overrides: [], days: 30, alert: null };

  it("says a hard rule is hard, and saves the strength a manager picks (advisory by default)", async () => {
    fetchMock.mockImplementation(async (url: string, init?: { method?: string; body?: string }) => {
      if (url.startsWith("/api/admin/window-overrides")) return json(report);
      if (url.startsWith("/api/admin/launch-windows") && init?.method === "POST") return json({ rule: rule("hard"), stranded: [], kept: [] }, true, 201);
      if (url.startsWith("/api/admin/launch-windows")) return json({ rules: [rule("hard")], stations: [], stranded: [], kept: [] });
      return json({});
    });
    render(<LaunchWindowsPanel venueId={3} courts={courts} />);
    await act(async () => {});
    expect(screen.getByText(/\(hard\)/)).toBeTruthy();
    // The overrides of advisory windows are the manager's, shown where the venue has a rule.
    expect(screen.getByTestId("window-overrides")).toBeTruthy();
    await act(async () => void fireEvent.click(screen.getByRole("button", { name: "Edit the window of Kayaks" })));
    const strength = screen.getByRole("combobox", { name: /How firmly it holds/ }) as HTMLSelectElement;
    expect(strength.value).toBe("hard");
    await act(async () => void fireEvent.change(strength, { target: { value: "advisory" } }));
    await act(async () => void fireEvent.click(screen.getAllByRole("button", { name: "Save" })[0]));
    const saved = fetchMock.mock.calls.filter((c) => String(c[0]).startsWith("/api/admin/launch-windows") && c[1]?.method === "POST").map((c) => JSON.parse(c[1].body));
    expect(saved[0]).toMatchObject({ id: 5, strength: "advisory" });
  });

  it("shows a venue with no rule none of it", async () => {
    render(<LaunchWindowsPanel venueId={3} courts={courts} />);
    await act(async () => {});
    expect(screen.queryByTestId("window-overrides")).toBeNull();
  });
});
