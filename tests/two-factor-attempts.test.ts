import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { NextRequest } from "next/server";
import { createAdmin } from "../src/lib/admin-auth";
import { getDb } from "../src/lib/db";
import { resetRateLimits } from "../src/lib/rate-limit";
import { listVenues } from "../src/lib/store";
import {
  ACCOUNT_ATTEMPTS,
  ACCOUNT_WINDOW_MS,
  ADDRESS_ATTEMPTS,
  ADDRESS_WINDOW_MS,
  base32Decode,
  confirmSetup,
  countAttempt,
  currentStep,
  disableTwoFactor,
  issueLoginTicket,
  redeemLoginTicket,
  startSetup,
  totpCode,
} from "../src/lib/two-factor";
import { resetFromConsole } from "../src/lib/two-factor-reset";
import { POST as login } from "../src/app/api/admin/auth/login/route";

/**
 * Attempts at a second-factor code are counted before the code is looked at (ADR 0064, audit A14): per ticket, and per account and
 * address in the database, so parallel guesses cannot outrun the limit; every limit ends by itself; a ticket is single use.
 */

let adminId: number;
let secret: Buffer;
let recovery: string[] = [];
const EMAIL = "attempts@twofactor.my";
const PASSWORD = "a long enough password";
// A 30-second step boundary: the database's own clock judges session expiry, so a fixed date would lapse.
let clock = Math.floor(Date.now() / 30_000) * 30_000;
const codeNow = () => totpCode(secret, currentStep(clock));
const advance = (ms: number) => {
  clock += ms;
  vi.setSystemTime(clock);
};
const WRONG = "000001";
const attemptsRow = async () =>
  (await getDb().prepare("SELECT address_key, attempts FROM admin_two_factor_attempts WHERE admin_id = ? ORDER BY address_key").all(adminId)) as { address_key: string; attempts: number }[];
const signIn = (body: object, address = "198.51.100.1") =>
  login(
    new NextRequest("http://localhost/api/admin/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": address },
      body: JSON.stringify(body),
    })
  );
const ticketFrom = async (address = "198.51.100.1") => ((await (await signIn({ email: EMAIL, password: PASSWORD }, address)).json()) as { ticket: string }).ticket;

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(clock);
  const venueId = (await listVenues())[0].id;
  const made = await createAdmin({ name: "Aziz", email: EMAIL, password: PASSWORD, venueId });
  if (!made.ok) throw new Error(made.error);
  adminId = made.admin.id;
  const setup = (await startSetup(adminId))!;
  secret = base32Decode(setup.secret);
  const done = await confirmSetup(adminId, codeNow());
  if (!done.ok) throw new Error(done.error);
  recovery = done.recoveryCodes;
});

afterEach(async () => {
  await getDb().prepare("DELETE FROM admin_two_factor_attempts").run();
  await getDb().prepare("DELETE FROM admin_login_tickets").run();
  await resetRateLimits();
});

describe("a ticket's attempts", () => {
  it("are counted before the code is looked at: 40 wrong codes at once on one ticket get five answers, not forty", async () => {
    const ticket = await issueLoginTicket(adminId);
    const results = await Promise.all(Array.from({ length: 40 }, () => redeemLoginTicket(ticket, WRONG, "203.0.113.1")));
    const looked = results.filter((r) => !r.ok && r.error === "That code is not right.");
    expect(looked).toHaveLength(5);
    expect(results.filter((r) => !r.ok && /timed out/.test(r.error))).toHaveLength(35);
    expect(results.some((r) => r.ok)).toBe(false);
    // The ticket is gone, and a right code on it now is no better.
    expect(await redeemLoginTicket(ticket, codeNow(), "203.0.113.1")).toMatchObject({ ok: false });
    // Five were counted against the account from that address, and no more reached the code.
    expect((await attemptsRow()).filter((r) => r.address_key !== "*").map((r) => r.attempts)).toEqual([5]);
  });

  it("go through the sign-in route the same way, and a wrong code never opens a session", async () => {
    const ticket = await ticketFrom();
    const answers = await Promise.all(Array.from({ length: 9 }, () => signIn({ ticket, code: WRONG })));
    expect(answers.every((r) => r.status === 401 && !r.cookies.get("ms_admin"))).toBe(true);
    expect((await Promise.all(answers.map((r) => r.json()))).filter((b) => b.error === "That code is not right.").length).toBeLessThanOrEqual(5);
  });
});

describe("attempts at one account's code from one address", () => {
  it("stop at the limit across tickets, in parallel, and a right code is not looked at past it", async () => {
    const tickets = await Promise.all(Array.from({ length: 6 }, () => issueLoginTicket(adminId)));
    const results = await Promise.all(tickets.flatMap((t) => Array.from({ length: 10 }, () => redeemLoginTicket(t, WRONG, "203.0.113.2"))));
    const looked = results.filter((r) => !r.ok && r.error === "That code is not right.").length;
    const refused = results.filter((r) => !r.ok && r.locked).length;
    expect(looked).toBeLessThanOrEqual(ADDRESS_ATTEMPTS);
    expect(refused).toBeGreaterThan(0);
    // Locked, so even the right code from that address is turned away, and says so as a wait, not as a wrong code.
    const fresh = await issueLoginTicket(adminId);
    const locked = await redeemLoginTicket(fresh, codeNow(), "203.0.113.2");
    expect(locked).toMatchObject({ ok: false, locked: true });
    expect((locked as { retryAfter: number }).retryAfter).toBeGreaterThan(0);
  });

  it("is a wait that ends by itself, for that address only: another address signs in, and this one later", async () => {
    for (let i = 0; i < ADDRESS_ATTEMPTS + 2; i++) await redeemLoginTicket(await issueLoginTicket(adminId), WRONG, "203.0.113.3");
    expect(await redeemLoginTicket(await issueLoginTicket(adminId), codeNow(), "203.0.113.3")).toMatchObject({ ok: false, locked: true });
    // The account's owner, from somewhere else, is not held by it.
    advance(30_000);
    expect(await redeemLoginTicket(await issueLoginTicket(adminId), codeNow(), "203.0.113.4")).toMatchObject({ ok: true, adminId });
    // The wait is fixed, and failing again inside it does not lengthen it.
    advance(ADDRESS_WINDOW_MS - 120_000);
    expect(await redeemLoginTicket(await issueLoginTicket(adminId), WRONG, "203.0.113.3")).toMatchObject({ ok: false, locked: true });
    advance(150_000);
    advance(30_000);
    expect(await redeemLoginTicket(await issueLoginTicket(adminId), codeNow(), "203.0.113.3")).toMatchObject({ ok: true, adminId });
  });

  it("is not reset by a wrong code, nor by a new password step; a right code clears that address and only that", async () => {
    for (let i = 0; i < 3; i++) await redeemLoginTicket(await issueLoginTicket(adminId), WRONG, "203.0.113.5");
    // Signing in again with the password issues a new ticket: the count is still there.
    await ticketFrom("203.0.113.5");
    await redeemLoginTicket(await issueLoginTicket(adminId), WRONG, "203.0.113.5");
    const before = await attemptsRow();
    expect(before.filter((r) => r.address_key !== "*").map((r) => r.attempts)).toEqual([4]);
    expect(before.find((r) => r.address_key === "*")?.attempts).toBe(4);
    advance(30_000);
    expect(await redeemLoginTicket(await issueLoginTicket(adminId), codeNow(), "203.0.113.5")).toMatchObject({ ok: true });
    const after = await attemptsRow();
    expect(after.filter((r) => r.address_key !== "*")).toEqual([]);
    expect(after.find((r) => r.address_key === "*")?.attempts).toBe(4);
  });
});

describe("attempts at one account's code from anywhere", () => {
  it("stop at the account's limit, for every address, and end after their window", async () => {
    // Each address uses its own allowance, until the account as a whole has had enough.
    let attempts = 0;
    for (let address = 0; attempts < ACCOUNT_ATTEMPTS; address++)
      for (let i = 0; i < ADDRESS_ATTEMPTS && attempts < ACCOUNT_ATTEMPTS; i++, attempts++)
        await redeemLoginTicket(await issueLoginTicket(adminId), WRONG, `198.18.0.${address}`);
    advance(30_000);
    expect(await redeemLoginTicket(await issueLoginTicket(adminId), codeNow(), "198.18.9.9")).toMatchObject({ ok: false, locked: true });
    // One address that is itself locked does not add to it.
    const row = (await attemptsRow()).find((r) => r.address_key === "*")!;
    expect(row.attempts).toBe(ACCOUNT_ATTEMPTS + 1);
    advance(ACCOUNT_WINDOW_MS);
    expect(await redeemLoginTicket(await issueLoginTicket(adminId), codeNow(), "198.18.9.9")).toMatchObject({ ok: true });
  });

  it("is told to a refused caller as a wait (429 with Retry-After), the same whoever the account is", async () => {
    for (let i = 0; i < ADDRESS_ATTEMPTS + 1; i++) await redeemLoginTicket(await issueLoginTicket(adminId), WRONG, "203.0.113.6");
    const ticket = await ticketFrom("203.0.113.6");
    const res = await signIn({ ticket, code: codeNow() }, "203.0.113.6");
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    expect((await res.json()).error).not.toMatch(/factor|account|authenticator|recovery/i);
  });
});

describe("a ticket", () => {
  it("expires, and a right code on an expired one is no use", async () => {
    const ticket = await issueLoginTicket(adminId);
    advance(6 * 60_000);
    expect(await redeemLoginTicket(ticket, codeNow(), "203.0.113.7")).toEqual({ ok: false, error: "That sign-in has timed out. Enter your password again." });
  });

  it("is used up by the first right code, and not replayed", async () => {
    const ticket = await issueLoginTicket(adminId);
    advance(30_000);
    expect(await redeemLoginTicket(ticket, codeNow(), "203.0.113.8")).toMatchObject({ ok: true });
    advance(30_000);
    expect(await redeemLoginTicket(ticket, codeNow(), "203.0.113.8")).toMatchObject({ ok: false });
  });

  it("signs one session in even when two different right codes arrive at once", async () => {
    const ticket = await issueLoginTicket(adminId);
    const [a, b] = await Promise.all([redeemLoginTicket(ticket, recovery[1], "203.0.113.9"), redeemLoginTicket(ticket, recovery[2], "203.0.113.9")]);
    expect([a.ok, b.ok].filter(Boolean)).toHaveLength(1);
  });

  it("is answered the same whether it never existed, ran out, or was used: nothing says which account or factor", async () => {
    const unknown = await redeemLoginTicket("f".repeat(48), WRONG, "203.0.113.10");
    const ticket = await issueLoginTicket(adminId);
    advance(6 * 60_000);
    const expired = await redeemLoginTicket(ticket, WRONG, "203.0.113.10");
    expect(unknown).toEqual(expired);
    const wrong = await redeemLoginTicket(await issueLoginTicket(adminId), WRONG, "203.0.113.10");
    expect(wrong).toEqual({ ok: false, error: "That code is not right." });
  });
});

describe("the other places a code is asked for", () => {
  it("count the same: a turn-off that guesses is stopped, and the right code is not looked at while it is", async () => {
    const may = { id: adminId, venueId: 1, businessId: null, role: "manager" };
    for (let i = 0; i < ADDRESS_ATTEMPTS; i++) expect(await disableTwoFactor(may, WRONG, "203.0.113.11")).toMatchObject({ ok: false });
    advance(30_000);
    const refused = await disableTwoFactor(may, codeNow(), "203.0.113.11");
    expect(refused).toEqual({ ok: false, error: "That code is not right." });
    // Still on: nothing was turned off by a code that was not looked at.
    expect((await getDb().prepare("SELECT totp_enabled_at FROM admins WHERE id = ?").get(adminId)) as { totp_enabled_at: string | null }).toMatchObject({
      totp_enabled_at: expect.any(String),
    });
  });
});

describe("a lock-out, and the way back", () => {
  it("is cleared at once by a reset of the account's two-factor sign-in, made by somebody with authority and written down", async () => {
    for (let i = 0; i < ADDRESS_ATTEMPTS + 1; i++) await redeemLoginTicket(await issueLoginTicket(adminId), WRONG, "203.0.113.12");
    expect((await attemptsRow()).length).toBeGreaterThan(0);
    expect(await resetFromConsole(EMAIL, "Called back on the number on file, then reset it")).toEqual({ ok: true });
    expect(await attemptsRow()).toEqual([]);
    // Nothing was ever a lock for good: counting started from nothing, and the account signs in with its password to enrol again.
    expect(await countAttempt(adminId, "203.0.113.12")).toEqual({ allowed: true });
  });
});
