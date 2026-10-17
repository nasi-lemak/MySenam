import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

const sendMail = vi.fn(async () => ({}));
vi.mock("nodemailer", () => ({ default: { createTransport: vi.fn(() => ({ sendMail })) } }));

import { NextRequest } from "next/server";
import {
  approveApplication,
  confirmApplicationEmail,
  listApplications,
  locationReport,
  rejectApplication,
  REVIEW_CHECKS,
  submitApplication,
} from "../src/lib/applications";
import { resetGeocoder } from "../src/lib/geo";
import {
  ADMIN_SESSION_COOKIE,
  authenticateAdmin,
  createAdmin,
  createAdminSession,
  ensureBootstrapAdmin,
  listAdmins,
} from "../src/lib/admin-auth";
import { createVenue, listVenues } from "../src/lib/store";
import { getDb } from "../src/lib/db";

/**
 * A venue asking to join, and the platform owner letting it in — the venue
 * and its operator's account made together, with the password the operator
 * chose, which nobody else ever sees.
 */

let ownerId: number;
let n = 0;
const ALL_CHECKS = REVIEW_CHECKS.map((c) => c.id);
/** Somewhere in Cheras. */
const CHERAS = { lat: 3.1036, lng: 101.7392 };

async function apply(over: Record<string, unknown> = {}) {
  n++;
  return await submitApplication({
    businessName: `Smash Hall ${n}`,
    area: "Cheras",
    address: "12 Jalan Cheras, Kuala Lumpur",
    venuePhone: "03-9100 0000",
    contactName: "Wei Ling",
    email: `owner${n}@smashhall.my`,
    password: "a long enough password",
    message: "6 badminton courts, open 8am to midnight",
    // A spot of its own, so no two look like the same building.
    lat: CHERAS.lat + n * 0.01,
    lng: CHERAS.lng,
    ...over,
  } as Parameters<typeof submitApplication>[0]);
}

const sendEmail = () => {
  process.env.SMTP_URL = "smtp://x";
  process.env.MAIL_FROM = "hello@mysenam.my";
};

/** The link in the last confirmation email sent. */
function linkToken(): string {
  const mails = sendMail.mock.calls as unknown as [{ subject: string; text: string }][];
  const mail = mails.map(([m]) => m).reverse().find((m) => m.subject.startsWith("Confirm"))!;
  return /token=([\w-]+)/.exec(mail.text)![1];
}

beforeAll(async () => {
  await ensureBootstrapAdmin();
  ownerId = (await listAdmins()).find((a) => a.venueId === null)!.id;
});

beforeEach(() => sendMail.mockClear());

afterEach(() => {
  delete process.env.MYSENAM_MARKETPLACE;
  delete process.env.SMTP_URL;
  delete process.env.MAIL_FROM;
});

describe("applying", () => {
  it("is written down, waiting, without the password readable", async () => {
    const result = await apply();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.application.status).toBe("pending");
    expect(JSON.stringify(result.application)).not.toContain("a long enough password");
    const row = await getDb()
      .prepare("SELECT password_hash FROM venue_applications WHERE id = ?")
      .get(result.application.id) as { password_hash: string };
    expect(row.password_hash).not.toContain("a long enough password");
  });

  it("asks for a real password, email and phone", async () => {
    expect((await apply({ password: "short" })).ok).toBe(false);
    expect((await apply({ email: "not-an-email" })).ok).toBe(false);
    expect((await apply({ venuePhone: "call me" })).ok).toBe(false);
  });

  it("will not take a second application for an email already waiting, or already in", async () => {
    const first = await apply({ email: "dup@example.my" });
    expect(first.ok).toBe(true);
    expect((await apply({ email: "DUP@example.my" })).ok).toBe(false);
    expect((await apply({ email: "admin@mysenam.my" })).ok).toBe(false);
  });
});

describe("approving", () => {
  it("makes the venue and its operator, who signs in with the password they chose", async () => {
    sendEmail();
    const applied = await apply();
    if (!applied.ok) throw new Error(applied.error);
    expect(await confirmApplicationEmail(linkToken())).toBe("confirmed");

    const result = await approveApplication(applied.application.id, ownerId, ALL_CHECKS);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.emailed).toBe(true);
    // Applying asked them to confirm, confirming told the platform owner, and
    // approving tells the applicant.
    expect(sendMail).toHaveBeenCalledTimes(3);
    expect(sendMail).toHaveBeenLastCalledWith(expect.objectContaining({ to: applied.application.email }));
    expect(result.application.reviewChecks).toEqual(ALL_CHECKS);

    const venue = (await listVenues()).find((v) => v.id === result.application.venueId)!;
    expect(venue.name).toBe(applied.application.businessName);
    // Where it is, from the pin it applied with.
    expect(
      await getDb().prepare("SELECT lat, lng FROM venues WHERE id = ?").get(venue.id)
    ).toEqual(applied.application.pin);
    // They run a business of their own, with this as its first branch, so a
    // second branch later is a request rather than a second account.
    const operator = await authenticateAdmin(applied.application.email, "a long enough password");
    expect(operator?.businessName).toBe(applied.application.businessName);
    expect(operator?.venueIds).toEqual([venue.id]);

    // Once only.
    expect((await approveApplication(applied.application.id, ownerId, ALL_CHECKS)).ok).toBe(false);
  });

  it("says so when there is no email to tell them by", async () => {
    const applied = await apply();
    if (!applied.ok) throw new Error(applied.error);
    const result = await approveApplication(applied.application.id, ownerId, ALL_CHECKS);
    expect(result.ok && result.emailed).toBe(false);
  });

  it("needs every check ticked", async () => {
    const applied = await apply();
    if (!applied.ok) throw new Error(applied.error);
    const partly = await approveApplication(applied.application.id, ownerId, ["location", "phone"]);
    expect(partly).toEqual({ ok: false, error: "Tick every check before approving." });
  });
});

describe("where the venue is", () => {
  it("needs a pin, in Malaysia", async () => {
    expect(await apply({ lat: undefined, lng: undefined })).toMatchObject({ ok: false, error: expect.stringContaining("Drop a pin") });
    expect(await apply({ lat: "3.1", lng: "101.7" })).toMatchObject({ ok: false });
    expect(await apply({ lat: 51.5, lng: -0.12 })).toMatchObject({ ok: false, error: expect.stringContaining("outside Malaysia") });
  });

  it("says when nothing was looked up", async () => {
    const applied = await apply();
    if (!applied.ok) throw new Error(applied.error);
    expect((await locationReport(applied.application)).warnings).toEqual([
      "Addresses are not looked up on this install (MYSENAM_GEOCODER=off).",
    ]);
  });

  describe("looked up", () => {
    let lookups: string[];
    const answer = (search: unknown, reverse: unknown) =>
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: string) => {
          lookups.push(url);
          const body = url.includes("/search") ? search : reverse;
          return body === "down" ? new Response("", { status: 503 }) : Response.json(body);
        })
      );
    beforeEach(() => {
      lookups = [];
      process.env.MYSENAM_GEOCODER = "http://geo.test/";
      resetGeocoder();
    });
    afterEach(() => {
      vi.unstubAllGlobals();
      process.env.MYSENAM_GEOCODER = "off";
    });

    it("finds nothing wrong with a pin on its address, in its area", async () => {
      answer(
        [{ lat: "3.1040", lon: "101.7380", display_name: "12 Jalan Cheras" }],
        { display_name: "Taman Connaught, Cheras, Kuala Lumpur, Malaysia" }
      );
      const applied = await apply(CHERAS);
      if (!applied.ok) throw new Error(applied.error);
      expect(applied.application.found).toEqual({ lat: 3.104, lng: 101.738 });
      expect(applied.application.pinPlace).toContain("Cheras");
      const report = await locationReport(applied.application);
      expect(report.warnings).toEqual([]);
      expect(report.distanceM).toBeLessThan(200);
      // Asked politely: who is asking, and only in Malaysia.
      expect(lookups[0]).toMatch(/^http:\/\/geo\.test\/search\?.*countrycodes=my/);
    });

    it("points out a pin far from its address, in another area, on top of another venue", async () => {
      const there = await createVenue({ name: "Old Hall", area: "Ipoh", address: "1 Jalan Ipoh", phone: "0500000001" });
      if (!there.ok) throw new Error("venue");
      await getDb().prepare("UPDATE venues SET lat = ?, lng = ? WHERE id = ?").run(4.5975, 101.0901, there.venue.id);
      answer(
        [{ lat: "3.1040", lon: "101.7380", display_name: "12 Jalan Cheras" }],
        { display_name: "Greentown, Ipoh, Perak, Malaysia" }
      );
      const applied = await apply({ lat: 4.5976, lng: 101.0902 });
      if (!applied.ok) throw new Error(applied.error);
      const report = await locationReport(applied.application);
      expect(report.warnings).toEqual([
        "The pin is 181 km from where the address leads.",
        'The map puts the pin in Greentown, Ipoh, Perak, which doesn\'t mention "Cheras".',
        "Old Hall is already listed 16 m from the pin.",
      ]);
      expect(report.nearby.map((v) => v.name)).toEqual(["Old Hall"]);
    });

    it("says when the address cannot be found, or the map is down", async () => {
      answer([], "down");
      const applied = await apply({ address: "Lot 5, Kampung Baru Somewhere" });
      if (!applied.ok) throw new Error(applied.error);
      expect(applied.application.found).toBeNull();
      expect(applied.application.pinPlace).toBeNull();
      expect((await locationReport(applied.application)).warnings).toEqual([
        "The address could not be found on the map. Look it up yourself.",
      ]);
    });
  });
});

describe("confirming the email", () => {
  it("keeps the application from the platform owner until the link is followed", async () => {
    sendEmail();
    const applied = await apply();
    if (!applied.ok) throw new Error(applied.error);
    expect(applied.emailSent).toBe(true);
    expect(applied.application.emailCheck).toBe("waiting");
    const listed = async () => (await listApplications()).some((a) => a.id === applied.application.id);
    expect(await listed()).toBe(false);
    // Nobody has applied, as far as the platform owner knows.
    expect(sendMail).toHaveBeenCalledTimes(1);
    expect((await approveApplication(applied.application.id, ownerId, ALL_CHECKS)).ok).toBe(false);

    const token = linkToken();
    expect(await confirmApplicationEmail(token)).toBe("confirmed");
    expect(await listed()).toBe(true);
    expect(sendMail).toHaveBeenLastCalledWith(
      expect.objectContaining({ subject: `${applied.application.businessName} has applied to join` })
    );
    // The link works once.
    expect(await confirmApplicationEmail(token)).toBe("unknown");
    expect(await confirmApplicationEmail("")).toBe("unknown");
  });

  it("stops working after a week", async () => {
    sendEmail();
    const applied = await apply();
    if (!applied.ok) throw new Error(applied.error);
    await getDb()
      .prepare("UPDATE venue_applications SET created_at = datetime('now', '-8 days') WHERE id = ?")
      .run(applied.application.id);
    expect(await confirmApplicationEmail(linkToken())).toBe("unknown");
  });

  it("lets an unconfirmed application be sent again", async () => {
    sendEmail();
    const first = await apply({ email: "again@example.my" });
    const second = await apply({ email: "again@example.my" });
    expect(first.ok && second.ok).toBe(true);
    const rows = await getDb()
      .prepare("SELECT COUNT(*)::int AS n FROM venue_applications WHERE email = 'again@example.my'")
      .get() as { n: number };
    expect(rows.n).toBe(1);
  });

  it("goes straight through, marked, where the install cannot email", async () => {
    const applied = await apply();
    if (!applied.ok) throw new Error(applied.error);
    expect(applied.emailSent).toBe(false);
    expect(applied.application.emailCheck).toBe("unsent");
    expect((await listApplications()).some((a) => a.id === applied.application.id)).toBe(true);
  });
});

describe("turning one down", () => {
  it("keeps why, and drops the password", async () => {
    const applied = await apply();
    if (!applied.ok) throw new Error(applied.error);
    const result = await rejectApplication(applied.application.id, ownerId, "We do not cover Cheras yet.");
    expect(result.ok).toBe(true);
    const row = await getDb()
      .prepare("SELECT status, reason, password_hash FROM venue_applications WHERE id = ?")
      .get(applied.application.id) as { status: string; reason: string; password_hash: string };
    expect(row).toEqual({ status: "rejected", reason: "We do not cover Cheras yet.", password_hash: "" });
    expect(await authenticateAdmin(applied.application.email, "a long enough password")).toBeNull();
    // Waiting ones are listed first, the newest at the top.
    const pending = await apply();
    const listed = await listApplications();
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
    ...CHERAS,
    businessName: "Route Hall",
    area: "Ampang",
    address: "1 Jalan Ampang, KL",
    venuePhone: "0312345678",
    contactName: "Faiz",
    email: `route${++n}@example.my`,
    password: "another long password",
  });

  it("look addresses up for the map, a few at a time", async () => {
    const { GET } = await import("../src/app/api/geocode/route");
    const ask = (q: string) =>
      GET(new NextRequest(`http://localhost/api/geocode?q=${encodeURIComponent(q)}`, { headers: { "x-forwarded-for": "10.9.9.9" } }));
    expect((await ask("ab")).status).toBe(400);
    const res = await ask("12 Jalan Cheras");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ found: null });
  });

  it("only exist on a marketplace", async () => {
    expect((await (await publicRoute()).POST(post(form()))).status).toBe(404);
    process.env.MYSENAM_MARKETPLACE = "on";
    expect((await (await publicRoute()).POST(post(form()))).status).toBe(201);
  });

  it("quietly drop what a script filled in", async () => {
    process.env.MYSENAM_MARKETPLACE = "on";
    const before = (await listApplications()).length;
    const res = await (await publicRoute()).POST(post({ ...form(), website: "http://spam.example" }));
    expect(res.status).toBe(201);
    expect(await listApplications()).toHaveLength(before);
  });

  it("are decided by the platform owner only", async () => {
    const desk = await createAdmin({
      name: "Desk",
      email: "desk-apps@example.com",
      password: "desk-password",
      venueId: (await listVenues())[0].id,
    });
    if (!desk.ok) throw new Error(desk.error);
    const asDesk = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.admin.id)).token}`;
    const asOwner = `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(ownerId)).token}`;
    const get = (cookie: string) =>
      new NextRequest("http://localhost/api/admin/venue-applications", { headers: { cookie } });
    const mod = await adminRoute();
    expect((await mod.GET(get(asDesk))).status).toBe(403);
    expect((await mod.GET(get(asOwner))).status).toBe(200);

    const applied = await apply();
    if (!applied.ok) throw new Error(applied.error);
    const decide = (body: object) =>
      mod.POST(
        new NextRequest("http://localhost/api/admin/venue-applications", {
          method: "POST",
          headers: { "content-type": "application/json", cookie: asOwner },
          body: JSON.stringify(body),
        })
      );
    expect((await decide({ id: applied.application.id, decision: "approve" })).status).toBe(409);
    const approved = await decide({ id: applied.application.id, decision: "approve", checks: ALL_CHECKS });
    expect(approved.status).toBe(200);
  });
});
