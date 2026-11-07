import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession, ensureBootstrapAdmin, getActingStaffByToken, listAdmins } from "../src/lib/admin-auth";
import { getDb } from "../src/lib/db";
import { changeRole } from "../src/lib/staff-accounts";
import { listVenues } from "../src/lib/store";
import { base32Decode, checkStaffTwoFactorSetting, confirmSetup, currentStep, startSetup, totpCode, twoFactorRequired, staffTwoFactor } from "../src/lib/two-factor";
import { resetFromConsole } from "../src/lib/two-factor-reset";
import { GET as taxGet } from "../src/app/api/admin/venue-tax/route";
import { GET as me } from "../src/app/api/admin/auth/me/route";
import { POST as twoFactorPost } from "../src/app/api/admin/auth/two-factor/route";

/**
 * Staff two-factor sign-in by default on a production marketplace (ADR 0064, audit A10, owner decision DEC-05): the platform owner,
 * business managers and venue managers must have it, front desk may choose; `off` cannot undo it; an account without it is signed in to
 * enrol and nothing else, whatever session it already had.
 */

const PASSWORD = "a long enough password";
let venueId: number;
let businessId: number;
let n = 0;

const production = (rule?: string) => {
  vi.stubEnv("NODE_ENV", "production");
  vi.stubEnv("MYSENAM_MARKETPLACE", "on");
  if (rule !== undefined) vi.stubEnv("MYSENAM_STAFF_2FA", rule);
};
const asAdmin = (url: string, token: string, init: { method?: string; body?: unknown } = {}) =>
  new NextRequest(url, {
    method: init.method ?? "GET",
    headers: { cookie: `${ADMIN_SESSION_COOKIE}=${token}`, "content-type": "application/json", "x-forwarded-for": `198.51.100.${++n % 250}` },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });
const tax = async (token: string) => taxGet(asAdmin(`http://localhost/api/admin/venue-tax?venueId=${venueId}`, token));
async function account(role: "owner" | "business" | "branch" | "desk") {
  const made = await createAdmin({
    name: `Two Factor ${role} ${++n}`,
    email: `tf-${role}-${n}@default.my`,
    password: PASSWORD,
    venueId: role === "owner" || role === "business" ? null : venueId,
    businessId: role === "business" ? businessId : null,
    role: role === "desk" ? "desk" : "manager",
  });
  if (!made.ok) throw new Error(made.error);
  return { admin: made.admin, token: (await createAdminSession(made.admin.id)).token };
}
async function enrol(token: string, adminId: number): Promise<Buffer> {
  const setup = (await startSetup(adminId))!;
  const secret = base32Decode(setup.secret);
  const done = await confirmSetup(adminId, totpCode(secret, currentStep()));
  if (!done.ok) throw new Error(done.error);
  void token;
  return secret;
}

beforeAll(async () => {
  await ensureBootstrapAdmin();
  venueId = (await listVenues())[0].id;
  businessId = ((await getDb().prepare("INSERT INTO businesses (name) VALUES ('Default Chain') RETURNING id").get()) as { id: number }).id;
  await getDb().prepare("UPDATE venues SET business_id = ? WHERE id = ?").run(businessId, venueId);
});

afterEach(() => vi.unstubAllEnvs());

describe("who is required to have it", () => {
  it("is the owner, business managers and managers of a production marketplace, with nothing set; front desk is not", () => {
    production();
    expect(staffTwoFactor()).toMatchObject({ rule: "managers", byDefault: true, refused: null });
    const as = (v: number | null, b: number | null, role: string) => twoFactorRequired({ venueId: v, businessId: b, role });
    expect(as(null, null, "manager")).toBe(true);
    expect(as(null, 7, "manager")).toBe(true);
    expect(as(3, null, "manager")).toBe(true);
    expect(as(3, null, "desk")).toBe(false);
  });

  it("never weakens what an install already enforces: all stays all; owners is raised to managers", () => {
    production("all");
    expect(staffTwoFactor()).toMatchObject({ rule: "all", refused: null });
    expect(twoFactorRequired({ venueId: 3, businessId: null, role: "desk" })).toBe(true);
    vi.unstubAllEnvs();
    production("owners");
    expect(staffTwoFactor().rule).toBe("managers");
    expect(twoFactorRequired({ venueId: 3, businessId: null, role: "manager" })).toBe(true);
    vi.unstubAllEnvs();
    production("managers");
    expect(staffTwoFactor()).toMatchObject({ rule: "managers", byDefault: false });
  });

  it("is not switched off by a setting: off and a typo are refused, enforcement stays, and the refusal says so", () => {
    for (const said of ["off", "OFF", "none", "false", "0", "manager"]) {
      vi.unstubAllEnvs();
      production(said);
      const got = staffTwoFactor();
      expect(got.rule, said).toBe("managers");
      expect(got.refused, said).toMatch(/must still have two-factor/);
      expect(twoFactorRequired({ venueId: null, businessId: null, role: "manager" })).toBe(true);
    }
  });

  it("is left to the install where it is not a production marketplace: development, tests, one venue's own install", () => {
    expect(staffTwoFactor()).toMatchObject({ rule: "off", refused: null });
    vi.stubEnv("MYSENAM_STAFF_2FA", "off");
    expect(staffTwoFactor()).toMatchObject({ rule: "off", refused: null });
    vi.stubEnv("MYSENAM_STAFF_2FA", "all");
    expect(staffTwoFactor().rule).toBe("all");
    vi.unstubAllEnvs();
    vi.stubEnv("NODE_ENV", "production");
    expect(staffTwoFactor()).toMatchObject({ rule: "off", byDefault: false });
    vi.unstubAllEnvs();
    vi.stubEnv("MYSENAM_MARKETPLACE", "on");
    expect(staffTwoFactor()).toMatchObject({ rule: "off", byDefault: false });
  });

  it("can be left off on a production marketplace only by an install that says it holds synthetic data, and that is flagged", async () => {
    production("off");
    vi.stubEnv("MYSENAM_SYNTHETIC_DATA", "on");
    expect(staffTwoFactor()).toMatchObject({ rule: "off", offSynthetic: true, refused: null });
    expect(twoFactorRequired({ venueId: null, businessId: null, role: "manager" })).toBe(false);
    await checkStaffTwoFactorSetting();
    const alert = (await getDb().prepare("SELECT subject FROM system_alerts WHERE key = 'config:staff-2fa'").get()) as { subject: string } | undefined;
    expect(alert?.subject).toMatch(/off on a production marketplace/);
    // The marker alone does nothing: it is not a way to be off without saying so.
    vi.unstubAllEnvs();
    production();
    vi.stubEnv("MYSENAM_SYNTHETIC_DATA", "on");
    expect(staffTwoFactor()).toMatchObject({ rule: "managers", offSynthetic: false });
  });
});

describe("the setting is checked and said", () => {
  it("raises an alert for a refused setting, keeps it, and clears it once the setting is right", async () => {
    await getDb().prepare("DELETE FROM system_alerts WHERE key = 'config:staff-2fa'").run();
    production("off");
    expect(await checkStaffTwoFactorSetting()).toMatch(/refused/);
    const row = (await getDb().prepare("SELECT subject, last_detail FROM system_alerts WHERE key = 'config:staff-2fa'").get()) as { subject: string; last_detail: string };
    expect(row.subject).toMatch(/misconfigured/);
    expect(row.last_detail).toMatch(/MYSENAM_STAFF_2FA is off/);
    vi.unstubAllEnvs();
    production();
    expect(await checkStaffTwoFactorSetting()).toBeNull();
    expect(await getDb().prepare("SELECT 1 FROM system_alerts WHERE key = 'config:staff-2fa'").get()).toBeUndefined();
  });
});

describe("an account that must enrol, and has not", () => {
  it("is signed in to enrol and nothing else: the first owner, a manager made before the rule, a promotion, a new account", async () => {
    // A session made before the rule applied, by a manager who never enrolled.
    const early = await account("branch");
    expect((await tax(early.token)).status).toBe(200);
    production();
    // The first owner: nothing skips it.
    const [firstOwner] = (await listAdmins()).filter((a) => a.venueId === null && a.businessId === null);
    const ownerToken = (await createAdminSession(firstOwner.id)).token;
    for (const token of [early.token, ownerToken]) {
      const res = await tax(token);
      expect(res.status).toBe(403);
      expect((await res.json()).code).toBe("TWO_FACTOR_REQUIRED");
    }
    // What the dashboard reads shows it the way in and no venues.
    const seen = await (await me(asAdmin("http://localhost/api/admin/auth/me", ownerToken))).json();
    expect(seen).toMatchObject({ venues: [], twoFactor: { required: true, enabled: false }, canManage: false });
    expect(seen.admin.id).toBe(firstOwner.id);
    // Front desk may carry on without it.
    const desk = await account("desk");
    expect((await tax(desk.token)).status).toBe(200);
    // A promotion from front desk to manager: required from the next request.
    const promoted = await account("desk");
    const by = (await listAdmins()).find((a) => a.id === firstOwner.id)!;
    expect(await changeRole(by, promoted.admin.id, "manager")).toEqual({ ok: true });
    const afterPromotion = await tax(promoted.token);
    expect(afterPromotion.status).toBe(403);
    expect((await afterPromotion.json()).code).toBe("TWO_FACTOR_REQUIRED");
    // The only things it can do are the ones that enrol it.
    const started = await twoFactorPost(asAdmin("http://localhost/api/admin/auth/two-factor", promoted.token, { method: "POST", body: { action: "start" } }));
    expect(started.status).toBe(200);
    const secret = base32Decode((await started.json()).secret);
    const confirmed = await twoFactorPost(asAdmin("http://localhost/api/admin/auth/two-factor", promoted.token, { method: "POST", body: { action: "confirm", code: totpCode(secret, currentStep()) } }));
    expect(confirmed.status).toBe(200);
    expect((await tax(promoted.token)).status).toBe(200);
    // The enrolled account sees its venues again.
    const enrolled = await (await me(asAdmin("http://localhost/api/admin/auth/me", promoted.token))).json();
    expect(enrolled.venues.length).toBeGreaterThan(0);
  });

  it("is the case for a new business manager, and a new front-desk account may carry on", async () => {
    production();
    const business = await account("business");
    const refused = await tax(business.token);
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe("TWO_FACTOR_REQUIRED");
    const desk = await account("desk");
    expect((await tax(desk.token)).status).toBe(200);
  });

  it("is the case again after a recovery reset, and a disabled authenticator cannot be left off", async () => {
    const mgr = await account("branch");
    await enrol(mgr.token, mgr.admin.id);
    production();
    expect((await tax(mgr.token)).status).toBe(200);
    expect(await resetFromConsole(mgr.admin.email, "Called back on the number on file, then reset it")).toEqual({ ok: true });
    // The reset ended its sessions; a new sign-in's session is the same enrol-only one.
    const again = (await createAdminSession(mgr.admin.id)).token;
    expect((await tax(again)).status).toBe(403);
    const off = await twoFactorPost(asAdmin("http://localhost/api/admin/auth/two-factor", again, { method: "POST", body: { action: "disable", code: "123456" } }));
    expect(off.status).toBe(400);
  });

  it("holds for every place a request is treated as staff, the cash-up page's included", async () => {
    production();
    const mgr = await account("branch");
    expect(await getActingStaffByToken(mgr.token)).toBeNull();
    await enrol(mgr.token, mgr.admin.id);
    expect((await getActingStaffByToken(mgr.token))?.id).toBe(mgr.admin.id);
    const source = (await import("fs")).readFileSync(new URL("../src/app/admin/cash-up/page.tsx", import.meta.url), "utf8");
    expect(source).toContain("getActingStaffByToken");
    expect(source).not.toMatch(/\bgetAdminByToken\b/);
  });
});
