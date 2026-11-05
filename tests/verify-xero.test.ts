import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { organisation, startXeroStandin, type Standin } from "./helpers/xero-standin";

/**
 * The Xero check (scripts/verify-xero.mjs), against the stand-in in tests/helpers/xero-standin.ts: it is BLOCKED, naming what
 * is missing, with no credentials; takes the one manual consent step (print the address, trade the code); then runs its
 * scripted check with the refresh token it keeps (rotated every run, mode 0600); refuses an organisation Xero says is not a
 * demo company, or does not label unless told; and never prints a secret. A stand-in proves the harness, not Xero: the real
 * run stays to be done (docs/integrations/xero.md#verifying-against-a-demo-company).
 */

let standin: Standin;
let live: Standin;
let unlabelled: Standin;
let dir: string;

beforeAll(async () => {
  standin = await startXeroStandin([organisation()]);
  live = await startXeroStandin([organisation({ isDemo: false, name: "Real Business Sdn Bhd" })]);
  unlabelled = await startXeroStandin([organisation({ isDemo: null })]);
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "verify-xero-"));
});
afterAll(async () => {
  await Promise.all([standin.close(), live.close(), unlabelled.close()]);
  fs.rmSync(dir, { recursive: true, force: true });
});

const envFor = (s: Standin, extra: Record<string, string> = {}) => ({
  XERO_CLIENT_ID: s.clientId,
  XERO_CLIENT_SECRET: s.clientSecret,
  XERO_REDIRECT_URI: "https://app.example.test/callback",
  XERO_API_URL: s.url,
  XERO_IDENTITY_URL: s.url,
  XERO_VERIFY_REPORT_DIR: path.join(dir, "reports"),
  ...extra,
});

function run(env: Record<string, string>, ...args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["scripts/verify-xero.mjs", ...args], { env: { PATH: process.env.PATH, NODE_ENV: "test", ...env } });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.on("close", (code) => resolve({ code, out }));
  });
}

/** The manual step: print the address, approve at the stand-in, come back with the code. */
async function consent(s: Standin, file: string, extra: Record<string, string> = {}) {
  const env = envFor(s, { XERO_VERIFY_TOKEN_FILE: file, ...extra });
  const first = await run(env, "consent");
  const url = /(https:\/\/login\.xero\.com\S+)/.exec(first.out)?.[1];
  expect(url).toBeTruthy();
  const code = s.consent(url!, [[...s.organisations.keys()][0]]);
  return { first, second: await run(env, "consent", "--code", code), code, env };
}

describe("the Xero check", () => {
  it("is BLOCKED, naming what it needs, when the app's credentials are not there; and calls nothing", async () => {
    const done = await run({ XERO_VERIFY_REPORT_DIR: path.join(dir, "reports") });
    expect(done.code).toBe(0);
    expect(done.out).toMatch(/BLOCKED — set XERO_CLIENT_ID, XERO_CLIENT_SECRET, XERO_REDIRECT_URI, XERO_VERIFY_TOKEN_FILE/);
    expect(done.out).toMatch(/xero: BLOCKED/);
    expect(standin.calls).toHaveLength(0);
  });

  it("is BLOCKED, asking for the consent step, when it has no refresh token", async () => {
    const done = await run(envFor(standin, { XERO_VERIFY_TOKEN_FILE: path.join(dir, "none.json") }));
    expect(done.out).toMatch(/BLOCKED — set XERO_VERIFY_REFRESH_TOKEN \(or run `consent` once\)/);
    expect(standin.calls).toHaveLength(0);
  });

  it("takes the one manual consent step: an address to approve at, then the code traded for a token kept in a file only the owner reads", async () => {
    const file = path.join(dir, "token.json");
    const { first, second, code } = await consent(standin, file);
    expect(first.out).toMatch(/code_challenge_method=S256/);
    expect(first.out).not.toContain(standin.clientSecret);
    expect(second.code).toBe(0);
    expect(second.out).toMatch(/✔ code exchanged for a refresh token, kept in the token file \(mode 0600\)/);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const kept = JSON.parse(fs.readFileSync(file, "utf8")) as { refreshToken: string };
    // Nothing printed holds the code, the token or the client secret.
    for (const secret of [code, kept.refreshToken, standin.clientSecret]) {
      expect(first.out + second.out).not.toContain(secret);
    }
    expect(fs.existsSync(`${file}.pkce`)).toBe(false);
  });

  it("runs the scripted check with that token, rotating it, and every step passes against an API of this shape", async () => {
    const file = path.join(dir, "token.json");
    const before = (JSON.parse(fs.readFileSync(file, "utf8")) as { refreshToken: string }).refreshToken;
    const done = await run(envFor(standin, { XERO_VERIFY_TOKEN_FILE: file }));
    expect(done.out).toMatch(/xero: PASS/);
    expect(done.code).toBe(0);
    for (const line of [
      "refresh token accepted and rotated",
      "exactly one organisation was chosen at consent",
      "the organisation is a demo company — Xero says so",
      "a sales invoice is created",
      "Xero's total is what was sent, to the cent",
      "Xero booked the tax as sent",
      "sending the same invoice again is harmless",
      "a second invoice of the same number is refused as a duplicate",
      "the payment is recorded against the invoice",
      "the invoice reads as settled",
      "the refund is recorded against the credit note",
      "the credit note reads as settled",
    ])
      expect(done.out, line).toMatch(new RegExp(`✔ ${line.replace(/[()]/g, "\\$&")}`));
    expect(done.out).not.toMatch(/✖/);
    // Used and rotated: the old token is spent, the new one kept; a second run works with it.
    const after = (JSON.parse(fs.readFileSync(file, "utf8")) as { refreshToken: string }).refreshToken;
    expect(after).not.toBe(before);
    expect(standin.refreshTokens.has(before)).toBe(false);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(standin.invoices).toHaveLength(1);
    expect(standin.creditNotes).toHaveLength(1);
    expect(standin.payments).toHaveLength(2);
    expect((await run(envFor(standin, { XERO_VERIFY_TOKEN_FILE: file }))).out).toMatch(/xero: PASS/);
    // Nothing printed holds a token or the secret, and the report says what was and was not proven.
    expect(done.out).not.toContain(after);
    expect(done.out).not.toContain(before);
    expect(done.out).not.toContain(standin.clientSecret);
    const reports = fs.readdirSync(path.join(dir, "reports")).filter((f) => f.startsWith("xero-"));
    const report = JSON.parse(fs.readFileSync(path.join(dir, "reports", reports[reports.length - 1]), "utf8")) as { result: { status: string; notes: string[] } };
    expect(report.result.status).toBe("PASS");
    expect(report.result.notes.join(" ")).toMatch(/not proven/);
    expect(JSON.stringify(report)).not.toContain(after);
  });

  it("reports a refresh token that no longer works as a failure and asks for the consent step again", async () => {
    const file = path.join(dir, "stale.json");
    fs.writeFileSync(file, JSON.stringify({ refreshToken: "a-refresh-token-that-was-spent" }), { mode: 0o600 });
    const done = await run(envFor(standin, { XERO_VERIFY_TOKEN_FILE: file }));
    expect(done.code).toBe(1);
    expect(done.out).toMatch(/✖ refresh token accepted/);
    expect(done.out).toMatch(/run `consent` again/);
  });

  it("refuses an organisation Xero says is not a demo company, before anything is created", async () => {
    const file = path.join(dir, "live.json");
    const { second } = await consent(live, file);
    expect(second.code).toBe(0);
    const done = await run(envFor(live, { XERO_VERIFY_TOKEN_FILE: file, XERO_VERIFY_DEMO_COMPANY_ONLY: "yes" }));
    expect(done.code).toBe(1);
    expect(done.out).toMatch(/Xero says it is NOT a demo company: refused, nothing was sent/);
    expect(live.invoices).toHaveLength(0);
    expect(live.calls.filter((c) => c.method === "PUT")).toHaveLength(0);
  });

  it("refuses an organisation Xero does not label unless the run says it is a demo one", async () => {
    const file = path.join(dir, "unlabelled.json");
    await consent(unlabelled, file);
    const refused = await run(envFor(unlabelled, { XERO_VERIFY_TOKEN_FILE: file }));
    expect(refused.code).toBe(1);
    expect(refused.out).toMatch(/Xero does not say; set XERO_VERIFY_DEMO_COMPANY_ONLY=yes/);
    expect(unlabelled.calls.filter((c) => c.method === "PUT")).toHaveLength(0);
    const allowed = await run(envFor(unlabelled, { XERO_VERIFY_TOKEN_FILE: file, XERO_VERIFY_DEMO_COMPANY_ONLY: "yes" }));
    expect(allowed.out).toMatch(/xero: PASS/);
    expect(allowed.out).toMatch(/confirmed by XERO_VERIFY_DEMO_COMPANY_ONLY=yes/);
  });

  it("seeds its token file from the secret store's variable once, and never prints it", async () => {
    const s = await startXeroStandin([organisation()]);
    try {
      const seeded = path.join(dir, "seed.json");
      const consented = await consent(s, path.join(dir, "elsewhere.json"));
      expect(consented.second.code).toBe(0);
      const seed = (JSON.parse(fs.readFileSync(path.join(dir, "elsewhere.json"), "utf8")) as { refreshToken: string }).refreshToken;
      const done = await run(envFor(s, { XERO_VERIFY_TOKEN_FILE: seeded, XERO_VERIFY_REFRESH_TOKEN: seed }));
      expect(done.out).toMatch(/xero: PASS/);
      expect(done.out).not.toContain(seed);
      expect(fs.existsSync(seeded)).toBe(true);
      expect((JSON.parse(fs.readFileSync(seeded, "utf8")) as { refreshToken: string }).refreshToken).not.toBe(seed);
    } finally {
      await s.close();
    }
  });
});
