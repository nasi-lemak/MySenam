// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, render, screen } from "@testing-library/react";

import { GoLiveBanner } from "../../src/components/admin/GoLiveBanner";
import { SetupChecklist } from "../../src/components/admin/SetupChecklist";

/**
 * A draft venue's checklist and go-live banner tick off what was saved under
 * Venue details at once. Saving there changes no tab and no court count, so
 * before the "setup:refresh" event they kept saying the hours still needed
 * checking (found by the Venue 1 acceptance scenario).
 */

let fetchMock: ReturnType<typeof vi.fn>;
const json = (body: unknown) => ({ ok: true, json: async () => body });

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const setup = (detailsChecked: boolean) => ({
  venueId: 7,
  courts: 1,
  detailsChecked,
  testBooking: false,
  onlinePayment: false,
  photos: false,
  facilities: false,
  dismissed: false,
  complete: false,
});

describe("after something is saved under Venue details", () => {
  it("the set-up checklist reads itself again and ticks the hours off", async () => {
    let checked = false;
    fetchMock.mockImplementation(async () => json(setup(checked)));
    render(<SetupChecklist venueId={7} refreshKey="venues:1" onGo={() => {}} />);
    await act(async () => {});
    expect(screen.getByText("2 steps to go")).toBeTruthy();

    checked = true;
    await act(async () => {
      window.dispatchEvent(new Event("setup:refresh"));
    });
    expect(screen.getByText("1 step to go")).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("the go-live banner reads itself again: a pin put down is no longer missing", async () => {
    let missing = ["Pin the venue on the map."];
    fetchMock.mockImplementation(async () => json({ state: "draft", suspension: null, request: { status: "draft", reason: null }, missing }));
    render(<GoLiveBanner venueId={7} refreshKey="venues:1" onChange={() => {}} />);
    await act(async () => {});
    expect(screen.getByText("Pin the venue on the map.")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Ask to go live" }) as HTMLButtonElement).disabled).toBe(true);

    missing = [];
    await act(async () => {
      window.dispatchEvent(new Event("setup:refresh"));
    });
    expect(screen.queryByText("Pin the venue on the map.")).toBeNull();
    expect((screen.getByRole("button", { name: "Ask to go live" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("stops listening once it is gone", async () => {
    fetchMock.mockImplementation(async () => json(setup(false)));
    const { unmount } = render(<SetupChecklist venueId={7} refreshKey="venues:1" onGo={() => {}} />);
    await act(async () => {});
    unmount();
    window.dispatchEvent(new Event("setup:refresh"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
