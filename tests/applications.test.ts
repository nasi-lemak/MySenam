import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

const sendMail = vi.fn(async () => ({}));
vi.mock("nodemailer", () => ({ default: { createTransport: vi.fn(() => ({ sendMail })) } }));

import { NextRequest } from "next/server";
import {
  approveApplication,
  listApplications,
  rejectApplication,
  submitApplication,
} from "../src/lib/applications";
import {
  ADMIN_SESSION_COOKIE,
  authenticateAdmin,
  createAdmin,
  createAdminSession,
  ensureBootstrapAdmin,
  listAdmins,
} from "../src/lib/admin-auth";
import { listVenues } from "../src/lib/store";
import { getDb } from "../src/lib/db";

/**
 * A venue asking to join, and the platform owner letting it in — the venue
 * and its operator's account made together, with the password the operator
 * chose, which nobody else ever sees.
 */

let ownerId: number;
let n = 0;

function apply(over: Record<string, string> = {}) {
  n++;
  return submitApplication({
    businessName: `Smash Hall ${n}`,
    area: "Cheras",
    address: "12 Jalan Cheras, Kuala Lumpur",
    venuePhone: "03-9100 0000",
    contactName: "Wei Ling",
    email: `owner${n}@smashhall.my`,
    password: "a long enough password",
    message: "6 badminton courts, open 8am to midnight",
    ...over,
  });
}

beforeAll(() => {
  ensureBootstrapAdmin();
  ownerId = listAdmins().find((a) => a.venueId === null)!.id;
});

beforeEach(() => sendMail.mockClear());

afterEach(() => {
  delete process.env.MYSENAM_MARKETPLACE;
  delete process.env.SMTP_URL;
  delete process.env.MAIL_FROM;
});

describe("applying", () => {
  it("is written down, waiting, without the password readable", () => {
    const result = apply();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.application.status).toBe("pending");
    expect(JSON.stringify(result.application)).not.toContain("a long enough password");
    const row = getDb()
      .prepare("SELECT password_hash FROM venue_applications WHERE id = ?")
      .get(result.application.id) as { password_hash: string };
    expect(row.password_hash).not.toContain("a long enough password");
  });

  it("asks for a real password, email and phone", () => {
    expect(apply({ password: "short" }).ok).toBe(false);
    expect(apply({ email: "not-an-email" }).ok).toBe(false);
    expect(apply({ venuePhone: "call me" }).ok).toBe(false);
  });

  it("will not take a second application for an email already waiting, or already in", () => {
    const first = apply({ email: "dup@example.my" });
    expect(first.ok).toBe(true);
    expect(apply({ email: "DUP@example.my" }).ok).toBe(false);
    expect(apply({ email: "admin@mysenam.my" }).ok).toBe(false);
  });
});

describe("approving", () => {
  it("makes the venue and its operator, who signs in with the password they chose", async () => {
    process.env.SMTP_URL = "smtp://x";
    process.env.MAIL_FROM = "hello@mysenam.my";
    const applied = apply();
    if (!applied.ok) throw new Error(applied.error);

    const result = await approveApplication(applied.application.id, ownerId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.emailed).toBe(true);
    expect(sendMail).toHaveBeenCalledOnce();

    const venue = listVenues().find((v) => v.id === result.application.venueId)!;
    expect(venue.name).toBe(applied.application.businessName);
    const operator = authenticateAdmin(applied.application.email, "a long enough password");
    expect(operator?.venueId).toBe(venue.id);

    // Once only.
    expect((await approveApplication(applied.application.id, ownerId)).ok).toBe(false);
  });

  it("says so when there is no email to tell them by", async () => {
    const applied = apply();
    if (!applied.ok) throw new Error(applied.error);
    const result = await approveApplication(applied.application.id, ownerId);
    expect(result.ok && result.emailed).toBe(false);
  });
});

describe("turning one down", () => {
  it("keeps why, and drops the password", async () => {
    const applied = apply();
    if (!applied.ok) throw new Error(applied.error);
    const result = await rejectApplication(applied.application.id, ownerId, "We do not cover Cheras yet.");
    expect(result.ok).toBe(true);
    const row = getDb()
      .prepare("SELECT status, reason, password_hash FROM venue_applications WHERE id = ?")
      .get(applied.application.id) as { status: string; reason: string; password_hash: string };
    expect(row).toEqual({ status: "rejected", reason: "We do not cover Cheras yet.", password_hash: "" });
    expect(authenticateAdmin(applied.application.email, "a long enough password")).toBeNull();
    // Waiting ones are listed first, the newest at the top.
    const pending = apply();
    const listed = listApplications();
    expect(listed[0].id).toBe(pending.ok && pending.application.id);
    const firstDecided = listed.findIndex((a) => a.status !== "pending");
    expect(listed.slice(firstDecided).every((a) => a.status !== "pending")).toBe(true);
  });
});

describe("the routes", () => {
  const publicRoute = () => import("../src/app/api/venue-applications/route");
  const adminRoute = () => import("../src/app/api/admin/venue-applications/route");
  const post = (body: unknown, headers: Record<string, string> = {}) =>
    new NextRequest("http://localhost/api/venue-applications", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `10.1.0.${n}`, ...headers },
      body: JSON.stringify(body),
    });

  const form = () => ({
    businessName: "Route Hall",
    area: "Ampang",
    address: "1 Jalan Ampang, KL",
    venuePhone: "0312345678",
    contactName: "Faiz",
    email: `route${++n}@example.my`,
    password: "another long password",
  });

  it("only exist on a marketplace", async () => {
    expect((await (await publicRoute()).POST(post(form()))).status).toBe(404);
    process.env.MYSENAM_MARKETPLACE = "on";
    expect((await (await publicRoute()).POST(post(form()))).status).toBe(201);
  });

  it("quietly drop what a script filled in", async () => {
    process.env.MYSENAM_MARKETPLACE = "on";
    const before = listApplications().length;
    const res = await (await publicRoute()).POST(post({ ...form(), website: "http://spam.example" }));
    expect(res.status).toBe(201);
    expect(listApplications()).toHaveLength(before);
  });

  it("are decided by the platform owner only", async () => {
    const desk = createAdmin({
      name: "Desk",
      email: "desk-apps@example.com",
      password: "desk-password",
      venueId: listVenues()[0].id,
    });
    if (!desk.ok) throw new Error(desk.error);
    const asDesk = `${ADMIN_SESSION_COOKIE}=${createAdminSession(desk.admin.id).token}`;
    const asOwner = `${ADMIN_SESSION_COOKIE}=${createAdminSession(ownerId).token}`;
    const get = (cookie: string) =>
      new NextRequest("http://localhost/api/admin/venue-applications", { headers: { cookie } });
    const mod = await adminRoute();
    expect(mod.GET(get(asDesk)).status).toBe(403);
    expect(mod.GET(get(asOwner)).status).toBe(200);
  });
});
