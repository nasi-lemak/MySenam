// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { AccountsPanel } from "../../src/components/admin/AccountsPanel";
import type { ManagedVenue } from "../../src/components/admin/shared";

/**
 * Credit waiting on a company or school account, paid back by hand: the
 * accounts screen lists a closed account while credit waits on it (and
 * nothing else to do on it), and a manager records the payment with what
 * they wrote down, after which the screen reloads.
 */

let fetchMock: ReturnType<typeof vi.fn>;
let posted: Record<string, unknown> | null;
const json = (body: unknown, ok = true, status = ok ? 200 : 400) => ({ ok, status, json: async () => body });
const account = (over: Record<string, unknown>) => ({
  id: 1,
  venueId: 3,
  name: "SK Tutup",
  contact: null,
  email: "sk@school.test",
  address: null,
  taxNo: null,
  termsDays: 30,
  creditLimit: null,
  locale: "en",
  bookers: [],
  uninvoiced: 0,
  owing: 0,
  credit: 10,
  closed: true,
  ...over,
});

beforeEach(() => {
  posted = null;
  fetchMock = vi.fn(async (url: string, init?: { method?: string; body?: string }) => {
    if (url === "/api/admin/accounts/credits" && init?.method === "POST") {
      posted = JSON.parse(init.body ?? "{}");
      return json({ amount: 10, account: account({ credit: 0 }) });
    }
    if (url.startsWith("/api/admin/accounts?venueId=")) return json({ accounts: [account(posted ? { credit: 0 } : {})], invoices: [], languages: ["en"] });
    return json({});
  });
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const venues = [{ id: 3, name: "Credit Pool", courts: [] }] as unknown as ManagedVenue[];

describe("an account's credit paid back by hand", () => {
  it("a closed account shows its credit and the way to record it paid back, and nothing else", async () => {
    vi.stubGlobal("prompt", vi.fn(() => "DuitNow ref 8812"));
    render(<AccountsPanel venues={venues} />);
    await act(async () => {});
    expect(screen.getByText("closed")).toBeTruthy();
    expect(screen.queryByText(/Invoice /)).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Paid back by hand" }));
    });
    expect(posted).toEqual({ venueId: 3, accountId: 1, note: "DuitNow ref 8812" });
    expect(screen.getByText(/Recorded RM10(\.00)? paid back to SK Tutup by hand/)).toBeTruthy();
  });

  it("asks first, and sends nothing when the manager thinks again", async () => {
    vi.stubGlobal("prompt", vi.fn(() => null));
    render(<AccountsPanel venues={venues} />);
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Paid back by hand" }));
    });
    expect(posted).toBeNull();
  });
});
