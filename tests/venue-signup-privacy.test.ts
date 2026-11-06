import { afterEach, beforeAll, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_MARKETPLACE = "on";
process.env.MYSENAM_URL = "https://book.example.my";

import { NextRequest } from "next/server";
import { createAdmin, ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { getDb } from "../src/lib/db";
import { setTransport } from "../src/lib/outbox";
import { resetRateLimits } from "../src/lib/rate-limit";
import { createVenue } from "../src/lib/store";
import { POST as apply } from "../src/app/api/venue-applications/route";

/**
 * Venue sign-up does not say whether an email address belongs to somebody who works at a venue (audit 9, A12): a new address, a
 * staff account's and one with a sign-up waiting all get the same answer, and the known address is emailed what it can do.
 */
const sent: { to: string; subject: string; body: string }[] = [];
let n = 0;

const body = (email: string) => ({
  businessName: `Sign-up Hall ${++n}`,
  area: "Ipoh",
  address: `${n} Jalan Baru`,
  venuePhone: "0500000000",
  contactName: "Mallory Prober",
  email,
  password: "a long enough password",
  lat: 4.6 + n / 1000,
  lng: 101.08,
});
const post = (payload: unknown) =>
  apply(new NextRequest("http://localhost/api/venue-applications", { method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${n + 1}` }, body: JSON.stringify(payload) }));

beforeAll(async () => {
  await ensureBootstrapAdmin();
  const v = await createVenue({ name: "Existing Hall", area: "PJ", address: "1 Jalan Ada", phone: "0377770099" });
  if (!v.ok) throw new Error("venue");
  const staff = await createAdmin({ name: "Existing Manager", email: "manager@existing.my", password: "a long enough password", venueId: v.venue.id, role: "manager" });
  if (!staff.ok) throw new Error("staff");
});

afterEach(async () => {
  setTransport(null);
  sent.length = 0;
  await resetRateLimits();
});

const withMail = () => setTransport({ name: "test", send: async (m) => void sent.push({ to: m.recipient, subject: m.subject ?? "", body: m.body }) });

describe("signing a venue up with an address", () => {
  it("gives a staff account's address the same answer as a new one, and emails that address", async () => {
    withMail();
    const fresh = await post(body("brand.new@elsewhere.my"));
    const known = await post(body("manager@existing.my"));
    expect(fresh.status).toBe(201);
    expect(known.status).toBe(201);
    expect(await known.json()).toEqual(await fresh.json());
    const told = sent.filter((m) => m.to === "manager@existing.my");
    expect(told).toHaveLength(1);
    expect(told[0].body).toContain("already has a venue account");
    expect(told[0].body).toContain("/admin");
    // Nothing was made for it: no application, no second account.
    expect(((await getDb().prepare("SELECT COUNT(*)::int AS n FROM venue_applications WHERE email = 'manager@existing.my'").get()) as { n: number }).n).toBe(0);
    // The new address was asked to confirm, as before.
    expect(sent.some((m) => m.to === "brand.new@elsewhere.my" && m.body.includes("/list-your-venue/confirm?token="))).toBe(true);
  });

  it("does not say there is an application waiting either, and does not email one address more than once an hour", async () => {
    withMail();
    // An application waiting: submitted, not yet a draft account (venue_id null), as a go-live request leaves it.
    await getDb()
      .prepare(
        `INSERT INTO venue_applications (business_name, area, address, venue_phone, contact_name, email, password_hash, lat, lng, email_check, status)
         VALUES ('Waiting Hall', 'Ipoh', '1 Jalan Tunggu', '0500000001', 'Wendy', 'waiting@elsewhere.my', 'x', 4.6, 101.08, 'confirmed', 'pending')`
      )
      .run();
    const first = await post(body("waiting@elsewhere.my"));
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({ ok: true, emailSent: true });
    await post(body("waiting@elsewhere.my"));
    await post(body("manager@existing.my"));
    await post(body("manager@existing.my"));
    const queued = async (to: string) =>
      ((await getDb().prepare("SELECT COUNT(*)::int AS n FROM messages WHERE recipient = ? AND dedupe_key LIKE 'application-known:%'").get(to)) as { n: number }).n;
    expect(await queued("waiting@elsewhere.my")).toBe(1);
    // (The staff account's address was emailed in the test before, in the same hour.)
    expect(await queued("manager@existing.my")).toBe(1);
  });

  it("still refuses a bad form as before (a short password is not a secret)", async () => {
    withMail();
    const res = await post({ ...body("manager@existing.my"), password: "short" });
    expect(res.status).toBe(400);
  });
});
