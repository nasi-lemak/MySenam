import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_MARKETPLACE = "on";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, authenticateAdmin, createAdmin, createAdminSession, ensureBootstrapAdmin, listAdmins, type Admin } from "../src/lib/admin-auth";
import { submitApplication } from "../src/lib/applications";
import { registerUser } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { resetRateLimits } from "../src/lib/rate-limit";
import { createBooking, createCourt, createVenue, topUpWallet } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { maskedName } from "../src/lib/customer-lookup";
import { GET as walletGet } from "../src/app/api/admin/wallet/route";
import { POST as passesPost } from "../src/app/api/admin/passes/route";

/**
 * What staff may find out about a customer from an email or a phone number (lib/customer-lookup.ts, ADR 0057):
 * only a customer with a relationship with their own venues (a booking, credit, a pass, ...), throttled; the linking
 * flows are not open to a draft venue. Anybody can sign up as a venue and be given a staff account.
 */
let venueA: number;
let venueB: number;
let courtA: number;
let courtB: number;
let businessId: number;
let deskA: Admin;
let deskB: Admin;
let bizManager: Admin;
let owner: Admin;
let regularA: { id: number };
let regularB: { id: number };


const cookieFor = async (id: number) => `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(id)).token}`;
const ask = async (admin: Admin, q: string, venue: number) =>
  walletGet(new NextRequest(`http://localhost/api/admin/wallet?q=${encodeURIComponent(q)}&venueId=${venue}`, { headers: { cookie: await cookieFor(admin.id) } }));

async function customer(name: string, email: string, phone: string) {
  const made = await registerUser({ name, email, phone, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  return made.user;
}

beforeAll(async () => {
  await ensureBootstrapAdmin();
  owner = (await listAdmins()).find((a) => a.venueId === null && a.businessId === null)!;
  const a = await createVenue({ name: "Hall A", area: "PJ", address: "1 Jalan A", phone: "0377770001" });
  const b = await createVenue({ name: "Hall B", area: "KL", address: "1 Jalan B", phone: "0377770002" });
  if (!a.ok || !b.ok) throw new Error("venue");
  venueA = a.venue.id;
  venueB = b.venue.id;
  courtA = ((await createCourt({ venueId: venueA, name: "C1", sport: "badminton", offPeakRate: 10, peakRate: 10 })) as { court: { id: number } }).court.id;
  courtB = ((await createCourt({ venueId: venueB, name: "C1", sport: "badminton", offPeakRate: 10, peakRate: 10 })) as { court: { id: number } }).court.id;
  businessId = ((await getDb().prepare("INSERT INTO businesses (name) VALUES ('Chain') RETURNING id").get()) as { id: number }).id;
  await getDb().prepare("UPDATE venues SET business_id = ? WHERE id IN (?, ?)").run(businessId, venueA, venueB);
  const d1 = await createAdmin({ name: "Desk A", email: "desk-a@chain.my", password: "a long enough password", venueId: venueA, role: "desk" });
  const bm = await createAdmin({ name: "Bina", email: "bina@chain.my", password: "a long enough password", venueId: null, businessId });
  if (!d1.ok || !bm.ok) throw new Error("staff");
  deskA = d1.admin;
  bizManager = bm.admin;
  // A second business: its desk must not see the first's customers.
  const other = await createVenue({ name: "Other Hall", area: "JB", address: "1 Jalan C", phone: "0377770003" });
  if (!other.ok) throw new Error("venue");
  const d2 = await createAdmin({ name: "Desk B", email: "desk-b@other.my", password: "a long enough password", venueId: other.venue.id, role: "desk" });
  if (!d2.ok) throw new Error("staff");
  deskB = d2.admin;

  regularA = await customer("Rina Regular", "rina@example.my", "0121110001");
  regularB = await customer("Bob Branch", "bob@example.my", "0121110002");
  await customer("Siti Strangerwoman", "siti@elsewhere.my", "0123456789");
  const day = addDays(todayISO(), 5);
  const b1 = await createBooking({ courtId: courtA, date: day, hours: [10], name: "Rina Regular", phone: "0121110001", email: "rina@example.my", userId: regularA.id });
  const b2 = await createBooking({ courtId: courtB, date: day, hours: [10], name: "Bob Branch", phone: "0121110002", email: "bob@example.my", userId: regularB.id });
  if (!b1.ok || !b2.ok) throw new Error("booking");
});

beforeEach(async () => {
  await resetRateLimits();
});

afterAll(() => {
  process.env.MYSENAM_MARKETPLACE = "on";
});

describe("a customer lookup at the counter on the marketplace", () => {
  it("finds a customer who has booked at the venue, by email or by number", async () => {
    for (const q of ["rina@example.my", "0121110001"]) {
      const res = await ask(deskA, q, venueA);
      expect(res.status, q).toBe(200);
      expect(((await res.json()) as { customer: { id: number } }).customer.id).toBe(regularA.id);
    }
  });

  it("does not find a customer with no relationship with the venue, and says no more than 'not found'", async () => {
    const res = await ask(deskA, "0123456789", venueA);
    expect(res.status).toBe(404);
    const text = await res.text();
    expect(text).not.toMatch(/Siti|siti@elsewhere/);
    expect((await ask(deskA, "siti@elsewhere.my", venueA)).status).toBe(404);
  });

  it("does not find a customer of another business's venue", async () => {
    expect((await ask(deskB, "rina@example.my", deskB.venueIds![0])).status).toBe(404);
  });

  it("finds a customer of a sibling branch for the business manager, not for the other branch's desk", async () => {
    expect((await ask(bizManager, "bob@example.my", venueB)).status).toBe(200);
    expect((await ask(deskA, "bob@example.my", venueA)).status).toBe(404);
  });

  it("finds a customer who holds credit or a pass at the venue, though they never booked", async () => {
    const holder = await customer("Cleo Credit", "cleo@example.my", "0121110003");
    expect((await ask(deskA, "cleo@example.my", venueA)).status).toBe(404);
    const topped = await topUpWallet({ userId: holder.id, amount: 20, adminId: deskA.id, venueId: venueA, via: "cash", counterVenueId: venueA });
    expect(topped.ok).toBe(true);
    expect((await ask(deskA, "cleo@example.my", venueA)).status).toBe(200);
    expect((await ask(deskB, "cleo@example.my", deskB.venueIds![0])).status).toBe(404);
  });

  it("finds a customer who booked as a guest with the same email, since the venue already holds it", async () => {
    await customer("Gus Guest", "gus@example.my", "0121110004");
    const day = addDays(todayISO(), 6);
    const made = await createBooking({ courtId: courtA, date: day, hours: [11], name: "Gus", phone: "0199999999", email: "gus@example.my" });
    expect(made.ok).toBe(true);
    expect((await ask(deskA, "gus@example.my", venueA)).status).toBe(200);
  });

  it("lets the platform owner look any customer up, since they run the install", async () => {
    expect((await ask(owner, "siti@elsewhere.my", venueA)).status).toBe(200);
  });

  it("slows a probing loop down: 30 an hour for one staff account", async () => {
    let limited = 0;
    let answered = 0;
    for (let i = 0; i < 40; i++) {
      const res = await ask(deskA, `01234567${String(i).padStart(2, "0")}`, venueA);
      if (res.status === 429) limited++;
      else answered++;
    }
    expect(answered).toBe(30);
    expect(limited).toBe(10);
    // Another member of staff has their own allowance, and a found customer counts as a lookup too.
    expect((await ask(bizManager, "bob@example.my", venueB)).status).toBe(200);
  });

  it("is not narrowed on an install that is one business's own (not the marketplace), but is still throttled", async () => {
    process.env.MYSENAM_MARKETPLACE = "";
    try {
      expect((await ask(deskA, "siti@elsewhere.my", venueA)).status).toBe(200);
      let limited = false;
      for (let i = 0; i < 40 && !limited; i++) limited = (await ask(deskA, `x${i}@nobody.my`, venueA)).status === 429;
      expect(limited).toBe(true);
    } finally {
      process.env.MYSENAM_MARKETPLACE = "on";
    }
  });
});

describe("linking a sale to an account by email", () => {
  const sellPass = async (admin: Admin, venueId: number, accountEmail: string) =>
    passesPost(
      new NextRequest("http://localhost/api/admin/passes", {
        method: "POST",
        headers: { "content-type": "application/json", cookie: await cookieFor(admin.id) },
        body: JSON.stringify({ venueId, name: "Ten hours", holderName: "Rina", holderPhone: "0121110001", accountEmail, entries: 10, expiresOn: addDays(todayISO(), 60), price: 0, priceReason: "Test sale for the lookup tests" }),
      })
    );

  it("is not open to a draft venue's staff: an email there is never confirmed to be an account", async () => {
    const applied = await submitApplication({
      businessName: "Shell Co", area: "Ipoh", address: "1 Jalan Shell", venuePhone: "0500000000", contactName: "Mallory",
      email: "mallory@shell.my", password: "a long enough password", lat: 4.6, lng: 101.08,
    });
    if (!applied.ok) throw new Error(applied.error);
    const mallory = (await authenticateAdmin("mallory@shell.my", "a long enough password"))!;
    const res = await sellPass(mallory, applied.application.venueId!, "siti@elsewhere.my");
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe("LOOKUP_NOT_LIVE");
    const also = await sellPass(mallory, applied.application.venueId!, "nobody-at-all@elsewhere.my");
    expect(also.status).toBe(403);
  });

  it("works for a live venue's manager, and is throttled", async () => {
    const res = await sellPass(bizManager, venueA, "rina@example.my");
    expect(res.status, await res.clone().text()).toBe(201);
    let limited = false;
    for (let i = 0; i < 40 && !limited; i++) limited = (await sellPass(bizManager, venueA, `nobody${i}@elsewhere.my`)).status === 429;
    expect(limited).toBe(true);
  });
});

describe("what is shown of an account staff were not given the name of", () => {
  it("is initials only", () => {
    expect(maskedName("Siti Aminah binti Ali")).toBe("S. A. B. A.");
    expect(maskedName("  ")).toBe("");
  });
});
