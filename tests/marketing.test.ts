import { beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

// The language the customer is browsing in, as the booking route reads it.
let browsing: string | undefined;
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => (browsing ? { value: browsing } : undefined) }),
}));

import { NextRequest } from "next/server";
import { unsubscribeHeaders } from "../src/lib/transports";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { createSession, registerUser, SESSION_COOKIE } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { audience, MAX_CAMPAIGNS_PER_30_DAYS, recordConsent, sendCampaign, testCampaign } from "../src/lib/marketing";
import { eraseCustomer, exportCustomerData } from "../src/lib/privacy";
import { createCourt, createVenue } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";
import { POST as book } from "../src/app/api/bookings/route";
import { POST as unsubscribeRoute } from "../src/app/api/unsubscribe/route";
import { GET as myGet, POST as myPost } from "../src/app/api/my/marketing/route";
import { POST as staffPost } from "../src/app/api/admin/marketing/route";

/**
 * News from a venue: only to those who ticked the box, with the words they
 * agreed to kept, one click to stop, a footer on every copy in their own
 * language, and a limit on how often.
 */

let venueId: number;
let courtId: number;
let n = 0;

const post = (body: Record<string, unknown>) =>
  book(
    new NextRequest("http://localhost/api/bookings", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": `198.51.100.${++n}` },
      body: JSON.stringify({ courtId, date: addDays(todayISO(), 1 + (n % 10)), hours: [8 + (n % 12)], name: "Customer Lim", phone: `01244400${String(n).padStart(2, "0")}`, ...body }),
    })
  );

const consents = async () =>
  (await getDb().prepare("SELECT email, wording, locale, withdrawn_at, confirmed_at, token FROM marketing_consents WHERE venue_id = ? ORDER BY id").all(venueId)) as {
    email: string;
    wording: string;
    locale: string;
    withdrawn_at: string | null;
    confirmed_at: string | null;
    token: string;
  }[];

beforeAll(async () => {
  const made = await createVenue({ name: "News Arena", area: "PJ", address: "x", phone: "0344440000" });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
  const court = await createCourt({ venueId, name: "Court 1", sport: "badminton", offPeakRate: 20, peakRate: 20 });
  if (!court.ok) throw new Error("court");
  courtId = court.court.id;
});

describe("agreeing", () => {
  it("happens only when the box is ticked, with an email, and keeps the words agreed to", async () => {
    expect((await post({ email: "untick@example.my" })).status).toBe(201);
    expect((await post({ marketing: true })).status).toBe(201);
    expect(await consents()).toEqual([]);
    browsing = "ms";
    expect((await post({ email: "Siti@Example.my", marketing: true })).status).toBe(201);
    browsing = undefined;
    const [c] = await consents();
    expect(c).toMatchObject({ email: "Siti@Example.my", locale: "ms", withdrawn_at: null });
    expect(c.wording).toBe("E-melkan saya berita dan tawaran daripada News Arena. Saya boleh berhenti melanggan pada bila-bila masa.");
    // Typed in by whoever booked: nothing goes to it until the address says yes itself.
    expect(c.confirmed_at).toBeNull();
    const ask = (await getDb().prepare("SELECT recipient, body FROM messages WHERE kind = 'marketing_confirm'").all()) as { recipient: string; body: string }[];
    expect(ask).toHaveLength(1);
    expect(ask[0].body).toContain(`/unsubscribe/${c.token}`);
  });

  it("is one per address per venue, however often it is ticked", async () => {
    browsing = "ms";
    await post({ email: "siti@example.my", marketing: true });
    browsing = undefined;
    expect(await consents()).toHaveLength(1);
  });
});

describe("a venue's news", () => {
  it("waits for an address to confirm, from the email that asked", async () => {
    expect(await audience(venueId)).toMatchObject({ subscribed: 0, waiting: 1 });
    expect(await sendCampaign(venueId, null, { subject: "Too soon", body: "Nobody has said yes yet." })).toMatchObject({ ok: false });
    const siti = (await consents()).find((c) => c.email.toLowerCase() === "siti@example.my")!;
    const res = await unsubscribeRoute(
      new NextRequest("http://localhost/api/unsubscribe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: siti.token, confirm: true }),
      })
    );
    expect(res.status).toBe(200);
    expect(await audience(venueId)).toMatchObject({ subscribed: 1, waiting: 0 });
  });

  it("goes to those who agreed, with why and how to stop in their own language", async () => {
    await recordConsent({ venueId, email: "ali@example.my", name: "Ali", locale: "en", source: "booking", confirmed: true });
    const sent = await sendCampaign(venueId, null, { subject: "Raya opening hours", body: "We open at 10am on the first day of Raya." });
    expect(sent).toMatchObject({ ok: true, recipients: 2 });
    const msgs = (await getDb().prepare("SELECT recipient, subject, body FROM messages WHERE kind = 'campaign' ORDER BY id").all()) as {
      recipient: string;
      subject: string;
      body: string;
    }[];
    const ali = msgs.find((m) => m.recipient === "ali@example.my")!;
    expect(ali.subject).toBe("News Arena: Raya opening hours");
    expect(ali.body).toContain("We open at 10am on the first day of Raya.");
    expect(ali.body).toMatch(/Unsubscribe in one click: https:\/\/book\.example\.my\/unsubscribe\/[\w-]+/);
    expect(msgs.find((m) => m.recipient.toLowerCase() === "siti@example.my")!.body).toContain("Berhenti melanggan dengan satu klik");
  });

  it("carries the mail app's one-click unsubscribe, which works by POST alone", async () => {
    const ali = (await consents()).find((c) => c.email === "ali@example.my")!;
    expect(unsubscribeHeaders(`https://book.example.my/unsubscribe/${ali.token}`)).toEqual({
      headers: {
        "List-Unsubscribe": `<https://book.example.my/api/unsubscribe/${ali.token}>`,
        "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
      },
    });
    expect(unsubscribeHeaders(undefined)).toEqual({});
    const { POST: oneClick } = await import("../src/app/api/unsubscribe/[token]/route");
    const res = await oneClick(new NextRequest(`http://localhost/api/unsubscribe/${ali.token}`, { method: "POST", body: "List-Unsubscribe=One-Click" }), {
      params: Promise.resolve({ token: ali.token }),
    });
    expect(res.status).toBe(200);
    expect((await consents()).find((c) => c.email === "ali@example.my")!.withdrawn_at).not.toBeNull();
    // Back on, for what follows.
    await recordConsent({ venueId, email: "ali@example.my", name: "Ali", locale: "en", source: "booking", confirmed: true });
  });

  it("stops for anybody who clicks the link, with no account", async () => {
    const siti = (await consents()).find((c) => c.email.toLowerCase() === "siti@example.my")!;
    const res = await unsubscribeRoute(
      new NextRequest("http://localhost/api/unsubscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: siti.token }) })
    );
    expect(res.status).toBe(200);
    expect((await audience(venueId)).subscribed).toBe(1);
    // Ticked again for the address that stopped: it has to say yes again itself.
    await recordConsent({ venueId, email: siti.email, locale: "ms", source: "booking", confirmed: false });
    expect(await audience(venueId)).toMatchObject({ subscribed: 1, waiting: 1 });
    const bad = await unsubscribeRoute(
      new NextRequest("http://localhost/api/unsubscribe", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: "nope" }) })
    );
    expect(bad.status).toBe(404);
  });

  it("is limited to a few a month, and a test copy is marked and does not count", async () => {
    expect(await testCampaign(venueId, "me@venue.my", { subject: "Try", body: "Seeing how it looks." })).toMatchObject({ ok: true });
    const test = (await getDb().prepare("SELECT subject, body FROM messages WHERE recipient = 'me@venue.my'").get()) as { subject: string; body: string };
    expect(test.subject).toBe("News Arena: [Test] Try");
    expect(test.body).toContain("A test:");
    for (let i = 1; i < MAX_CAMPAIGNS_PER_30_DAYS; i++)
      expect(await sendCampaign(venueId, null, { subject: `Week ${i}`, body: "Something worth saying." })).toMatchObject({ ok: true });
    expect(await sendCampaign(venueId, null, { subject: "One too many", body: "Something worth saying." })).toMatchObject({ ok: false });
    expect((await audience(venueId)).left).toBe(0);
  });

  it("is for managers to send", async () => {
    const desk = await createAdmin({ name: "Desk", email: "desk@news.my", password: "desk-password-1", venueId, role: "desk" });
    if (!desk.ok) throw new Error(desk.error);
    const res = await staffPost(
      new NextRequest("http://localhost/api/admin/marketing", {
        method: "POST",
        headers: { cookie: `${ADMIN_SESSION_COOKIE}=${(await createAdminSession(desk.admin.id)).token}`, "content-type": "application/json" },
        body: JSON.stringify({ venueId, action: "test", subject: "Hi there", body: "Something worth saying." }),
      })
    );
    expect(res.status).toBe(403);
  });
});

describe("an account", () => {
  it("sees and stops what it agreed to, has it in its data, and loses it on closing", async () => {
    const user = await registerUser({ name: "Mei", email: "mei@example.my", phone: "0136660001", password: "a long enough password" });
    if (!user.ok) throw new Error(user.error);
    await recordConsent({ venueId, email: "MEI@example.my", locale: "en", source: "booking", confirmed: true });
    const cookie = `${SESSION_COOKIE}=${(await createSession(user.user.id)).token}`;
    const list = await (await myGet(new NextRequest("http://localhost/api/my/marketing", { headers: { cookie } }))).json();
    expect(list.consents).toHaveLength(1);
    expect((await exportCustomerData(user.user.id))!.marketing).toHaveLength(1);
    const stopped = await myPost(
      new NextRequest("http://localhost/api/my/marketing", {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify({ id: list.consents[0].id }),
      })
    );
    expect((await stopped.json()).consents[0].withdrawnAt).not.toBeNull();
    expect(await eraseCustomer(user.user.id)).toMatchObject({ ok: true });
    expect((await consents()).some((c) => c.email.toLowerCase() === "mei@example.my")).toBe(false);
  });
});
