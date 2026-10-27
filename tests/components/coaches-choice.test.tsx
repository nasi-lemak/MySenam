// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { CoachesPanel } from "../../src/components/admin/CoachesPanel";
import type { ManagedVenue } from "../../src/components/admin/shared";

/**
 * The venue's setting for who chooses the coach of a new lesson
 * (lib/lesson-coaches.ts): shown as saved, and changed by a manager.
 */

let fetchMock: ReturnType<typeof vi.fn>;
let saved: Record<string, unknown>[];
let refuse = false;

beforeEach(() => {
  saved = [];
  refuse = false;
  fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    if (init?.method === "POST") {
      const body = JSON.parse(init.body ?? "{}");
      saved.push(body);
      if (refuse) return { ok: false, json: async () => ({ error: "Front-desk accounts cannot change this. Ask a manager.", code: "MANAGER_ONLY" }) };
      return { ok: true, json: async () => ({ choice: body.choice }) };
    }
    return { ok: true, json: async () => ({ coaches: [], contacts: {}, choice: url.includes("venueId=2") ? "venue" : "customer" }) };
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const venue = (id: number) => ({ id, name: "Club", courts: [{ id: 1, sport: "tennis", activities: [] }] }) as unknown as ManagedVenue;

describe("who chooses the coach", () => {
  it("shows the venue's setting, and saves a change", async () => {
    render(<CoachesPanel venue={venue(1)} />);
    await act(async () => {});
    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe("customer");
    expect(screen.getByText(/the one with the fewest lessons that day/)).toBeTruthy();
    await act(async () => {
      fireEvent.change(select, { target: { value: "venue" } });
    });
    expect(saved).toEqual([{ venueId: 1, action: "choice", choice: "venue" }]);
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("venue");
  });

  it("reads the venue's own setting, and says why a change was refused", async () => {
    refuse = true;
    render(<CoachesPanel venue={venue(2)} />);
    await act(async () => {});
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("venue");
    await act(async () => {
      fireEvent.change(screen.getByRole("combobox"), { target: { value: "customer" } });
    });
    expect(screen.getByText(/Ask a manager/)).toBeTruthy();
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("venue");
  });
});
