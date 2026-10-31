// @vitest-environment jsdom
/// <reference types="vite/client" />
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ReactElement } from "react";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, ensureBootstrapAdmin, listAdmins, type Admin } from "../../src/lib/admin-auth";
import { seedDemoData } from "../../src/lib/demo";
import { getDb } from "../../src/lib/db";
import { staffMay, type StaffRole } from "../../src/lib/roles";
import { listVenuesByIds } from "../../src/lib/store";
import { forgetStaffRole } from "../../src/components/admin/useStaffRole";
import { StaffMayProvider } from "../../src/components/admin/StaffMay";
import { StaffZones } from "../../src/components/admin/StaffLanguage";
import type { ManagedVenue } from "../../src/components/admin/shared";
import { CourtsTab } from "../../src/components/admin/CourtsTab";
import { CreditTab } from "../../src/components/admin/CreditTab";
import { VenuesTab } from "../../src/components/admin/VenuesTab";
import { type HelpPlaceId } from "../../src/lib/guide/help";

/**
 * Where the "?" is on the real screens, against the app's own routes and a
 * database filled with the demonstration fortnight (as
 * desk-sees-what-it-may.test.tsx runs the tabs): each tab as a manager has the
 * tips for what it explains, none has read anything until one is opened, an
 * opened tip is answered by the real topic route for that account's own role,
 * and the front desk is given a tip only where it uses the screen (a tip in a
 * region only a manager changes is inside its read-only fieldset, as the
 * region is), and then the desk's version.
 */

type Handler = (req: NextRequest, ctx?: unknown) => Response | Promise<Response>;
const routes = import.meta.glob("../../src/app/api/**/route.ts");
const table = Object.keys(routes)
  .map((file) => {
    const path = file.replace("../../src/app", "").replace("/route.ts", "");
    const names: string[] = [];
    const re = new RegExp(
      "^" +
        path.replace(/\[([^\]]+)\]/g, (_, name: string) => {
          names.push(name);
          return "([^/]+)";
        }) +
        "$"
    );
    return { file, re, names, dynamic: names.length };
  })
  .sort((a, b) => a.dynamic - b.dynamic);

let deskCookie = "";
let managerCookie = "";
let desk: Admin;
let manager: Admin;
let venues: ManagedVenue[] = [];
let calls: { method: string; path: string; status: number; role?: string }[] = [];
let cookie = "";
let inFlight = 0;

async function settle(): Promise<void> {
  for (let i = 0; i < 400; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 5));
    });
    if (inFlight === 0) {
      await act(async () => {
        await new Promise((r) => setTimeout(r, 5));
      });
      if (inFlight === 0) return;
    }
  }
}

async function serve(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  inFlight++;
  try {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
    const method = (init?.method ?? "GET").toUpperCase();
    const route = table.find((r) => r.re.test(url.pathname));
    if (!route) return new Response(JSON.stringify({ error: "no route" }), { status: 404 });
    const m = route.re.exec(url.pathname)!;
    const params = Object.fromEntries(route.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
    const mod = (await routes[route.file]()) as Record<string, unknown>;
    const handler = mod[method] as Handler | undefined;
    if (!handler) return new Response(JSON.stringify({ error: "method" }), { status: 405 });
    const body = init?.body;
    const req = new NextRequest(url.href, {
      method,
      headers: { cookie, ...(typeof body === "string" ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined && body !== null && method !== "GET" ? { body: body as BodyInit } : {}),
    });
    const res = await handler(req, { params: Promise.resolve(params) });
    let role: string | undefined;
    if (url.pathname === "/api/admin/guide/topic") role = ((await res.clone().json().catch(() => ({}))) as { role?: string }).role;
    calls.push({ method, path: url.pathname, status: res.status, role });
    return res;
  } finally {
    inFlight--;
  }
}

beforeAll(async () => {
  await ensureBootstrapAdmin();
  const owner = (await listAdmins())[0];
  const filled = await seedDemoData({ adminId: owner.id, force: true });
  if (!filled.ok) throw new Error(filled.error);
  const venueId = ((await getDb().prepare("SELECT id FROM venues ORDER BY id LIMIT 1").get()) as { id: number }).id;
  const d = await createAdmin({ name: "Dina Desk", email: "dina@help-screens.my", password: "desk-password-1", venueId, role: "desk" });
  const m = await createAdmin({ name: "Musa Manager", email: "musa@help-screens.my", password: "manager-pass-1", venueId, role: "manager" });
  if (!d.ok || !m.ok) throw new Error("staff");
  desk = d.admin;
  manager = m.admin;
  deskCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.id)).token}`;
  managerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(manager.id)).token}`;
  venues = (await listVenuesByIds([venueId])) as ManagedVenue[];
}, 300_000);

beforeEach(() => {
  calls = [];
  forgetStaffRole();
  vi.stubGlobal("fetch", vi.fn(serve));
  window.history.replaceState(null, "", "/admin?tab=courts");
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
afterAll(() => undefined);

async function show(role: StaffRole, ui: (admin: Admin) => ReactElement): Promise<HTMLElement> {
  cookie = role === "desk" ? deskCookie : managerCookie;
  const admin = role === "desk" ? desk : manager;
  const { container } = render(
    <StaffMayProvider may={staffMay(role)}>
      <StaffZones venues={venues}>{ui(admin)}</StaffZones>
    </StaffMayProvider>
  );
  await settle();
  return container;
}

const placesIn = (container: HTMLElement) => Array.from(container.querySelectorAll<HTMLElement>("[data-help]")).map((el) => el.getAttribute("data-help") as HelpPlaceId);
const topicCalls = () => calls.filter((c) => c.path === "/api/admin/guide/topic");

async function open(container: HTMLElement, place: HelpPlaceId): Promise<HTMLElement> {
  const button = container.querySelector<HTMLElement>(`[data-help="${place}"]`);
  if (!button) throw new Error(`no tip ${place}`);
  await act(async () => fireEvent.click(button));
  await settle();
  return screen.getByRole("dialog");
}

describe("a manager's screens", () => {
  it("courts and rates carry the tips for buffers, shared and linked facilities, peak and dated prices, discounts and approvals, and read nothing until one is opened", async () => {
    const container = await show("manager", () => <CourtsTab venues={venues} onVenuesChange={() => undefined} />);
    const places = placesIn(container);
    for (const place of ["courts.buffers", "courts.links", "courts.peak", "courts.dated", "courts.concessions", "people.approvals"] as const) expect(places, place).toContain(place);
    expect(new Set(places).size).toBe(places.length);
    expect(topicCalls()).toEqual([]);
    // Each is named for its question.
    const buffers = container.querySelector('[data-help="courts.buffers"]')!;
    expect(buffers.getAttribute("aria-label")).toBe("Help: How do booking buffers work?");
    const dialog = await open(container, "courts.buffers");
    expect(within(dialog).getByRole("button", { name: /Open Courts & rates/ })).toBeTruthy();
    expect(topicCalls()).toEqual([{ method: "GET", path: "/api/admin/guide/topic", status: 200, role: "manager" }]);
  });

  it("credit and passes carry the tips for passes, promo codes, memberships and what they cover", async () => {
    const container = await show("manager", () => <CreditTab venues={venues} />);
    const places = placesIn(container);
    for (const place of ["credit.passes", "credit.promos", "credit.memberships", "credit.plans"] as const) expect(places, place).toContain(place);
    expect(topicCalls()).toEqual([]);
    const dialog = await open(container, "credit.plans");
    expect(dialog.textContent).toMatch(/booking|taking part/i);
    expect(topicCalls().map((c) => c.status)).toEqual([200]);
  });

  it("venue details carry the tips for who refunds what, unattended access and guardians", async () => {
    const container = await show("manager", (admin) => <VenuesTab admin={admin} venues={venues} onChange={async () => admin} />);
    const places = placesIn(container);
    for (const place of ["venues.cancellation", "venues.unattended", "people.participants"] as const) expect(places, place).toContain(place);
    const dialog = await open(container, "venues.cancellation");
    expect(dialog.textContent).toMatch(/refund/i);
    expect(topicCalls()).toEqual([{ method: "GET", path: "/api/admin/guide/topic", status: 200, role: "manager" }]);
  });
});

describe("the front desk's screens", () => {
  it("gives the desk no usable tip in a region only a manager changes: it is inside the region's read-only fieldset", async () => {
    const container = await show("desk", () => <CourtsTab venues={venues} onVenuesChange={() => undefined} />);
    const tips = Array.from(container.querySelectorAll<HTMLElement>("[data-help]"));
    for (const tip of tips) expect(tip.closest("fieldset[disabled]"), tip.getAttribute("data-help") ?? "").not.toBeNull();
  });

  it("gives the desk a tip where it uses the screen, and reads the desk's version for it: no link to a screen it cannot use", async () => {
    const container = await show("desk", () => <CreditTab venues={venues} />);
    const usable = Array.from(container.querySelectorAll<HTMLElement>("[data-help]")).filter((el) => !el.closest("fieldset[disabled]"));
    const places = usable.map((el) => el.getAttribute("data-help"));
    expect(places).toEqual(expect.arrayContaining(["credit.passes", "credit.memberships"]));
    expect(topicCalls()).toEqual([]);
    const dialog = await open(container, "credit.passes");
    expect(topicCalls()).toEqual([{ method: "GET", path: "/api/admin/guide/topic", status: 200, role: "desk" }]);
    expect(dialog.textContent).toMatch(/pass/i);
    expect(within(dialog).queryByRole("button", { name: /Open Credit & passes/ })).toBeNull();
    // The desk may open the guide: it has the tab.
    expect(within(dialog).getByRole("link", { name: "Open this in the guide" })).toBeTruthy();
  });
});
