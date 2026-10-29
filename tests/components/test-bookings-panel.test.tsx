// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";

import { GoLiveBanner } from "../../src/components/admin/GoLiveBanner";
import { BranchRequestPanel } from "../../src/components/admin/BusinessPanels";
import { StaffMayProvider } from "../../src/components/admin/StaffMay";

/**
 * X1-16 and X1-15 on screen: test bookings left from setting up are listed on
 * the go-live banner, with a manager's way to clear them all, keep one as
 * real, or clear them as the venue is sent to go live; front desk sees them
 * and cannot act. Adding a branch offers to start from another's set-up.
 * R10A: where a counter payment is on one, clearing asks whether real money
 * was taken, with no answer chosen, and sends it.
 */

let fetchMock: ReturnType<typeof vi.fn>;
let posts: { url: string; body: Record<string, unknown> }[];
const json = (body: unknown) => ({ ok: true, status: 200, headers: new Headers({ "content-type": "application/json" }), json: async () => body, text: async () => JSON.stringify(body) });
const UNPAID: { code: string; date: string; startHour: number; endHour: number; courtName: string; name: string; paymentStatus: string; paidVia: string | null; counterPaid: boolean }[] = [
  { code: "TST001", date: "2026-11-02", startHour: 10, endHour: 11, courtName: "Court 1", name: "Tess", paymentStatus: "unpaid", paidVia: null, counterPaid: false },
  { code: "TST002", date: "2026-11-03", startHour: 18, endHour: 19, courtName: "Court 2", name: "Real Regular", paymentStatus: "unpaid", paidVia: null, counterPaid: false },
];
const WITH_CASH = [{ ...UNPAID[0], paymentStatus: "paid", paidVia: "cash", counterPaid: true }, UNPAID[1]];
let TESTS = UNPAID;

beforeEach(() => {
  posts = [];
  TESTS = UNPAID;
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

describe("a counter payment on a test booking", () => {
  it("asks whether real money was taken, with no answer chosen, and clearing waits for it", async () => {
    TESTS = WITH_CASH;
    render(<GoLiveBanner venueId={7} refreshKey="x" onChange={() => {}} live />);
    await act(async () => {});
    const none = screen.getByRole("radio", { name: /No: they were only a try-out/ }) as HTMLInputElement;
    const real = screen.getByRole("radio", { name: /Yes: real money was taken at the counter/ }) as HTMLInputElement;
    expect(none.checked).toBe(false);
    expect(real.checked).toBe(false);
    const clear = screen.getByRole("button", { name: "Clear all test bookings" }) as HTMLButtonElement;
    expect(clear.disabled).toBe(true);
    await act(async () => {
      fireEvent.click(real);
    });
    expect(clear.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(clear);
    });
    expect(posts[0]).toEqual({ url: "/api/admin/test-bookings", body: { venueId: 7, action: "clear", moneyTaken: "real" } });
    expect(screen.getByText(/Money taken at the counter is owed back/)).toBeTruthy();
  });

  it("sending the venue to go live and clearing carries the same answer, and waits for it", async () => {
    TESTS = WITH_CASH;
    render(<GoLiveBanner venueId={7} refreshKey="x" onChange={() => {}} />);
    await act(async () => {});
    // The banner's own question is only asked once the venue's tests are to be cleared as it is sent.
    expect(screen.getAllByRole("radio")).toHaveLength(2);
    fireEvent.click(screen.getByLabelText("Also clear my 2 test bookings"));
    expect(screen.getAllByRole("radio")).toHaveLength(4);
    const ask = screen.getByRole("button", { name: "Ask to go live" }) as HTMLButtonElement;
    expect(ask.disabled).toBe(true);
    fireEvent.click(screen.getAllByRole("radio", { name: /No: they were only a try-out/ })[0]);
    expect(ask.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(ask);
    });
    expect(posts[0]).toEqual({ url: "/api/admin/go-live", body: { venueId: 7, clearTests: true, moneyTaken: "none" } });
  });

  it("is not asked where nothing was paid at the counter, and the front desk is shown no question", async () => {
    render(<GoLiveBanner venueId={7} refreshKey="x" onChange={() => {}} live />);
    await act(async () => {});
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
    cleanup();
    TESTS = WITH_CASH;
    render(
      <StaffMayProvider may={{ testBookings: false, goLive: false }}>
        <GoLiveBanner venueId={7} refreshKey="x" onChange={() => {}} />
      </StaffMayProvider>
    );
    await act(async () => {});
    expect(screen.queryAllByRole("radio")).toHaveLength(0);
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
