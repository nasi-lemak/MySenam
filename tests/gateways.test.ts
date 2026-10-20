import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import path from "path";

process.env.MYSENAM_DB = ":memory:";
process.env.MYSENAM_URL = "https://book.example.my";

vi.mock("next/headers", () => ({
  headers: async () => new Headers({ host: "localhost:3000" }),
  cookies: async () => ({ get: () => undefined }),
}));

import { NextRequest } from "next/server";
import { getDb } from "../src/lib/db";
import { seal } from "../src/lib/secrets";
import { xSignature } from "../src/lib/billplz";
import { allGateways, gatewayFor, offeredGateways, openCheckout, platformAccount } from "../src/lib/gateways";
import { accountForBill, paymentSettings, savePaymentSettings, venueAccount } from "../src/lib/payments";
import { createVenue } from "../src/lib/store";
import { POST as callback } from "../src/app/api/payments/[provider]/callback/route";

/**
 * The payment gateway layer: nothing outside lib/gateways knows which gateway
 * a payment went through, and a report is only ever checked by the gateway,
 * and the account, the payment was made with.
 */

let venueId: number;

beforeAll(async () => {
  const made = await createVenue({ name: "Gateway Hall", area: "PJ", address: "x", phone: "0300000000" });
  if (!made.ok) throw new Error("venue");
  venueId = made.venue.id;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.MYSENAM_PAYMENT_PROVIDERS;
  delete process.env.MYSENAM_PAYMENT_PROVIDER;
});

describe("the registry", () => {
  it("knows each gateway by its id, and nothing else", () => {
    expect(gatewayFor("billplz")?.name).toBe("Billplz");
    expect(gatewayFor("constructor")).toBeNull();
    expect(gatewayFor("nope")).toBeNull();
    for (const g of allGateways()) {
      expect(g.fields.length).toBeGreaterThan(0);
      expect(g.currencies.length).toBeGreaterThan(0);
    }
  });

  it("offers what the install names, and Billplz when it names nothing it knows", () => {
    expect(offeredGateways().map((g) => g.id)).toEqual(["billplz"]);
    process.env.MYSENAM_PAYMENT_PROVIDERS = "nonsense";
    expect(offeredGateways().map((g) => g.id)).toEqual(["billplz"]);
  });

  it("refuses a gateway the install does not offer", async () => {
    expect(await savePaymentSettings(venueId, { provider: "nope", credentials: {}, sandbox: true, enabled: true })).toMatchObject({
      ok: false,
      error: "That payment gateway is not offered here.",
    });
  });

  it("reads the platform's own account from the gateway's environment", () => {
    process.env.BILLPLZ_API_KEY = "pk";
    process.env.BILLPLZ_COLLECTION_ID = "pcol";
    process.env.BILLPLZ_X_SIGNATURE_KEY = "psig";
    try {
      expect(platformAccount()).toEqual({
        provider: "billplz",
        sandbox: false,
        credentials: { apiKey: "pk", collectionId: "pcol", xSignatureKey: "psig" },
      });
    } finally {
      delete process.env.BILLPLZ_API_KEY;
      delete process.env.BILLPLZ_COLLECTION_ID;
      delete process.env.BILLPLZ_X_SIGNATURE_KEY;
    }
    expect(platformAccount()).toBeNull();
  });
});

describe("a venue's account", () => {
  it("is saved as the gateway's own fields, secrets sealed one by one", async () => {
    const saved = await savePaymentSettings(venueId, {
      provider: "billplz",
      credentials: { apiKey: "key-abcd", collectionId: "col1", xSignatureKey: "sig-wxyz" },
      sandbox: true,
      enabled: true,
    });
    expect(saved).toMatchObject({
      ok: true,
      settings: { provider: "billplz", providerName: "Billplz", details: { apiKey: "abcd", collectionId: "col1", xSignatureKey: "wxyz" } },
    });
    const { credentials } = (await getDb()
      .prepare("SELECT credentials FROM venue_payment_accounts WHERE venue_id = ?")
      .get(venueId)) as { credentials: string };
    expect(credentials).not.toContain("key-abcd");
    expect(credentials).not.toContain("sig-wxyz");
    expect(JSON.parse(credentials).collectionId).toBe("col1");
    expect(await venueAccount(venueId)).toEqual({
      provider: "billplz",
      sandbox: true,
      credentials: { apiKey: "key-abcd", collectionId: "col1", xSignatureKey: "sig-wxyz" },
    });
  });

  it("names the field that is missing", async () => {
    const other = await createVenue({ name: "New Hall", area: "PJ", address: "x", phone: "0300000001" });
    if (!other.ok) throw new Error("venue");
    expect(
      await savePaymentSettings(other.venue.id, { provider: "billplz", credentials: { apiKey: "k", collectionId: "col1" }, sandbox: true, enabled: true })
    ).toMatchObject({ ok: false, error: "X Signature key is needed the first time." });
    expect((await paymentSettings(other.venue.id)).details).toEqual({ apiKey: null, collectionId: null, xSignatureKey: null });
  });

  it("opens pages that report back to that gateway's callback", async () => {
    let form: URLSearchParams | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: { body: string }) => {
        form = new URLSearchParams(init.body);
        return Response.json({ id: "gw1", url: "https://www.billplz-sandbox.com/bills/gw1" });
      })
    );
    const page = await openCheckout((await venueAccount(venueId))!, {
      amount: 12.5,
      name: "Aina",
      email: "aina@example.my",
      description: "Court 1",
      redirectUrl: "https://book.example.my/payments/return",
    });
    expect(page).toEqual({ id: "gw1", url: "https://www.billplz-sandbox.com/bills/gw1" });
    expect(form!.get("callback_url")).toBe("https://book.example.my/api/payments/billplz/callback");
    expect(form!.get("amount")).toBe("1250");
  });
});

describe("reports from a gateway", () => {
  it("are checked only by the gateway the payment was made through", async () => {
    await getDb()
      .prepare("INSERT INTO online_payments (provider, bill_id, url, venue_id, amount) VALUES ('billplz', 'gwbill', 'u', ?, 10)")
      .run(venueId);
    expect(await accountForBill("billplz", "gwbill")).not.toBeNull();
    expect(await accountForBill("stripe", "gwbill")).toBeNull();
    expect(await accountForBill("billplz", "nobody")).toBeNull();
  });

  it("to a gateway nobody has heard of are not found", async () => {
    const res = await callback(new NextRequest("http://localhost/api/payments/nope/callback", { method: "POST", body: "id=gwbill" }), {
      params: Promise.resolve({ provider: "nope" }),
    });
    expect(res.status).toBe(404);
  });

  it("settle through the generic route when signed with the venue's key", async () => {
    const fields: Record<string, string> = { id: "gwbill", paid: "true", paid_at: "2026-10-19 10:00:00 +0800" };
    const post = (key: string) =>
      callback(
        new NextRequest("http://localhost/api/payments/billplz/callback", {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ ...fields, x_signature: xSignature(fields, key) }).toString(),
        }),
        { params: Promise.resolve({ provider: "billplz" }) }
      );
    expect((await post("guessed")).status).toBe(400);
    expect((await post("sig-wxyz")).status).toBe(200);
    const row = (await getDb().prepare("SELECT status FROM online_payments WHERE bill_id = 'gwbill'").get()) as { status: string };
    expect(row.status).toBe("paid");
  });
});

describe("migration 0034", () => {
  it("moves a Billplz account from its old columns without unsealing anything", async () => {
    const db = getDb();
    const legacy = await createVenue({ name: "Old Hall", area: "PJ", address: "x", phone: "0300000002" });
    if (!legacy.ok) throw new Error("venue");
    // The table as it was before the migration, with one account in it.
    await db.prepare("ALTER TABLE venue_payment_accounts ADD COLUMN api_key TEXT").run();
    await db.prepare("ALTER TABLE venue_payment_accounts ADD COLUMN collection_id TEXT").run();
    await db.prepare("ALTER TABLE venue_payment_accounts ADD COLUMN x_signature_key TEXT").run();
    await db.prepare("ALTER TABLE venue_payment_accounts ALTER COLUMN credentials DROP NOT NULL").run();
    await db
      .prepare(
        "INSERT INTO venue_payment_accounts (venue_id, provider, api_key, collection_id, x_signature_key, sandbox, enabled) VALUES (?, 'billplz', ?, 'oldcol', ?, 1, 1)"
      )
      .run(legacy.venue.id, seal("old-api-key"), seal("old-sig-key"));

    const sql = readFileSync(path.join(process.cwd(), "db/migrations/0034_payment_gateways.sql"), "utf8")
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const statement of sql) await db.prepare(statement).run();

    expect(await venueAccount(legacy.venue.id)).toEqual({
      provider: "billplz",
      sandbox: true,
      credentials: { apiKey: "old-api-key", collectionId: "oldcol", xSignatureKey: "old-sig-key" },
    });
    // And the accounts saved since are untouched.
    expect((await venueAccount(venueId))?.credentials.apiKey).toBe("key-abcd");
  });
});

describe("checking keys when they are saved", () => {
  const save = (check: boolean) =>
    savePaymentSettings(venueId, {
      provider: "billplz",
      credentials: { apiKey: "key-abcd", collectionId: "col1", xSignatureKey: "sig-wxyz" },
      sandbox: true,
      enabled: true,
      check,
    });
  const answer = (status: number) => vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status })));

  it("asks Billplz for the collection, and says what is wrong", async () => {
    answer(401);
    expect(await save(true)).toMatchObject({ ok: false, error: expect.stringContaining("did not accept the API key") });
    answer(404);
    expect(await save(true)).toMatchObject({ ok: false, error: "That Billplz account has no collection col1." });
    vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("timed out"); }));
    expect(await save(true)).toMatchObject({ ok: false, error: expect.stringContaining("Could not reach Billplz") });
    const calls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string) => (calls.push(url), new Response("{}", { status: 200 }))));
    expect(await save(true)).toMatchObject({ ok: true });
    expect(calls).toEqual(["https://www.billplz-sandbox.com/api/v3/collections/col1"]);
  });

  it("is not done unless asked, nor for an account switched off", async () => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    expect(await save(false)).toMatchObject({ ok: true });
    expect(
      await savePaymentSettings(venueId, { provider: "billplz", credentials: {}, sandbox: true, enabled: false, check: true })
    ).toMatchObject({ ok: true });
    expect(fetcher).not.toHaveBeenCalled();
  });
});
