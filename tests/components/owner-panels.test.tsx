// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

import { IntegrityCheck } from "../../src/components/admin/IntegrityCheck";
import { PlayerReportsPanel } from "../../src/components/admin/PlayerReportsPanel";
import { LanguageProvider } from "../../src/components/Language";

/**
 * Two things the platform owner could do only through the API: look over
 * reports players made about each other, and ask now whether bookings and
 * the court time they hold agree.
 */

let fetchMock: ReturnType<typeof vi.fn>;
const json = (body: unknown, ok = true, status = ok ? 200 : 400) => ({ ok, status, json: async () => body });

beforeEach(() => {
  fetchMock = vi.fn(async () => json({}));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const report = (id: number, over = {}) => ({
  id,
  reason: "abuse",
  note: "Shouted at everybody.",
  status: "open",
  createdAt: "2026-10-20 10:00:00",
  reporter: { id: 2, name: "Aisyah Rahman", email: "aisyah@example.my" },
  reported: { id: 3, name: "Boon Keat", email: "boon@example.my", reports: 2 },
  gameId: 17,
  ...over,
});

const urls = () => fetchMock.mock.calls.map(([u]) => String(u));

describe("the player reports panel", () => {
  it("lists the open reports with who, about whom, why and the note", async () => {
    fetchMock.mockImplementation(async () => json({ reports: [report(5)] }));
    render(<PlayerReportsPanel />);
    await act(async () => {});
    expect(urls()[0]).toBe("/api/admin/player-reports?status=open");
    expect(screen.getByText("Abusive")).toBeTruthy();
    expect(screen.getByText("About Boon Keat (boon@example.my) · reports about them in all: 2")).toBeTruthy();
    expect(screen.getByText(/From Aisyah Rahman \(aisyah@example\.my\)/)).toBeTruthy();
    expect(screen.getByText(/Game 17/)).toBeTruthy();
    expect(screen.getByText("Shouted at everybody.")).toBeTruthy();
    expect(screen.getByText("· 1 open")).toBeTruthy();
  });

  it("marks one reviewed through the route, and it leaves the open list", async () => {
    fetchMock.mockImplementation(async (_u: string, init?: RequestInit) =>
      init?.method === "POST" ? json({ ok: true }) : json({ reports: [report(5), report(4, { reason: "no_show", note: null })] })
    );
    render(<PlayerReportsPanel />);
    await act(async () => {});
    const buttons = screen.getAllByText("Mark reviewed");
    expect(buttons).toHaveLength(2);
    await act(async () => {
      fireEvent.click(buttons[0]);
    });
    const post = fetchMock.mock.calls.find(([, init]) => (init as RequestInit | undefined)?.method === "POST")!;
    expect(post[0]).toBe("/api/admin/player-reports");
    expect(JSON.parse(String((post[1] as RequestInit).body))).toEqual({ id: 5 });
    expect(screen.queryByText("Abusive")).toBeNull();
    expect(screen.getByText("Did not come")).toBeTruthy();
    expect(screen.getAllByText("Mark reviewed")).toHaveLength(1);
  });

  it("says why when the route refuses, and keeps a report another owner already reviewed off the open list", async () => {
    fetchMock.mockImplementation(async (_u: string, init?: RequestInit) =>
      init?.method === "POST" ? json({ error: "Not found, or already reviewed." }, false, 404) : json({ reports: [report(5)] })
    );
    render(
      <LanguageProvider locale="ms">
        <PlayerReportsPanel />
      </LanguageProvider>
    );
    await act(async () => {});
    expect(screen.getByText("Kasar atau menghina")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByText("Tandakan disemak"));
    });
    expect(screen.getByText("Tiada laporan di sini.")).toBeTruthy();
    // The server's refusal, in the staff language.
    expect(screen.getByText("Tidak dijumpai, atau sudah disemak.")).toBeTruthy();
    expect(document.body.textContent).not.toContain("Mark reviewed");
  });

  it("keeps a report on the list when marking it fails for another reason", async () => {
    fetchMock.mockImplementation(async (_u: string, init?: RequestInit) =>
      init?.method === "POST" ? json({ error: "Only the platform owner can do that." }, false, 403) : json({ reports: [report(5)] })
    );
    render(<PlayerReportsPanel />);
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByText("Mark reviewed"));
    });
    expect(screen.getByText("Abusive")).toBeTruthy();
    expect(screen.getByText("Only the platform owner can do that.")).toBeTruthy();
  });

  it("reads reviewed ones, or all, and pages back by the last id as the route does", async () => {
    const page = Array.from({ length: 50 }, (_, i) => report(200 - i, { status: "reviewed" }));
    fetchMock.mockImplementation(async (u: string) =>
      json({ reports: String(u).includes("before=151") ? [report(3, { status: "reviewed", reason: "spam" })] : page })
    );
    render(<PlayerReportsPanel />);
    await act(async () => {});
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Reviewed" }));
    });
    expect(urls()).toContain("/api/admin/player-reports?status=reviewed");
    expect(screen.queryByText("Mark reviewed")).toBeNull();
    await act(async () => {
      fireEvent.click(screen.getByText("Show older"));
    });
    expect(urls()).toContain("/api/admin/player-reports?status=reviewed&before=151");
    expect(screen.getByText("Spam")).toBeTruthy();
    // A short page is the last one.
    expect(screen.queryByText("Show older")).toBeNull();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "All" }));
    });
    expect(urls()).toContain("/api/admin/player-reports?");
  });
});

const VENUES = [{ id: 1, name: "Arena MySenam", courts: [] }] as never;

describe("the integrity check", () => {
  it("runs only when asked, and says when everything agrees", async () => {
    fetchMock.mockImplementation(async () => json({ ok: true, problems: [] }));
    render(<IntegrityCheck venues={VENUES} />);
    await act(async () => {});
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => {
      fireEvent.click(screen.getByText("Check now"));
    });
    expect(urls()).toEqual(["/api/admin/integrity"]);
    expect(screen.getByText(/^Everything agrees \(checked at .+\)\.$/)).toBeTruthy();
  });

  it("lists each problem by kind, venue and booking or class, with the server's record of it", async () => {
    fetchMock.mockImplementation(async () =>
      json({
        ok: false,
        problems: [
          { kind: "booking_unheld", venueId: 1, bookingId: 41, detail: "MS-ABC234 on 2026-10-28 holds no court time" },
          { kind: "class_orphaned", venueId: 1, classId: 7, detail: "Junior squad on 2026-10-29 is cancelled but still holds its court" },
          { kind: "refund_overdue", venueId: 0, detail: "12.00 has been owed back on payment bill-1 for over a week" },
        ],
      })
    );
    render(
      <LanguageProvider locale="zh">
        <IntegrityCheck venues={VENUES} />
      </LanguageProvider>
    );
    await act(async () => {
      fireEvent.click(screen.getByText("立即检查"));
    });
    expect(screen.getByText("· 3 个问题")).toBeTruthy();
    expect(screen.getByText("预订未占用场地时间：任何人都可以在其上重复预订")).toBeTruthy();
    expect(screen.getByText("已取消的课程仍占用其场地")).toBeTruthy();
    expect(screen.getByText(/Arena MySenam · 预订 41/)).toBeTruthy();
    expect(screen.getByText(/Arena MySenam · 课程 7/)).toBeTruthy();
    expect(screen.getByText("无场馆")).toBeTruthy();
    expect(screen.getByText("MS-ABC234 on 2026-10-28 holds no court time")).toBeTruthy();
  });

  it("tells a manager that only their own venues are checked, and lists what the server found there", async () => {
    fetchMock.mockImplementation(async () =>
      json({ ok: false, problems: [{ kind: "coach_orphaned", venueId: 1, bookingId: 9, detail: "MS-XYZ on 2026-10-30 is cancelled but still holds its coach" }] })
    );
    render(<IntegrityCheck venues={VENUES} own />);
    expect(screen.getByText("Only your own venues are checked, and only their problems are shown.")).toBeTruthy();
    await act(async () => {
      fireEvent.click(screen.getByText("Check now"));
    });
    expect(urls()).toEqual(["/api/admin/integrity"]);
    expect(screen.getByText("A cancelled lesson still holds its coach")).toBeTruthy();
    expect(screen.getByText(/Arena MySenam · Booking 9/)).toBeTruthy();
  });

  it("does not say so to the platform owner", () => {
    render(<IntegrityCheck venues={VENUES} />);
    expect(screen.queryByText(/Only your own venues/)).toBeNull();
  });

  it("says why when the route refuses (front desk, say)", async () => {
    fetchMock.mockImplementation(async () => json({ error: "Front-desk accounts cannot change this. Ask a manager.", code: "MANAGER_ONLY" }, false, 403));
    render(<IntegrityCheck venues={VENUES} />);
    await act(async () => {
      fireEvent.click(screen.getByText("Check now"));
    });
    expect(screen.getByText("Front-desk accounts cannot change this. Ask a manager.")).toBeTruthy();
  });
});
