import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

// The booking route reads the customer's language from a cookie.
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ensureBootstrapAdmin } from "../src/lib/admin-auth";
import { createSession, registerUser, SESSION_COOKIE } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import {
  decodePending,
  encodePending,
  finishGoogle,
  googleOfferedAt,
  safeNext,
  signInWithIdentity,
  startGoogle,
  type PendingSignIn,
} from "../src/lib/oauth";
import {
  confirmPhoneCode,
  MAX_TRIES,
  phoneRefusal,
  phoneStatus,
  savePhone,
  sendPhoneCode,
  SENDS_PER_HOUR,
} from "../src/lib/phone-check";
import { resetRateLimits } from "../src/lib/rate-limit";
import { listBookingsForDate, listVenues } from "../src/lib/store";
import { addDays, todayISO } from "../src/lib/time";

/** Signing in with Google, and a phone number checked with a code on WhatsApp. */

let courtId: number;
let n = 0;

const google = () => {
  vi.stubEnv("GOOGLE_CLIENT_ID", "client-123.apps.googleusercontent.com");
  vi.stubEnv("GOOGLE_CLIENT_SECRET", "shh");
  vi.stubEnv("MYSENAM_URL", "https://mysenam.my");
};

/** What Google's token endpoint would hand back: an ID token with these claims. */
function idToken(claims: Record<string, unknown>): string {
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${part({ alg: "RS256" })}.${part(claims)}.signature`;
}

function googleAnswers(claims: Record<string, unknown>, status = 200) {
  const calls: { url: string; body: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init: RequestInit) => {
      calls.push({ url: String(url), body: String(init.body) });
      return Response.json({ id_token: idToken(claims) }, { status });
    })
  );
  return calls;
}

function claimsFor(pending: PendingSignIn, over: Record<string, unknown> = {}) {
  n++;
  return {
    iss: "https://accounts.google.com",
    aud: "client-123.apps.googleusercontent.com",
    sub: `google-${n}`,
    exp: Math.floor(Date.now() / 1000) + 600,
    nonce: pending.nonce,
    email: `person${n}@gmail.com`,
    email_verified: true,
    name: `Person ${n}`,
    ...over,
  };
}

/** WhatsApp set up, and every code it is asked to send, caught. */
function whatsapp(): string[] {
  vi.stubEnv("WHATSAPP_TOKEN", "token");
  vi.stubEnv("WHATSAPP_PHONE_NUMBER_ID", "12345");
  const codes: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      codes.push(body.template.components[0].parameters[0].text);
      return Response.json({ messages: [{ id: "wamid" }] });
    })
  );
  return codes;
}

async function account(phone = "0123456789") {
  n++;
  const made = await registerUser({ name: `Holder ${n}`, email: `holder${n}@x.my`, phone, password: "a long enough password" });
  if (!made.ok) throw new Error(made.error);
  return made.user;
}

beforeAll(async () => {
  await ensureBootstrapAdmin();
  courtId = (await listVenues())[0].courts[0].id;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetRateLimits();
});

describe("signing in with Google", () => {
  it("is offered only where it is set up, at the address Google sends people back to", () => {
    expect(googleOfferedAt("mysenam.my")).toBe(false);
    google();
    expect(googleOfferedAt("mysenam.my")).toBe(true);
    expect(googleOfferedAt("courts.somevenue.my")).toBe(false);
    expect(googleOfferedAt(null)).toBe(false);
  });

  it("asks with PKCE, a state and a nonce, and comes back only to this site", () => {
    google();
    const started = startGoogle("/venue/1?date=2026-11-01")!;
    const url = new URL(started.url);
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(url.searchParams.get("redirect_uri")).toBe("https://mysenam.my/api/auth/google/callback");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe(started.pending.state);
    expect(url.searchParams.get("nonce")).toBe(started.pending.nonce);
    expect(url.searchParams.get("code_challenge")).not.toContain(started.pending.verifier);
    expect(started.pending.next).toBe("/venue/1?date=2026-11-01");
    expect(decodePending(encodePending(started.pending))).toEqual(started.pending);
    expect(decodePending("not-json")).toBeNull();
    for (const bad of ["https://evil.example", "//evil.example", "/\\evil.example", null, ""]) expect(safeNext(bad)).toBe("/account");
  });

  it("makes an account the first time, with no password and no phone, and finds it after", async () => {
    google();
    const { pending } = startGoogle(null)!;
    const claims = claimsFor(pending);
    const calls = googleAnswers(claims);
    const first = await finishGoogle({ code: "abc", state: pending.state, error: null }, pending);
    expect(first).toMatchObject({ ok: true, created: true });
    expect(calls[0].url).toBe("https://oauth2.googleapis.com/token");
    expect(calls[0].body).toContain(`code_verifier=${pending.verifier}`);
    if (!first.ok) return;
    const row = (await getDb().prepare("SELECT name, phone, password_hash FROM users WHERE id = ?").get(first.userId)) as Record<string, string>;
    expect(row).toEqual({ name: claims.name, phone: "", password_hash: "" });
    // The same person again — even with a changed email — is the same account.
    googleAnswers({ ...claims, email: "renamed@gmail.com" });
    expect(await finishGoogle({ code: "abc", state: pending.state, error: null }, pending)).toMatchObject({ ok: true, userId: first.userId, created: false });
  });

  it("joins an existing account by email only when Google has verified it", async () => {
    google();
    const existing = await account();
    const { pending } = startGoogle(null)!;
    googleAnswers(claimsFor(pending, { email: existing.email, email_verified: false }));
    expect(await finishGoogle({ code: "x", state: pending.state, error: null }, pending)).toMatchObject({
      ok: false,
      error: expect.stringContaining("Sign in with your password"),
    });
    googleAnswers(claimsFor(pending, { email: existing.email, email_verified: "true" }));
    expect(await finishGoogle({ code: "x", state: pending.state, error: null }, pending)).toMatchObject({ ok: true, userId: existing.id });
  });

  it("refuses an answer that is not for this sign-in", async () => {
    google();
    const { pending } = startGoogle(null)!;
    const finish = (claims: Record<string, unknown>, state = pending.state, saved: PendingSignIn | null = pending) => {
      googleAnswers(claims);
      return finishGoogle({ code: "x", state, error: null }, saved);
    };
    expect(await finish(claimsFor(pending), "forged-state-forged-state-xx")).toMatchObject({ ok: false });
    expect(await finish(claimsFor(pending), pending.state, null)).toMatchObject({ ok: false });
    expect(await finish(claimsFor(pending, { nonce: "replayed" }))).toMatchObject({ ok: false });
    expect(await finish(claimsFor(pending, { aud: "somebody-else" }))).toMatchObject({ ok: false });
    expect(await finish(claimsFor(pending, { iss: "https://evil.example" }))).toMatchObject({ ok: false });
    expect(await finish(claimsFor(pending, { exp: 1 }))).toMatchObject({ ok: false });
    expect(await finish(claimsFor(pending, { email: undefined }))).toMatchObject({ ok: false });
    expect(await finishGoogle({ code: null, state: null, error: "access_denied" }, pending)).toMatchObject({ ok: false, error: expect.stringContaining("cancelled") });
    googleAnswers(claimsFor(pending), 400);
    expect(await finishGoogle({ code: "x", state: pending.state, error: null }, pending)).toMatchObject({ ok: false });
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ id_token: "garbage" })));
    expect(await finishGoogle({ code: "x", state: pending.state, error: null }, pending)).toMatchObject({ ok: false });
    vi.unstubAllEnvs();
    expect(await finishGoogle({ code: "x", state: pending.state, error: null }, pending)).toMatchObject({ ok: false });
  });

  it("through the routes: off to Google with a cookie, back signed in to where they were", async () => {
    google();
    const start = await import("../src/app/api/auth/google/route");
    const off = await start.GET(new NextRequest("https://mysenam.my/api/auth/google?next=/games", { headers: { host: "mysenam.my" } }));
    expect(off.status).toBe(307);
    expect(off.headers.get("location")).toMatch(/^https:\/\/accounts\.google\.com\//);
    const cookie = off.cookies.get("ms_oauth")!;
    expect(cookie.httpOnly).toBe(true);
    const pending = decodePending(cookie.value)!;
    expect(pending.next).toBe("/games");

    googleAnswers(claimsFor(pending));
    const back = await import("../src/app/api/auth/google/callback/route");
    const res = await back.GET(
      new NextRequest(`https://mysenam.my/api/auth/google/callback?code=c&state=${pending.state}`, { headers: { cookie: `ms_oauth=${cookie.value}` } })
    );
    expect(res.headers.get("location")).toBe("https://mysenam.my/games");
    expect(res.cookies.get(SESSION_COOKIE)?.value).toMatch(/^[a-f0-9]{64}$/);

    const failed = await back.GET(new NextRequest("https://mysenam.my/api/auth/google/callback?code=c&state=nope"));
    expect(failed.headers.get("location")).toContain("/login?error=");
    expect(failed.cookies.get(SESSION_COOKIE)).toBeUndefined();

    const elsewhere = await start.GET(new NextRequest("https://courts.venue.my/api/auth/google", { headers: { host: "courts.venue.my" } }));
    expect(elsewhere.headers.get("location")).toContain("/login?error=google");
    const providers = await import("../src/app/api/auth/providers/route");
    expect(await (await providers.GET(new NextRequest("https://mysenam.my/x", { headers: { host: "mysenam.my" } }))).json()).toEqual({ google: true });
  });
});

describe("a phone number", () => {
  it("is needed before an account books, and taken as given where numbers are not checked", async () => {
    const made = await signInWithIdentity({ provider: "google", subject: `no-phone-${++n}`, email: `nophone${n}@gmail.com`, emailVerified: true });
    if (!made.ok) throw new Error(made.error);
    expect(await phoneRefusal(made.userId)).toMatchObject({ code: "PHONE_NEEDED" });
    expect(await savePhone(made.userId, "not a phone")).toMatchObject({ ok: false });
    expect(await savePhone(made.userId, "012-555 0101")).toEqual({ ok: true });
    expect(await phoneStatus(made.userId)).toMatchObject({ phone: "012-555 0101", verified: false, checks: false });
    expect(await phoneRefusal(made.userId)).toBeNull();
  });

  it("is checked with a code on WhatsApp where WhatsApp is set up", async () => {
    const codes = whatsapp();
    const user = await account("012-777 1234");
    expect(await phoneRefusal(user.id)).toMatchObject({ code: "PHONE_UNVERIFIED" });
    expect(await savePhone(user.id, "0127771234")).toMatchObject({ ok: false });
    expect(await sendPhoneCode(user.id, "012-777 1234")).toEqual({ ok: true, sent: true });
    expect(codes[0]).toMatch(/^\d{6}$/);
    const wrong = codes[0] === "000000" ? "111111" : "000000";
    expect(await confirmPhoneCode(user.id, wrong)).toMatchObject({ ok: false, code: "PHONE_CODE_WRONG" });
    expect(await confirmPhoneCode(user.id, ` ${codes[0].slice(0, 3)} ${codes[0].slice(3)} `)).toEqual({ ok: true });
    expect(await phoneStatus(user.id)).toMatchObject({ verified: true, checks: true });
    expect(await phoneRefusal(user.id)).toBeNull();
    // Only a hash was kept, and now not even that.
    expect(await getDb().prepare("SELECT 1 FROM phone_codes WHERE user_id = ?").get(user.id)).toBeUndefined();

    // Somebody else proves the same number: only one of them can hold the phone now.
    const other = await account("0127771234");
    await sendPhoneCode(other.id, "+60 12-777 1234");
    expect(await confirmPhoneCode(other.id, codes[1])).toEqual({ ok: true });
    expect((await phoneStatus(user.id))?.verified).toBe(false);
    // Changing the number on the account undoes its check.
    await getDb().prepare("UPDATE users SET phone = '0199999999' WHERE id = ?").run(other.id);
    expect((await phoneStatus(other.id))?.verified).toBe(false);
  });

  it("gives up after five wrong tries, and lets only so many codes be sent", async () => {
    const codes = whatsapp();
    const user = await account("0133000001");
    await sendPhoneCode(user.id, "0133000001");
    for (let i = 0; i < MAX_TRIES; i++) await confirmPhoneCode(user.id, codes[0] === "999999" ? "888888" : "999999");
    expect(await confirmPhoneCode(user.id, codes[0])).toMatchObject({ ok: false, code: "PHONE_CODE_EXPIRED" });
    for (let i = 1; i < SENDS_PER_HOUR; i++) expect((await sendPhoneCode(user.id, "0133000001")).ok).toBe(true);
    expect(await sendPhoneCode(user.id, "0133000001")).toMatchObject({ ok: false, code: "PHONE_CODE_LIMIT" });
    // An old code has run out.
    const fresh = await account("0133000002");
    await sendPhoneCode(fresh.id, "0133000002");
    await getDb().prepare("UPDATE phone_codes SET expires_at = datetime('now', '-1 minute') WHERE user_id = ?").run(fresh.id);
    expect(await confirmPhoneCode(fresh.id, codes.at(-1)!)).toMatchObject({ ok: false, code: "PHONE_CODE_EXPIRED" });
    expect(await sendPhoneCode(fresh.id, "nonsense")).toMatchObject({ ok: false });
    // WhatsApp refusing is said plainly, and nothing is kept.
    vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { message: "Template not approved" } }, { status: 400 })));
    expect(await sendPhoneCode(fresh.id, "0133000002")).toMatchObject({ ok: false, error: expect.stringContaining("Template not approved") });
  });

  it("through the routes: booking waits for it, then the booking shows it checked", async () => {
    const codes = whatsapp();
    const made = await signInWithIdentity({ provider: "google", subject: `booker-${++n}`, email: `booker${n}@gmail.com`, emailVerified: true, name: "Booker" });
    if (!made.ok) throw new Error(made.error);
    const cookie = `${SESSION_COOKIE}=${(await createSession(made.userId)).token}`;
    const post = (path: string, body: object) =>
      new NextRequest(`http://localhost${path}`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(body) });
    const bookings = await import("../src/app/api/bookings/route");
    const date = addDays(todayISO(), 2);
    const booking = { courtId, date, hours: [20], name: "Booker", phone: "0144000001" };
    const refused = await bookings.POST(post("/api/bookings", booking));
    expect(refused.status).toBe(403);
    expect(await refused.json()).toMatchObject({ code: "PHONE_NEEDED" });

    const phone = await import("../src/app/api/my/phone/route");
    expect((await phone.POST(post("/api/my/phone", { action: "send", phone: "0144000001" }))).status).toBe(200);
    expect((await phone.POST(post("/api/my/phone", { action: "confirm", code: "12" }))).status).toBe(400);
    const ok = await phone.POST(post("/api/my/phone", { action: "confirm", code: codes[0] }));
    expect((await ok.json()).status).toMatchObject({ phone: "0144000001", verified: true });
    expect((await phone.GET(new NextRequest("http://localhost/api/my/phone", { headers: { cookie } }))).status).toBe(200);
    expect((await phone.GET(new NextRequest("http://localhost/api/my/phone"))).status).toBe(401);
    expect((await phone.POST(post("/api/my/phone", { action: "sideways" }))).status).toBe(400);

    vi.unstubAllGlobals();
    const booked = await bookings.POST(post("/api/bookings", booking));
    expect(booked.status).toBe(201);
    const row = (await listBookingsForDate(date)).find((b) => b.phone === "0144000001")!;
    expect(row.phoneChecked).toBe(true);

    // Guests are not asked.
    const guest = await bookings.POST(
      new NextRequest("http://localhost/api/bookings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...booking, hours: [21], name: "Walk In", phone: "0144000002" }),
      })
    );
    expect(guest.status).toBe(201);
    expect((await listBookingsForDate(date)).find((b) => b.phone === "0144000002")?.phoneChecked).toBe(false);

    const { exportCustomerData, eraseCustomer } = await import("../src/lib/privacy");
    const data = await exportCustomerData(made.userId);
    expect(data?.signIns).toMatchObject([{ provider: "google" }]);
    expect(data?.account.phoneCheckedAt).not.toBeNull();
    expect((await eraseCustomer(made.userId)).ok).toBe(true);
    expect(await getDb().prepare("SELECT 1 FROM user_identities WHERE user_id = ?").get(made.userId)).toBeUndefined();
  });
});
