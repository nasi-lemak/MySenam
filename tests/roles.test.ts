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
import { MANAGER_ONLY } from "../src/lib/roles";
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

  it("runs the day: payments, cancellations and the like still work", async () => {
    const made = await createBooking({ courtId: (await listVenues())[0].courts[0].id, date: addDays(todayISO(), 2), hours: [10], name: "Ali", phone: "0161230000" });
    if (!made.ok) throw new Error(made.error);
    const paid = await call("../src/app/api/admin/payments/route.ts", "POST", deskCookie, { code: made.booking.code, paid: true, via: "cash" });
    expect(paid.status).toBe(200);
    const cancelled = await call("../src/app/api/admin/bookings/cancel/route.ts", "POST", deskCookie, { code: made.booking.code });
    expect(cancelled.status).toBe(200);

    // Both written down, with who and how.
    const log = await listActivity([venueId], { bookingCode: made.booking.code });
    expect(log.map((a) => [a.action, a.adminName])).toEqual([
      ["booking.cancelled", "Dina Desk"],
      ["payment.paid", "Dina Desk"],
    ]);
    expect(log[1].detail).toContain("by Cash");
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
