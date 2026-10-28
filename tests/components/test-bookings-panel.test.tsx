// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { GoLiveBanner } from "../../src/components/admin/GoLiveBanner";
import { BranchRequestPanel } from "../../src/components/admin/BusinessPanels";
import { StaffMayProvider } from "../../src/components/admin/StaffMay";

/**
 * X1-16 and X1-15 on screen: test bookings left from setting up are listed on
 * the go-live banner, with a manager's way to clear them all, keep one as
 * real, or clear them as the venue is sent to go live; front desk sees them
 * and cannot act. Adding a branch offers to start from another's set-up.
 */

let fetchMock: ReturnType<typeof vi.fn>;
let posts: { url: string; body: Record<string, unknown> }[];
const json = (body: unknown) => ({ ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => body, text: async () => JSON.stringify(body) });
const TESTS = [
  { code: "TST001", date: "2026-11-02", startHour: 10, endHour: 11, courtName: "Court 1", name: "Tess" },
  { code: "TST002", date: "2026-11-03", startHour: 18, endHour: 19, courtName: "Court 2", name: "Real Regular" },
];

beforeEach(() => {
  posts = [];
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      posts.push({ url, body });
      if (url === "/api/admin/go-live") return json({ live: false, status: { state: "draft", suspension: null, request: { status: "pending", reason: null }, missing: [] }, cleared: { done: ["TST001", "TST002"], refused: [] } });
      return json({ done: body.action === "keep" ? body.codes : ["TST001", "TST002"], refused: [] });
    }
    if (url.startsWith("/api/admin/test-bookings")) return json({ live: false, bookings: TESTS });
    if (url.startsWith("/api/admin/go-live")) return json({ state: "draft", suspension: null, request: { status: "draft", reason: null }, missing: [] });
    return json({ requests: [] });
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("confirm", () => true);
});
afterEach(() => vi.unstubAllGlobals());

describe("test bookings on the go-live banner", () => {
  it("a live venue's are listed; a manager keeps one as real and clears the rest, nobody messaged", async () => {
    render(<GoLiveBanner venueId={7} refreshKey="x" onChange={() => {}} live />);
    await act(async () => {});
    expect(screen.getByText("2 test bookings from setting up")).toBeTruthy();
    // A live venue's banner asks nothing of the platform owner.
    expect(fetchMock.mock.calls.some(([u]) => String(u).startsWith("/api/admin/go-live"))).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Show them" }));
    expect(screen.getByText("TST002")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getAllByRole("button", { name: "Keep as real" })[1]);
    });
    expect(posts[0]).toEqual({ url: "/api/admin/test-bookings", body: { venueId: 7, action: "keep", codes: ["TST002"] } });
    expect(screen.getByText("Kept as a real booking.")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Clear all test bookings" }));
    });
    expect(posts[1].body).toEqual({ venueId: 7, action: "clear" });
    expect(screen.getByText("2 test bookings cleared.")).toBeTruthy();
  });

  it("front desk sees them and is offered nothing to press", async () => {
    render(
      <StaffMayProvider may={{ testBookings: false, goLive: false }}>
        <GoLiveBanner venueId={7} refreshKey="x" onChange={() => {}} />
      </StaffMayProvider>
    );
    await act(async () => {});
    expect(screen.getByText("2 test bookings from setting up")).toBeTruthy();
    expect((screen.getByRole("button", { name: "Clear all test bookings" }) as HTMLButtonElement).closest("fieldset")?.disabled).toBe(true);
    expect(screen.queryByRole("button", { name: "Ask to go live" })).toBeNull();
    expect(screen.queryByLabelText("Also clear my 2 test bookings")).toBeNull();
  });

  it("sending the venue to go live offers to clear them, unticked until asked", async () => {
    render(<GoLiveBanner venueId={7} refreshKey="x" onChange={() => {}} />);
    await act(async () => {});
    const box = screen.getByLabelText("Also clear my 2 test bookings") as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Ask to go live" }));
    });
    expect(posts[0]).toEqual({ url: "/api/admin/go-live", body: { venueId: 7, clearTests: true } });
  });
});

describe("adding a branch", () => {
  it("offers to start from one of the business's branches, and says what is copied", async () => {
    render(<BranchRequestPanel businessName="Copy Courts" branches={[{ id: 3, name: "Ampang" }]} onChange={() => {}} />);
    await act(async () => {});
    const from = screen.getByLabelText("Start from") as HTMLSelectElement;
    expect([...from.options].map((o) => o.textContent)).toEqual(["Nothing: a blank branch", "Ampang's set-up"]);
    expect(screen.queryByText(/Never bookings, customers/)).toBeNull();
    fireEvent.change(from, { target: { value: "3" } });
    expect(screen.getByText(/Never bookings, customers/)).toBeTruthy();
  });
});
