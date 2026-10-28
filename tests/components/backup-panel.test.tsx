// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";

import { VenuesTab } from "../../src/components/admin/VenuesTab";
import { LanguageProvider } from "../../src/components/Language";
import type { Admin } from "../../src/lib/admin-auth";

/**
 * The Backups panel on the platform owner's Venues tab (lib/backup-health.ts,
 * GET /api/admin/backup): one state for the backups with how old the newest
 * copy that would survive losing the server is, what is wrong, where off-site
 * copies go and what the address itself names, each set whole or not, and a
 * backup taken by hand. Shown to the platform owner only, as the route allows
 * (whole-database copies are not a venue's).
 */

type Backups = Record<string, unknown>;
let backups: Backups;
let take: { status: number; body: unknown };
let calls: { url: string; method: string }[];

const OWNER = { id: 1, name: "Owner", email: "owner@mysenam.my", venueId: null, businessId: null, businessName: null, venueIds: null, role: "manager" } as Admin;
const DESK = { ...OWNER, id: 2, venueId: 3, venueIds: [3], role: "desk" } as Admin;
const MANAGER = { ...OWNER, id: 3, venueId: null, businessId: 9, businessName: "Arena Group", venueIds: [3, 4] } as Admin;

const HEALTHY: Backups = {
  backups: [
    { name: "mysenam-2026-10-27T0300.dump", bytes: 2_150_400, takenAt: "2026-10-27 03:00", complete: true },
    { name: "mysenam-2026-10-26T0300.dump", bytes: 2_048_000, takenAt: "2026-10-26 03:00", complete: false },
  ],
  directory: "/var/lib/mysenam/backups",
  database: "postgres://db.internal/mysenam",
  hoursSinceLast: 5.4,
  offsite: {
    configured: true,
    destination: "s3://mysenam-backups/kl",
    location: "Malaysia",
    endpointSays: { provider: "Backblaze B2", region: "us-west-004", country: "United States" },
    paused: null,
    lastCopied: { name: "mysenam-2026-10-27T0300.dump", at: "2026-10-27T03:05:00Z", manifest: true, encrypted: true, signed: true },
    lastError: null,
  },
  health: { state: "ok", rpoHours: 24, recoverableHours: 5.4, offsite: "active", problems: [] },
  schedule: { hour: 3 },
};

beforeEach(() => {
  backups = HEALTHY;
  take = { status: 200, body: {} };
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({ url, method });
      const reply =
        url === "/api/admin/backup" ? (method === "POST" ? take : { status: 200, body: backups }) : { status: 404, body: {} };
      return { ok: reply.status < 300, status: reply.status, json: async () => reply.body };
    })
  );
});
afterEach(() => vi.unstubAllGlobals());

async function tab(admin: Admin = OWNER, locale?: "ms") {
  const ui = <VenuesTab admin={admin} venues={[]} onChange={async () => admin} />;
  render(locale ? <LanguageProvider locale={locale}>{ui}</LanguageProvider> : ui);
  await act(async () => {});
}

const panel = () => screen.getByRole("heading", { name: "Backups" }).closest("section")!;

describe("the Backups panel", () => {
  it("says the backups are active, how old the newest surviving copy is against the target, and when they run", async () => {
    await tab();
    const p = panel();
    expect(within(p).getByTestId("backup-health").textContent).toBe(
      "Backups: active · the newest copy that would survive losing this server is 5 hours old (target: under 24)"
    );
    expect(within(p).getByText("Newest backup 5 hours old")).toBeTruthy();
    // The install's hour, written as the staff language writes a time (lib/region.ts).
    expect(within(p).getByText(/taken automatically every night at 3:00 AM/)).toBeTruthy();
  });

  it("names where off-site copies go, what the storage address itself names, and how the last set left", async () => {
    await tab();
    const text = panel().textContent!;
    expect(text).toContain("Off-site to s3://mysenam-backups/kl (data kept in Malaysia)");
    // The declared country and the one the address names, side by side, so a mismatch shows.
    expect(text).toContain("the address names Backblaze B2 us-west-004 (United States)");
    expect(text).toContain(", whole with its manifest, encrypted before it left, manifest signed");
  });

  it("marks each backup set whole or not", async () => {
    await tab();
    const rows = within(panel()).getAllByRole("row").slice(1);
    expect(rows.map((r) => [...r.querySelectorAll("td")].map((td) => td.textContent))).toEqual([
      ["2026-10-27 3:00 AM", "mysenam-2026-10-27T0300.dump", "2100 KB", "Whole"],
      ["2026-10-26 3:00 AM", "mysenam-2026-10-26T0300.dump", "2000 KB", "No manifest or a part missing"],
    ]);
  });

  it("says plainly when nothing leaves the server, and lists what is wrong", async () => {
    backups = {
      ...HEALTHY,
      hoursSinceLast: 60,
      offsite: { configured: false, destination: null, lastCopied: null, lastError: null },
      health: {
        state: "local_only",
        rpoHours: 24,
        recoverableHours: null,
        offsite: "off",
        problems: ["No off-site copies: losing this server loses every backup."],
      },
      schedule: null,
    };
    await tab();
    const p = panel();
    const health = within(p).getByTestId("backup-health");
    expect(health.textContent).toContain("Backups: on this server only");
    expect(health.textContent).not.toContain("would survive");
    expect(within(health).getByText("No off-site copies: losing this server loses every backup.")).toBeTruthy();
    expect(within(p).getByText(/Newest backup 60 hours old — check the schedule is running/)).toBeTruthy();
    expect(p.textContent).toContain("No off-site copies. Every backup is on the same disk as the database.");
    expect(p.textContent).toContain("the built-in schedule is off: run npm run backup from cron");
  });

  it("shows a paused off-site copy with its reason, and a failed one only when newer than the last good copy", async () => {
    backups = {
      ...HEALTHY,
      offsite: { ...(HEALTHY.offsite as object), paused: "the bucket's country is not declared (OFFSITE_DATA_LOCATION)", location: null, endpointSays: null },
      health: { state: "paused", rpoHours: 24, recoverableHours: 30, offsite: "paused", problems: [] },
    };
    await tab();
    expect(panel().textContent).toContain("Paused: the bucket's country is not declared (OFFSITE_DATA_LOCATION)");
    expect(within(panel()).getByTestId("backup-health").textContent).toContain("Off-site copies: paused");
  });

  it("says the last off-site copy failed while no copy has gone since", async () => {
    backups = {
      ...HEALTHY,
      offsite: { ...(HEALTHY.offsite as object), lastError: { at: "2026-10-27T04:00:00Z", error: "403 Forbidden" } },
      health: { state: "failing", rpoHours: 24, recoverableHours: 25, offsite: "failing", problems: [] },
    };
    await tab();
    expect(panel().textContent).toContain("The last copy failed: 403 Forbidden");
    cleanup();
    // An older failure, since put right, is not news.
    backups = { ...HEALTHY, offsite: { ...(HEALTHY.offsite as object), lastError: { at: "2026-10-26T04:00:00Z", error: "timeout" } } };
    await tab();
    expect(panel().textContent).not.toContain("The last copy failed");
  });

  it("takes a backup by hand, says what it took and that it was copied off-site, and reads the panel again", async () => {
    take = {
      status: 200,
      body: { file: { name: "mysenam-2026-10-27T1012.dump", bytes: 2_252_800 }, bookings: 812, pruned: ["old-1", "old-2"], offsite: { ok: true } },
    };
    await tab();
    await act(async () => {
      fireEvent.click(within(panel()).getByRole("button", { name: "Back up now" }));
    });
    expect(calls.filter((c) => c.url === "/api/admin/backup").map((c) => c.method)).toEqual(["GET", "POST", "GET"]);
    expect(within(panel()).getByText("mysenam-2026-10-27T1012.dump — 2200 KB, 812 bookings. Retired 2 older. Copied off-site.")).toBeTruthy();
  });

  it("says why a backup by hand failed", async () => {
    take = { status: 500, body: { error: "pg_dump is not installed on this server." } };
    await tab();
    await act(async () => {
      fireEvent.click(within(panel()).getByRole("button", { name: "Back up now" }));
    });
    expect(within(panel()).getByText(/pg_dump is not installed on this server\./)).toBeTruthy();
  });

  it("says when no backup has ever been taken", async () => {
    backups = { ...HEALTHY, backups: [], hoursSinceLast: null, health: { state: "none", rpoHours: 24, recoverableHours: null, offsite: "active", problems: [] } };
    await tab();
    expect(within(panel()).getByText("No backup has ever been taken.")).toBeTruthy();
    expect(within(panel()).getByTestId("backup-health").textContent).toBe("Backups: none yet");
    expect(panel().textContent).toContain("Nothing here yet.");
  });

  it("is in the owner's language", async () => {
    await tab(OWNER, "ms");
    expect(screen.getByText("Sandaran: aktif", { exact: false })).toBeTruthy();
  });

  it("is not shown to a venue's front desk or a business's manager, nor asked for", async () => {
    for (const admin of [DESK, MANAGER]) {
      await tab(admin);
      expect(screen.queryByRole("heading", { name: "Backups" })).toBeNull();
      expect(calls.some((c) => c.url === "/api/admin/backup")).toBe(false);
      cleanup();
    }
  });
});
