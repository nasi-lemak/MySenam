import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { spawn } from "child_process";
import http from "http";

/**
 * The real-provider harness (scripts/verify-integrations.mjs), against
 * stand-ins for Stripe and the WhatsApp Graph API: it reports BLOCKED, with
 * the variables needed, when credentials are absent; refuses a live key
 * before sending anything; runs its test-mode steps; and never prints a
 * credential, even when a provider echoes one back. Stand-ins prove the
 * harness, not the providers.
 */

const calls: { method: string; url: string }[] = [];
let server: http.Server;
let base = "";

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      calls.push({ method: req.method!, url: req.url! });
      const json = (status: number, data: unknown) => res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(data));
      const url = new URL(req.url!, "http://x");
      if (url.pathname === "/v1/balance") return json(200, { object: "balance", livemode: false });
      if (url.pathname === "/v1/checkout/sessions" && req.method === "POST") return json(200, { id: "cs_test_1", url: "https://checkout.stripe.com/c/pay/cs_test_1", payment_status: "unpaid" });
      if (url.pathname === "/v1/checkout/sessions/cs_test_1") return json(200, { id: "cs_test_1", payment_status: "unpaid", status: "open" });
      if (url.pathname === "/v1/checkout/sessions/cs_test_1/expire") return json(200, { id: "cs_test_1", status: "expired" });
      // A provider that echoes the token it was given back in an error.
      if (url.pathname.startsWith("/v23.0/")) return json(401, { error: { message: `Invalid OAuth access token - ${String(req.headers.authorization).slice(7)}` } });
      json(404, {});
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(() => server.close());
beforeEach(() => {
  calls.length = 0;
});

function run(env: Record<string, string>, ...args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["scripts/verify-integrations.mjs", ...args], { env: { PATH: process.env.PATH, NODE_ENV: "test", ...env } });
    let out = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (out += c));
    child.on("close", (code) => resolve({ code, out }));
  });
}

describe("the integrations harness", () => {
  it("reports each provider BLOCKED, naming what it needs, when no credentials are set", async () => {
    const done = await run({}, "all");
    expect(done.code).toBe(0);
    expect(done.out).toMatch(/stripe: BLOCKED, billplz: BLOCKED, email: BLOCKED, whatsapp: BLOCKED, sms: BLOCKED, b2: BLOCKED/);
    expect(done.out).toMatch(/set STRIPE_TEST_SECRET_KEY/);
    expect(calls).toHaveLength(0);
  });

  it("refuses a live Stripe key before sending anything", async () => {
    const done = await run({ STRIPE_TEST_SECRET_KEY: "sk_live_abcdefghijklmnop", STRIPE_API_URL: base }, "stripe");
    expect(done.code).toBe(1);
    expect(done.out).toMatch(/not a test-mode key.*refused, nothing sent/);
    expect(done.out).not.toMatch(/abcdefghijklmnop/);
    expect(calls).toHaveLength(0);
  });

  it("checks a test key, then makes, reads and expires a Checkout Session; the app steps are said not run without --through", async () => {
    const done = await run({ STRIPE_TEST_SECRET_KEY: "sk_test_abcdefghijklmnop", STRIPE_API_URL: base }, "stripe");
    expect(done.code).toBe(0);
    expect(done.out).toMatch(/✔ key accepted, test mode/);
    expect(done.out).toMatch(/✔ Checkout Session created/);
    expect(done.out).toMatch(/✔ Checkout Session expired/);
    expect(done.out).toMatch(/– through the app.*not run/);
    expect(done.out).toMatch(/stripe: PARTIAL/);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(["GET /v1/balance", "POST /v1/checkout/sessions", "GET /v1/checkout/sessions/cs_test_1", "POST /v1/checkout/sessions/cs_test_1/expire"]);
  });

  it("never prints a credential, even when the provider echoes it back", async () => {
    const done = await run({ WHATSAPP_TOKEN: "EAAG-very-secret-token-1234", WHATSAPP_PHONE_NUMBER_ID: "1234567890", WHATSAPP_GRAPH_URL: base }, "whatsapp");
    expect(done.code).toBe(1);
    expect(done.out).toMatch(/Invalid OAuth access token - \*\*\*/);
    expect(done.out).not.toMatch(/very-secret-token/);
  });
});
