/// <reference types="vite/client" />
import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { listActivity } from "../src/lib/activity";
import { ADMIN_SESSION_COOKIE, authenticateAdmin, createAdmin, createAdminSession, ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { MANAGER_ONLY, STAFF_ACTIONS, managerOnly, staffMay } from "../src/lib/roles";
import { createBooking, listVenues } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/**
 * Front desk runs the day; a manager also sets the venue up and sends money
 * back out. And everything either does to a booking or the money is written
 * down with their name on it.
 */

type Handler = (req: NextRequest, ctx?: unknown) => Response | Promise<Response>;
const routes = import.meta.glob("../src/app/api/admin/**/route.ts");
const pathOf = (file: string) => file.replace("../src/app", "").replace("/route.ts", "").replace(/\[[^\]]+\]/g, "1");

let venueId: number;
let deskCookie: string;
let managerCookie: string;
let ownerCookie: string;
let deskId: number;

beforeAll(async () => {
  await ensureBootstrapAdmin();
  venueId = (await listVenues())[0].id;
  const owner = (await authenticateAdmin("admin@mysenam.my", "mysenam-admin"))!;
  ownerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(owner.id)).token}`;
  const desk = await createAdmin({ name: "Dina Desk", email: "dina@venue.my", password: "desk-password-1", venueId, role: "desk" });
  const manager = await createAdmin({ name: "Musa Manager", email: "musa@venue.my", password: "manager-pass-1", venueId });
  if (!desk.ok || !manager.ok) throw new Error("staff");
  deskId = desk.admin.id;
  expect(desk.admin.role).toBe("desk");
  // Branch staff are managers unless made front desk: nobody already there loses anything.
  expect(manager.admin.role).toBe("manager");
  deskCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.admin.id)).token}`;
  managerCookie = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(manager.admin.id)).token}`;
});

const call = async (file: string, method: string, cookie: string, body: unknown = {}) => {
  const mod = (await routes[file]()) as Record<string, unknown>;
  const url = `http://localhost${pathOf(file)}?venueId=1`;
  return (mod[method] as Handler)(
    new NextRequest(url, { method, headers: { cookie }, ...(method === "GET" ? {} : { body: JSON.stringify(body) }) }),
    { params: Promise.resolve({ id: "1", photoId: "1" }) }
  );
};

describe("what front desk may not do", () => {
  it("names only routes that exist", () => {
    const paths = Object.keys(routes).map(pathOf);
    for (const rule of MANAGER_ONLY) expect(paths.some((p) => rule.path.test(p)), String(rule.path)).toBe(true);
  });

  it("answers the dashboard's questions from the same list, each a real route and method (X1-5)", async () => {
    const paths = Object.keys(routes).map((file) => ({ file, path: pathOf(file) }));
    const desk = staffMay("desk");
    const manager = staffMay("manager");
    for (const [name, request] of Object.entries(STAFF_ACTIONS)) {
      const [method, path] = request.split(" ");
      const route = paths.find((r) => r.path === path);
      expect(route, `${name}: ${path} is not a route`).toBeTruthy();
      const mod = (await routes[route!.file]()) as Record<string, unknown>;
      expect(typeof mod[method], `${name}: ${request} has no handler`).toBe("function");
      expect(desk[name as keyof typeof desk], name).toBe(!managerOnly(method, path));
      expect(manager[name as keyof typeof manager], name).toBe(true);
    }
    // Every one the dashboard asks about is a manager's but moving a class, which the desk may do at its own venue unless a manager turns that off (ADR 0045);
    // deciding a request to move one, and the settings, stay a manager's.
    expect(desk.classMove).toBe(true);
    expect(Object.entries(desk).every(([name, v]) => v === false || name === "classMove")).toBe(true);
  });

  it("sends the answers with who is signed in", async () => {
    const { GET } = await import("../src/app/api/admin/auth/me/route");
    const asDesk = await (await GET(new NextRequest("http://localhost/api/admin/auth/me", { headers: { cookie: deskCookie } }))).json();
    expect(asDesk.canManage).toBe(false);
    expect(asDesk.may).toEqual(staffMay("desk"));
    const asManager = await (await GET(new NextRequest("http://localhost/api/admin/auth/me", { headers: { cookie: managerCookie } }))).json();
    expect(asManager.canManage).toBe(true);
    expect(asManager.may.venueDetails).toBe(true);
  });

  it("is refused at every one of them, and a manager is not", async () => {
    let checked = 0;
    for (const file of Object.keys(routes)) {
      const path = pathOf(file);
      const mod = (await routes[file]()) as Record<string, unknown>;
      for (const method of ["GET", "POST", "PUT", "PATCH", "DELETE"]) {
        if (typeof mod[method] !== "function") continue;
        const rule = MANAGER_ONLY.find((r) => r.path.test(path) && (r.methods === "all" || r.methods.includes(method)));
        if (!rule) continue;
        const asDesk = await call(file, method, deskCookie);
        expect(asDesk.status, `${method} ${path} as front desk`).toBe(403);
        expect((await asDesk.json()).code).toBe("MANAGER_ONLY");
        const asManager = await call(file, method, managerCookie);
        if (asManager.status === 403) expect((await asManager.json()).code, `${method} ${path} as a manager`).not.toBe("MANAGER_ONLY");
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(25);
  });

  it("may read the set-up checklist but not tick it off or hide it; a manager may", async () => {
    const { GET, POST } = await import("../src/app/api/admin/setup/route");
    const read = async (cookie: string) => {
      const res = await GET(new NextRequest(`http://localhost/api/admin/setup?venueId=${venueId}`, { headers: { cookie } }));
      expect(res.status).toBe(200);
      return (await res.json()) as { detailsChecked: boolean; dismissed: boolean };
    };
    const ask = (cookie: string, action: string) =>
      POST(new NextRequest("http://localhost/api/admin/setup", { method: "POST", headers: { cookie }, body: JSON.stringify({ venueId, action }) }));
    const before = await read(deskCookie);
    for (const action of ["detailsChecked", "dismiss"]) {
      const res = await ask(deskCookie, action);
      expect(res.status, action).toBe(403);
      expect((await res.json()).code).toBe("MANAGER_ONLY");
    }
    // Nothing changed for the desk's asking.
    expect(await read(deskCookie)).toEqual(before);
    expect(staffMay("desk").setupChecklist).toBe(false);

    const ticked = await ask(managerCookie, "detailsChecked");
    expect(ticked.status).toBe(200);
    expect((await ticked.json()).detailsChecked).toBe(true);
    const hidden = await ask(managerCookie, "dismiss");
    expect(hidden.status).toBe(200);
    expect((await hidden.json()).dismissed).toBe(true);
  });

  it("runs the day: payments, cancellations and the like still work", async () => {
    const made = await createBooking({ courtId: (await listVenues())[0].courts[0].id, date: addDays(todayISO(), 2), hours: [10], name: "Ali", phone: "0161230000" });
    if (!made.ok) throw new Error(made.error);
    const paid = await call("../src/app/api/admin/payments/route.ts", "POST", deskCookie, { code: made.booking.code, paid: true, via: "cash" });
    expect(paid.status).toBe(200);
    const cancelled = await call("../src/app/api/admin/bookings/cancel/route.ts", "POST", deskCookie, { code: made.booking.code });
    expect(cancelled.status).toBe(200);

    // Each written down, with who and how: the cash handed back too (lib/counter-refunds.ts).
    const log = await listActivity([venueId], { bookingCode: made.booking.code });
    expect(log.map((a) => [a.action, a.adminName])).toEqual([
      ["payment.paid_out", "Dina Desk"],
      ["booking.cancelled", "Dina Desk"],
      ["payment.paid", "Dina Desk"],
    ]);
    expect(log[0].detail).toContain("by Cash");
    expect(log[2].detail).toContain("by Cash");
  });
});

describe("roles", () => {
  it("are set by a business manager or the owner, not by branch staff", async () => {
    const asManager = await call("../src/app/api/admin/admins/[id]/route.ts", "PATCH", managerCookie, { role: "manager" });
    expect(asManager.status).toBe(403);
    const mod = await import("../src/app/api/admin/admins/[id]/route");
    const res = await mod.PATCH(
      new NextRequest(`http://localhost/api/admin/admins/${deskId}`, { method: "PATCH", headers: { cookie: ownerCookie }, body: JSON.stringify({ role: "manager" }) }),
      { params: Promise.resolve({ id: String(deskId) }) }
    );
    expect(res.status).toBe(200);
    // Now a manager, the same session reaches the reports.
    const reports = await call("../src/app/api/admin/reports/route.ts", "GET", deskCookie);
    expect(reports.status).not.toBe(403);
    expect((await listActivity([venueId])).find((a) => a.action === "staff.role")?.detail).toBe("Dina Desk: desk → manager");
  });

  it("show the log to managers, filtered by booking", async () => {
    const res = await call("../src/app/api/admin/activity/route.ts", "GET", managerCookie);
    expect(res.status).toBe(200);
    expect((await res.json()).actions.length).toBeGreaterThan(0);
  });
});
