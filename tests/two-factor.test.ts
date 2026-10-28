import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

process.env.MYSENAM_DB = ":memory:";

import { NextRequest } from "next/server";
import { ADMIN_SESSION_COOKIE, createAdmin, createAdminSession } from "../src/lib/admin-auth";
import { listVenues } from "../src/lib/store";
import {
  base32Decode,
  base32Encode,
  confirmSetup,
  currentStep,
  disableTwoFactor,
  startSetup,
  totpCode,
  twoFactorStatus,
} from "../src/lib/two-factor";
import { POST as login } from "../src/app/api/admin/auth/login/route";
import { GET as taxGet } from "../src/app/api/admin/venue-tax/route";
import { GET as me } from "../src/app/api/admin/auth/me/route";

/** Staff sign in with a password and a code from an authenticator app. */

let adminId: number;
let secret: Buffer;
let recovery: string[];
const EMAIL = "manager@twofactor.my";
const PASSWORD = "a long enough password";
// Today, on a 30-second step: the database's own clock judges session expiry, so a fixed date would lapse a week on.
let clock = Math.floor(Date.now() / 30_000) * 30_000;

const codeAt = (offsetSteps = 0) => totpCode(secret, currentStep(clock) + offsetSteps);
const tick = () => {
  clock += 30_000;
  vi.setSystemTime(clock);
};
const signIn = (body: object) =>
  login(new NextRequest("http://localhost/api/admin/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }));
const asAdmin = (url: string, token: string) => new NextRequest(url, { headers: { cookie: `${ADMIN_SESSION_COOKIE}=${token}` } });

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(clock);
  const venueId = (await listVenues())[0].id;
  const made = await createAdmin({ name: "Mona", email: EMAIL, password: PASSWORD, venueId });
  if (!made.ok) throw new Error(made.error);
  adminId = made.admin.id;
});

afterEach(() => {
  delete process.env.MYSENAM_STAFF_2FA;
});

describe("the codes", () => {
  it("are RFC 6238's", () => {
    const rfc = Buffer.from("12345678901234567890");
    expect(totpCode(rfc, Math.floor(59 / 30))).toBe("287082");
    expect(totpCode(rfc, Math.floor(1111111109 / 30))).toBe("081804");
    expect(base32Decode(base32Encode(rfc)).equals(rfc)).toBe(true);
  });
});

describe("setting it up", () => {
  it("turns on only once a code from the scanned app is typed", async () => {
    const setup = (await startSetup(adminId))!;
    expect(setup.uri).toMatch(/^otpauth:\/\/totp\/.*secret=/);
    expect(setup.qr).toMatch(/^data:image\/png;base64,/);
    secret = base32Decode(setup.secret);
    expect(await confirmSetup(adminId, "000000")).toMatchObject({ ok: false });
    const done = await confirmSetup(adminId, codeAt());
    if (!done.ok) throw new Error(done.error);
    recovery = done.recoveryCodes;
    expect(recovery).toHaveLength(10);
    expect(await twoFactorStatus({ id: adminId, venueId: 1, businessId: null, role: "manager" })).toMatchObject({ enabled: true, recoveryLeft: 10 });
  });
});

describe("signing in", () => {
  it("asks for the code after the password, and sets no session until it is right", async () => {
    const first = await signIn({ email: EMAIL, password: PASSWORD });
    const body = await first.json();
    expect(body).toMatchObject({ twoFactor: true });
    expect(first.cookies.get(ADMIN_SESSION_COOKIE)).toBeUndefined();
    expect((await signIn({ ticket: body.ticket, code: "123456" })).status).toBe(401);
    tick();
    const ok = await signIn({ ticket: body.ticket, code: codeAt() });
    expect(ok.status).toBe(200);
    expect(ok.cookies.get(ADMIN_SESSION_COOKIE)?.value).toBeTruthy();
  });

  it("refuses the same code twice", async () => {
    const { ticket } = await (await signIn({ email: EMAIL, password: PASSWORD })).json();
    expect((await signIn({ ticket, code: codeAt() })).status).toBe(401);
  });

  it("takes a recovery code, once", async () => {
    const { ticket } = await (await signIn({ email: EMAIL, password: PASSWORD })).json();
    expect((await signIn({ ticket, code: recovery[0] })).status).toBe(200);
    const again = await (await signIn({ email: EMAIL, password: PASSWORD })).json();
    expect((await signIn({ ticket: again.ticket, code: recovery[0] })).status).toBe(401);
  });

  it("drops the ticket after a few wrong codes", async () => {
    const { ticket } = await (await signIn({ email: EMAIL, password: PASSWORD })).json();
    for (let i = 0; i < 5; i++) await signIn({ ticket, code: "000000" });
    tick();
    const res = await signIn({ ticket, code: codeAt() });
    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatch(/timed out/);
  });
});

describe("where the site requires it", () => {
  it("lets an account without it do nothing but set it up", async () => {
    const venueId = (await listVenues())[0].id;
    const other = await createAdmin({ name: "Nick", email: "nick@twofactor.my", password: PASSWORD, venueId });
    if (!other.ok) throw new Error(other.error);
    const { token } = await createAdminSession(other.admin.id);
    expect((await taxGet(asAdmin(`http://localhost/api/admin/venue-tax?venueId=${venueId}`, token))).status).toBe(200);
    process.env.MYSENAM_STAFF_2FA = "managers";
    const refused = await taxGet(asAdmin(`http://localhost/api/admin/venue-tax?venueId=${venueId}`, token));
    expect(refused.status).toBe(403);
    expect((await refused.json()).code).toBe("TWO_FACTOR_REQUIRED");
    const status = await (await me(asAdmin("http://localhost/api/admin/auth/me", token))).json();
    expect(status.twoFactor).toMatchObject({ required: true, enabled: false });
  });

  it("will not let it be turned off", async () => {
    process.env.MYSENAM_STAFF_2FA = "all";
    tick();
    expect(await disableTwoFactor({ id: adminId, venueId: 1, businessId: null, role: "manager" }, codeAt())).toMatchObject({ ok: false });
    delete process.env.MYSENAM_STAFF_2FA;
    expect(await disableTwoFactor({ id: adminId, venueId: 1, businessId: null, role: "manager" }, codeAt())).toEqual({ ok: true });
  });
});
