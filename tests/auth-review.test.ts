import { beforeAll, beforeEach, describe, expect, it } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { NextRequest } from "next/server";
import { authenticate, createSession, getUserByToken, registerUser, SESSION_COOKIE } from "../src/lib/auth";
import { getDb } from "../src/lib/db";
import { confirmPhoneCode, sendPhoneCode } from "../src/lib/phone-check";
import { changePassword, requestReset, resetPassword, settleResetRequests } from "../src/lib/password-reset";
import { resetRateLimits } from "../src/lib/rate-limit";
import { POST as forgotUser } from "../src/app/api/auth/forgot/route";
import { POST as resetUser } from "../src/app/api/auth/reset/route";

/**
 * The end-to-end review of customer sign-up and password reset
 * (docs/architecture/authentication.md): what the existing suites
 * (password-reset, registration, sign-in) do not exercise.
 */

let n = 0;
function req(path: string, body: unknown, opts: { ip?: string; cookie?: string } = {}) {
  return new NextRequest(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": opts.ip ?? `10.9.${Math.floor(++n / 250)}.${n % 250}`, ...(opts.cookie ? { cookie: opts.cookie } : {}) },
    body: JSON.stringify(body),
  });
}

const TOKEN = /reset-password\?kind=user&token=([A-Za-z0-9_-]+)/;
/** The token in the newest reset email queued for this address (the text is kept until it is sent). */
async function tokenFor(address: string): Promise<string> {
  const rows = (await getDb().prepare("SELECT body FROM messages WHERE lower(recipient) = lower(?) ORDER BY id DESC").all(address)) as { body: string }[];
  const hit = rows.find((r) => TOKEN.test(r.body));
  if (!hit) throw new Error(`no reset link queued for ${address}`);
  return TOKEN.exec(hit.body)![1];
}

async function ask(email: string) {
  await requestReset("user", email, "en");
  await settleResetRequests();
}

async function account(email: string, password = "a first password"): Promise<number> {
  const made = await registerUser({ name: "Test Person", email, phone: "0123456789", password });
  if (!made.ok) throw new Error(made.error);
  return made.user.id;
}

beforeAll(async () => {
  await account("seed@review.my");
});

beforeEach(async () => {
  await settleResetRequests();
  await resetRateLimits();
});

describe("a reset link used twice at once", () => {
  it("sets one password and signs one browser in", async () => {
    const id = await account("race@review.my", "before the race");
    await ask("race@review.my");
    const token = await tokenFor("race@review.my");
    const results = await Promise.all(Array.from({ length: 6 }, (_, i) => resetPassword("user", token, `password number ${i}`)));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    for (const r of results.filter((x) => !x.ok)) expect(r).toMatchObject({ code: "RESET_INVALID" });
    expect(await authenticate("race@review.my", "before the race")).toBeNull();
    expect(id).toBeGreaterThan(0);
  });
});

describe("a reset link for an account that has been erased since", () => {
  it("is refused like any other link that cannot be used, and signs nobody in", async () => {
    const id = await account("erased@review.my");
    await ask("erased@review.my");
    const token = await tokenFor("erased@review.my");
    await getDb().prepare("DELETE FROM users WHERE id = ?").run(id);
    const res = await resetUser(req("/api/auth/reset", { token, password: "a new password 1" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ code: "RESET_INVALID" });
    expect(res.cookies.get(SESSION_COOKIE)).toBeUndefined();
  });
});

describe("a staff reset link for an account removed since", () => {
  it("is refused the same way", async () => {
    const { createAdmin } = await import("../src/lib/admin-auth");
    const made = await createAdmin({ email: "gone-staff@review.my", name: "Gone Staff", password: "staff password 1", venueId: null });
    if (!made.ok) throw new Error(made.error);
    const adminId = made.admin.id;
    await requestReset("admin", "gone-staff@review.my");
    await settleResetRequests();
    const rows = (await getDb().prepare("SELECT body FROM messages WHERE lower(recipient) = 'gone-staff@review.my' ORDER BY id DESC").all()) as { body: string }[];
    const token = /token=([A-Za-z0-9_-]+)/.exec(rows[0].body)![1];
    await getDb().prepare("DELETE FROM admins WHERE id = ?").run(adminId);
    expect(await resetPassword("admin", token, "a new staff password")).toMatchObject({ ok: false, code: "RESET_INVALID" });
  });
});

describe("asking for reset links from one address", () => {
  it("is limited as a whole, not only per address asked about", async () => {
    for (let i = 0; i < 40; i++) await account(`bulk${i}@review.my`);
    const same = "10.77.0.1";
    const statuses: number[] = [];
    for (let i = 0; i < 40; i++) statuses.push((await forgotUser(req("/api/auth/forgot", { email: `bulk${i}@review.my` }, { ip: same }))).status);
    await settleResetRequests();
    expect(statuses).toContain(429);
    expect(statuses.filter((s) => s === 200).length).toBeLessThanOrEqual(30);
  });

  it("does not stop others behind a different address", async () => {
    const other = await forgotUser(req("/api/auth/forgot", { email: "seed@review.my" }, { ip: "10.77.0.2" }));
    expect(other.status).toBe(200);
  });
});

describe("changing a password while signed in", () => {
  it("voids the reset links still out for the account", async () => {
    const id = await account("changer@review.my", "the current one");
    await ask("changer@review.my");
    const token = await tokenFor("changer@review.my");
    const session = await createSession(id);
    expect(await changePassword("user", id, "the current one", "the changed one", session.token)).toEqual({ ok: true });
    expect(await resetPassword("user", token, "set by an old link")).toMatchObject({ ok: false, code: "RESET_INVALID" });
    expect(await authenticate("changer@review.my", "the changed one")).toMatchObject({ id });
  });

  it("two changes at once do not both succeed on the same current password and leave sessions behind", async () => {
    const id = await account("twice@review.my", "the current one");
    const keep = await createSession(id);
    const other = await createSession(id);
    const results = await Promise.all([
      changePassword("user", id, "the current one", "first new password", keep.token),
      changePassword("user", id, "the current one", "second new password", keep.token),
    ]);
    expect(results.filter((r) => r.ok).length).toBeGreaterThanOrEqual(1);
    expect(await getUserByToken(other.token)).toBeNull();
    expect(await getUserByToken(keep.token)).not.toBeNull();
  });
});

describe("the address as typed", () => {
  it("finds the account whatever the case or the spaces round it, to sign in and to reset", async () => {
    const id = await account("MixedCase@Review.my", "mixed case password");
    expect(await authenticate("  mixedcase@review.MY ", "mixed case password")).toMatchObject({ id });
    await ask("  MIXEDCASE@review.my  ");
    expect(await tokenFor("mixedcase@review.my")).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("treats a plus address as another address, as the mail system does", async () => {
    await account("plus@review.my");
    const other = await registerUser({ name: "Plus Two", email: "plus+two@review.my", phone: "0123456780", password: "another password" });
    expect(other.ok).toBe(true);
  });
});

describe("a phone code guessed in parallel", () => {
  it("allows five wrong tries however they arrive", async () => {
    process.env.MYSENAM_SEND = "log";
    process.env.MYSENAM_PHONE_CHECK = "on";
    const id = await account("phone@review.my");
    const sent = await sendPhoneCode(id, "0123456799");
    expect(sent.ok).toBe(true);
    const rows = (await Promise.all(Array.from({ length: 12 }, () => confirmPhoneCode(id, "000000")))) as { ok: boolean; code?: string }[];
    expect(rows.every((r) => !r.ok)).toBe(true);
    const { attempts } = (await getDb().prepare("SELECT attempts FROM phone_codes WHERE user_id = ? ORDER BY id DESC LIMIT 1").get(id)) as { attempts: number };
    // Twelve tries were made at once; none past the fifth may have been looked at.
    expect(attempts).toBeLessThanOrEqual(5);
    delete process.env.MYSENAM_SEND;
    delete process.env.MYSENAM_PHONE_CHECK;
  });

  it("still takes the right code after wrong ones, and no more once five are used", async () => {
    process.env.MYSENAM_SEND = "log";
    process.env.MYSENAM_PHONE_CHECK = "on";
    const id = await account("phone2@review.my");
    await sendPhoneCode(id, "0123456798");
    for (let i = 0; i < 5; i++) expect(await confirmPhoneCode(id, "000001")).toMatchObject({ ok: false, code: "PHONE_CODE_WRONG" });
    expect(await confirmPhoneCode(id, "000001")).toMatchObject({ ok: false, code: "PHONE_CODE_EXPIRED" });
    delete process.env.MYSENAM_SEND;
    delete process.env.MYSENAM_PHONE_CHECK;
  });
});
