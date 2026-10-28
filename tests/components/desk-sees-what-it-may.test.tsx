// @vitest-environment jsdom
/// <reference types="vite/client" />
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
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
import { managerOnly, staffMay, type StaffRole } from "../../src/lib/roles";
import { listVenuesByIds } from "../../src/lib/store";
import { addDays, todayISO } from "../../src/lib/time";
import { staffTranslator } from "../../src/lib/staff-i18n";
import { MAX_PHOTOS } from "../../src/lib/photos-shared";
import { forgetStaffRole } from "../../src/components/admin/useStaffRole";
import { StaffMayProvider } from "../../src/components/admin/StaffMay";
import { StaffZones } from "../../src/components/admin/StaffLanguage";
import type { ManagedVenue } from "../../src/components/admin/shared";
import { BookingsTab } from "../../src/components/admin/BookingsTab";
import { ClassesTab } from "../../src/components/admin/ClassesTab";
import { CourtsTab } from "../../src/components/admin/CourtsTab";
import { CreditTab } from "../../src/components/admin/CreditTab";
import { VenuesTab } from "../../src/components/admin/VenuesTab";
import AdminPage from "../../src/app/admin/page";

/**
 * The front desk is shown only what it may do (audit R8 X1-5).
 *
 * Each main tab is rendered as a front-desk account and as a manager, against
 * the app's own routes and a database filled with the demonstration fortnight
 * (every request a screen makes is answered by the real route handler, signed
 * in as that account). Then every control on screen is used: each button and
 * summary pressed, each select changed, each form submitted, round after round
 * as new ones appear, with every confirmation answered yes. What the front
 * desk could press must never ask for anything `MANAGER_ONLY`
 * (lib/roles.ts) refuses it, and the server must never answer it
 * "MANAGER_ONLY"; the same tabs as a manager do reach those requests, so the
 * controls are there for the manager and hidden from the desk rather than
 * missing for both.
 */

type Handler = (req: NextRequest, ctx?: unknown) => Response | Promise<Response>;
const routes = import.meta.glob("../../src/app/api/**/route.ts");
const table = Object.keys(routes).map((file) => {
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
  // Fixed segments win over dynamic ones, as Next routes them.
  return { file, re, names, dynamic: names.length };
}).sort((a, b) => a.dynamic - b.dynamic);

let deskCookie = "";
let managerCookie = "";
let desk: Admin;
let manager: Admin;
let venues: ManagedVenue[] = [];
let calls: { method: string; path: string; status: number; code?: string }[] = [];
let cookie = "";
/** Requests a screen has made and not yet had answered. */
let inFlight = 0;

/** Let every request the screen has made be answered, and the screen settle. */
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
    return await answer(input, init);
  } finally {
    inFlight--;
  }
}

async function answer(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
  const method = (init?.method ?? "GET").toUpperCase();
  const route = table.find((r) => r.re.test(url.pathname));
  if (!route) return new Response(JSON.stringify({ error: "no route" }), { status: 404 });
  const m = route.re.exec(url.pathname)!;
  const params = Object.fromEntries(route.names.map((n, i) => [n, decodeURIComponent(m[i + 1])]));
  const mod = (await routes[route.file]()) as Record<string, unknown>;
  const handler = mod[method] as Handler | undefined;
  let res: Response;
  if (!handler) res = new Response(JSON.stringify({ error: "method" }), { status: 405 });
  else {
    const body = init?.body;
    const req = new NextRequest(url.href, {
      method,
      headers: { cookie, ...(typeof body === "string" ? { "content-type": "application/json" } : {}) },
      ...(body !== undefined && body !== null && method !== "GET" ? { body: body as BodyInit } : {}),
    });
    res = await handler(req, { params: Promise.resolve(params) });
  }
  const copy = res.clone();
  let code: string | undefined;
  try {
    code = ((await copy.json()) as { code?: string }).code;
  } catch {
    code = undefined;
  }
  calls.push({ method, path: url.pathname, status: res.status, code });
  return res;
}

beforeAll(async () => {
  await ensureBootstrapAdmin();
  const owner = (await listAdmins())[0];
  const filled = await seedDemoData({ adminId: owner.id, force: true });
  if (!filled.ok) throw new Error(filled.error);
  const venueId = ((await getDb().prepare("SELECT id FROM venues ORDER BY id LIMIT 1").get()) as { id: number }).id;
  const d = await createAdmin({ name: "Dina Desk", email: "dina@desk.my", password: "desk-password-1", venueId, role: "desk" });
  const m = await createAdmin({ name: "Musa Manager", email: "musa@desk.my", password: "manager-pass-1", venueId, role: "manager" });
  if (!d.ok || !m.ok) throw new Error("staff");
  desk = d.admin;
  manager = m.admin;
  deskCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.id)).token}`;
  managerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(manager.id)).token}`;
  venues = (await listVenuesByIds([venueId])) as ManagedVenue[];
}, 120_000);

beforeEach(() => {
  calls = [];
  forgetStaffRole();
  vi.stubGlobal("fetch", vi.fn(serve));
  vi.stubGlobal("confirm", () => true);
  vi.stubGlobal("prompt", () => "Checked in person at the counter");
  window.confirm = () => true;
  window.prompt = () => "Checked in person at the counter";
  window.open = (() => null) as typeof window.open;
  Object.defineProperty(navigator, "clipboard", { value: { writeText: async () => undefined }, configurable: true });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
afterAll(() => undefined);

/** Use every control on screen, round after round as new ones appear. */
async function useEverything(container: HTMLElement, rounds = 4): Promise<number> {
  const done = new WeakSet<Element>();
  let used = 0;
  for (let round = 0; round < rounds; round++) {
    let acted = false;
    const controls = Array.from(container.querySelectorAll("button, summary, select, input[type=checkbox], input[type=radio], form"));
    for (const el of controls) {
      if (done.has(el) || !el.isConnected) continue;
      done.add(el);
      if (el.matches(":disabled") || el.closest("fieldset[disabled]")) continue;
      acted = true;
      used++;
      await act(async () => {
        if (el instanceof HTMLFormElement) fireEvent.submit(el);
        else if (el instanceof HTMLSelectElement) {
          const other = Array.from(el.options).find((o) => o.value !== el.value && !o.disabled);
          if (other) fireEvent.change(el, { target: { value: other.value } });
        } else fireEvent.click(el);
      });
      await settle();
    }
    if (!acted) break;
  }
  return used;
}

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

/** The requests made that front desk is refused. */
const refusedToDesk = () => calls.filter((c) => managerOnly(c.method, c.path)).map((c) => `${c.method} ${c.path}`);

/** A day ahead with the demonstration's bookings on it: the desk's run and the manager's each have their own, as using everything cancels some. */
async function showDay(container: HTMLElement, role: StaffRole): Promise<void> {
  const day = container.querySelector<HTMLInputElement>('input[type="date"]')!;
  await act(async () => {
    fireEvent.change(day, { target: { value: addDays(todayISO(), role === "desk" ? 1 : 2) } });
  });
  await settle();
}

type Tab = {
  name: string;
  ui: (admin: Admin) => ReactElement;
  before?: (container: HTMLElement, role: StaffRole) => Promise<void>;
  /** Requests only a manager makes that a manager's run must reach here: the controls the desk is not shown. */
  managers: RegExp[];
};

const TABS: Tab[] = [
  { name: "the day list", ui: () => <BookingsTab venues={venues} />, before: showDay, managers: [/^POST \/api\/admin\/venues\/\d+\/blocked-phones$/] },
  {
    name: "courts and rates",
    ui: () => <CourtsTab venues={venues} onVenuesChange={() => undefined} />,
    managers: [
      /^POST \/api\/admin\/courts$/,
      /^PATCH \/api\/admin\/courts\/\d+$/,
      /^POST \/api\/admin\/peak-rules$/,
      /^POST \/api\/admin\/concessions$/,
      /^POST \/api\/admin\/outages$/,
      /^POST \/api\/admin\/approvals\/settings$/,
      /^GET \/api\/admin\/approvals\/holds$/,
    ],
  },
  {
    name: "classes",
    ui: () => <ClassesTab venues={venues} />,
    managers: [/^POST \/api\/admin\/classes$/, /^DELETE \/api\/admin\/classes\/\d+$/, /^POST \/api\/admin\/coaches$/],
  },
  {
    name: "credit and passes",
    ui: () => <CreditTab venues={venues} />,
    managers: [
      /^POST \/api\/admin\/passes\/\d+\/void$/,
      /^POST \/api\/admin\/pass-products$/,
      /^POST \/api\/admin\/memberships\/\d+\/extend$/,
      /^POST \/api\/admin\/memberships\/\d+\/void$/,
      /^POST \/api\/admin\/promos$/,
      /^POST \/api\/admin\/promos\/\d+\/void$/,
      /^POST \/api\/admin\/accounts$/,
    ],
  },
  {
    name: "venue details",
    ui: (admin) => <VenuesTab admin={admin} venues={venues} onChange={async () => admin} />,
    managers: [/^POST \/api\/admin\/house-rules$/, /^POST \/api\/admin\/notices$/, /^POST \/api\/admin\/cancel-policy$/, /^GET \/api\/admin\/admins$/],
  },
];

describe("front desk", () => {
  for (const { name, ui, before } of TABS)
    it(`is offered nothing on ${name} that a manager alone may do`, async () => {
      const container = await show("desk", ui);
      await before?.(container, "desk");
      const used = await useEverything(container);
      // Venue details holds little the desk may change, and with nothing waiting (messages, data) nothing to press.
      if (name !== "venue details") expect(used).toBeGreaterThan(5);
      expect(calls.length).toBeGreaterThan(0);
      expect(refusedToDesk()).toEqual([]);
      expect(calls.filter((c) => c.code === "MANAGER_ONLY")).toEqual([]);
      // What it may not change is said once, in its language, where it is shown.
      if (name !== "the day list") expect(container.textContent).toContain("A manager changes this.");
    }, 120_000);
});

/**
 * Open every section on screen that opens: each summary not yet open (a
 * disabled fieldset does not stop one, so those inside what the desk sees
 * read-only too), round after round as opening shows more.
 */
async function openEverything(container: HTMLElement): Promise<void> {
  for (let round = 0; round < 6; round++) {
    const closed = Array.from(container.querySelectorAll("details:not([open]) > summary"));
    if (closed.length === 0) return;
    for (const summary of closed) {
      await act(async () => {
        fireEvent.click(summary);
      });
      await settle();
    }
  }
}

const en = staffTranslator("en");

/** A field by its accessible name, or the start of its label (a label may carry a hint after it). */
function field(container: HTMLElement, label: string): HTMLInputElement | HTMLTextAreaElement {
  const named = Array.from(container.querySelectorAll("input, textarea")).find((i) => i.getAttribute("aria-label") === label);
  const found = Array.from(container.querySelectorAll("label")).find((l) => l.textContent?.trim().startsWith(label));
  const input = named ?? found?.querySelector("input, textarea");
  if (!input) throw new Error(`no field labelled ${label}`);
  return input as HTMLInputElement | HTMLTextAreaElement;
}

/** What a manager has set up, asked for through the app's own routes as the manager. */
async function asManager(method: string, path: string, body: unknown): Promise<void> {
  const was = cookie;
  cookie = managerCookie;
  try {
    const res = await serve(path, { method, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${await res.text()}`);
  } finally {
    cookie = was;
  }
}

describe("front desk reads what a manager changes", () => {
  it("opens every section of venue details and reads what is behind it: the access list, house rules, waiver, overrides, extras, notices, facilities, photos and WhatsApp", async () => {
    const venueId = venues[0].id;
    const waiver = "Climbing is at your own risk. Use the auto-belay as shown at the desk.";
    await asManager("PATCH", `/api/admin/venues/${venueId}`, { amenities: ["showers"] });
    await asManager("POST", "/api/admin/venue-access", { venueId, action: "add", phone: "012-777 1234", name: "Siti Listed", label: "A-12-3", kind: "resident", expiresOn: "", account: "" });
    await asManager("POST", "/api/admin/house-rules", { venueId, upcoming: "", perWeek: "", perDay: "", aheadDays: "", memberAheadDays: "", seriesWeeks: "6" });
    await asManager("POST", "/api/admin/waiver", { venueId, text: waiver });
    await asManager("POST", "/api/admin/policy-overrides", { venueId, policies: ["strikes"] });
    await asManager("POST", "/api/admin/addons", { venueId, name: "Racket hire", kind: "rental", price: "5", stock: "", sport: "" });
    await asManager("POST", "/api/admin/notices", { venueId, text: "Court 2 is relit this week", link: "", startsOn: todayISO(), endsOn: addDays(todayISO(), 3) });
    venues = (await listVenuesByIds([venueId])) as ManagedVenue[];
    calls = [];
    try {
      const container = await show("desk", (admin) => <VenuesTab admin={admin} venues={venues} onChange={async () => admin} />);
      await useEverything(container);
      await openEverything(container);
      const text = container.textContent ?? "";

      // Who it is for: the venue's list, with the person on it.
      const listed = Array.from(container.querySelectorAll("tr")).find((tr) => tr.textContent?.includes("Siti Listed"));
      expect(listed?.textContent).toContain("A-12-3");
      expect(text).toContain(en("acs.pasteLine"));
      // House rules, as set.
      expect(text).toContain(en("hr.intro"));
      expect(field(container, en("hr.seriesWeeks")).value).toBe("6");
      // The waiver's words.
      expect(text).toContain(en("wv.intro"));
      expect(field(container, en("wv.label")).value).toBe(waiver);
      // Which overrides managers may make.
      expect(text).toContain(en("r9.set.intro"));
      expect((field(container, en("r9.set.strikes")) as HTMLInputElement).checked).toBe(true);
      // Extras, notices, facilities, photos, WhatsApp.
      expect(text).toContain(en("add.intro"));
      expect(text).toContain("Racket hire");
      expect(text).toContain("Court 2 is relit this week");
      expect(text).toContain(en("fac.intro"));
      const showers = Array.from(container.querySelectorAll("label")).find((l) => /Showers/i.test(l.textContent ?? ""));
      expect(showers?.querySelector("input")?.checked).toBe(true);
      expect(text).toContain(en("ph.intro", { more: MAX_PHOTOS - 1 }));
      expect(text).toContain(en("wa.intro"));
      // Every section that opens is open, and nothing a manager alone changes was asked for or offered.
      expect(container.querySelectorAll("details:not([open])").length).toBe(0);
      expect(refusedToDesk()).toEqual([]);
      expect(calls.filter((c) => c.code === "MANAGER_ONLY")).toEqual([]);
      // What it reads it cannot change: its fields are disabled, and it has no button to save them.
      expect(field(container, en("wv.label")).matches(":disabled")).toBe(true);
      expect(field(container, en("hr.seriesWeeks")).matches(":disabled")).toBe(true);
    } finally {
      // Fair-use limits and a waiver hold at the counter too: the tabs after this one see the venue as it was.
      await asManager("POST", "/api/admin/house-rules", { venueId, upcoming: "", perWeek: "", perDay: "", aheadDays: "", memberAheadDays: "", seriesWeeks: "" });
      await asManager("POST", "/api/admin/waiver", { venueId, text: "" });
      await asManager("POST", "/api/admin/policy-overrides", { venueId, policies: [] });
    }
  }, 120_000);

  for (const { name, ui, before } of TABS.filter((tab) => tab.name !== "venue details"))
    it(`opens every section on ${name}`, async () => {
      const container = await show("desk", ui);
      await before?.(container, "desk");
      await useEverything(container);
      await openEverything(container);
      expect(container.querySelectorAll("details:not([open])").length).toBe(0);
      expect(refusedToDesk()).toEqual([]);
      expect(calls.filter((c) => c.code === "MANAGER_ONLY")).toEqual([]);
    }, 120_000);
});

describe("the dashboard", () => {
  it("takes what each account may do from who is signed in, and gives the desk no set-up steps or go-live button", async () => {
    // A branch still being set up, where the checklist and the go-live banner show.
    const venueId = venues[0].id;
    await getDb().prepare("UPDATE venues SET published_at = NULL WHERE id = ?").run(venueId);
    try {
      window.history.replaceState(null, "", "/admin?tab=venues");
      cookie = deskCookie;
      const asDesk = render(<AdminPage />);
      await settle();
      expect(asDesk.container.textContent).toContain("A manager changes this.");
      expect(asDesk.container.textContent).not.toContain("Set up your venue");
      // The banner says where the branch stands; asking to go live is a manager's.
      expect(asDesk.container.textContent).toContain("is a draft");
      expect(asDesk.queryByRole("button", { name: /go live/i })).toBeNull();
      await useEverything(asDesk.container, 1);
      expect(refusedToDesk()).toEqual([]);
      cleanup();

      calls = [];
      cookie = managerCookie;
      const asManager = render(<AdminPage />);
      await settle();
      expect(asManager.container.textContent).not.toContain("A manager changes this.");
      expect(calls.some((c) => c.path === "/api/admin/setup")).toBe(true);
      expect(asManager.getByRole("button", { name: /go live/i })).toBeTruthy();
    } finally {
      await getDb().prepare("UPDATE venues SET published_at = datetime('now') WHERE id = ?").run(venueId);
    }
  }, 120_000);
});

describe("a manager", () => {
  for (const { name, ui, before, managers } of TABS)
    it(`finds the manager's controls on ${name}`, async () => {
      const container = await show("manager", ui);
      await before?.(container, "manager");
      expect(await useEverything(container)).toBeGreaterThan(5);
      const made = refusedToDesk();
      for (const expected of managers) expect(made.some((r) => expected.test(r)), `${name}: ${expected}`).toBe(true);
      expect(container.textContent).not.toContain("A manager changes this.");
    }, 120_000);
});
