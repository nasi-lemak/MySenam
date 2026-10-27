import crypto from "crypto";
import http from "http";
import path from "path";
import type { TestProject } from "vitest/node";

/**
 * A stand-in for Billplz's sandbox, for the acceptance scenarios only. **It
 * is not Billplz and proves nothing about it**: it answers the two calls the
 * app makes (`GET /api/v3/collections/:id` when a venue's keys are saved,
 * `POST /api/v3/bills` to open a payment page), serves a payment page of its
 * own with *Pay* and *Fail*, and then does what Billplz does: tells the app
 * server to server (the signed callback) and sends the customer's browser
 * back to the app with the signed result. The app reaches it through its
 * real gateway code (lib/gateways/billplz.ts, lib/billplz.ts) and verifies
 * every signature as it would Billplz's. The live checks are the real-service
 * ones (scripts/verify-integrations.mjs).
 *
 * Runs before the app starts (tests/e2e/server.ts), on the loopback, and
 * loads tests/uat/gateway-preload.mjs into the app (NODE_OPTIONS), which
 * sends the app's requests to Billplz's *sandbox* host here; the live host is
 * never touched. A venue reaches it only with the stand-in's own keys
 * (`BILLPLZ_STAND_IN`, sandbox ticked). Not started against a deployment
 * (E2E_URL).
 */

export const BILLPLZ_STAND_IN = {
  apiKey: "uat-stand-in-api-key",
  collectionId: "uat_collection",
  xSignatureKey: "uat-stand-in-x-signature-key",
} as const;

interface Bill {
  id: string;
  amount: number;
  description: string;
  name: string;
  email: string;
  mobile: string;
  callbackUrl: string;
  redirectUrl: string;
  state: "due" | "paid" | "failed";
}

/** Billplz's X-Signature (lib/billplz.ts): each field key-then-value, sorted without case, joined with `|`, HMAC-SHA256. */
function sign(fields: Record<string, string>): string {
  const source = Object.entries(fields)
    .map(([k, v]) => `${k}${v}`)
    .sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : 0))
    .join("|");
  return crypto.createHmac("sha256", BILLPLZ_STAND_IN.xSignatureKey).update(source).digest("hex");
}

const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);

let server: http.Server | undefined;

export default async function setup(project: TestProject) {
  if (process.env.E2E_URL) {
    project.provide("uatGateway", null);
    return;
  }
  const bills = new Map<string, Bill>();
  let n = 0;
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      void (async () => {
        const at = new URL(req.url ?? "/", "http://stand-in");
        const authorised = req.headers.authorization === `Basic ${Buffer.from(`${BILLPLZ_STAND_IN.apiKey}:`).toString("base64")}`;
        const json = (status: number, value: unknown) => {
          res.writeHead(status, { "content-type": "application/json" });
          res.end(JSON.stringify(value));
        };
        // The app saving a venue's keys: the collection is there.
        const collection = /^\/api\/v3\/collections\/([\w-]+)$/.exec(at.pathname);
        if (req.method === "GET" && collection) {
          if (!authorised) return json(401, { error: { type: "Unauthorized" } });
          if (collection[1] !== BILLPLZ_STAND_IN.collectionId) return json(404, { error: { type: "RecordNotFound" } });
          return json(200, { id: collection[1], title: "UAT stand-in collection" });
        }
        // The app opening a payment page.
        if (req.method === "POST" && at.pathname === "/api/v3/bills") {
          if (!authorised) return json(401, { error: { type: "Unauthorized" } });
          const form = new URLSearchParams(body);
          if (form.get("collection_id") !== BILLPLZ_STAND_IN.collectionId) return json(422, { error: { message: ["Collection not found"] } });
          const id = `uatbill${(++n).toString(36)}${Date.now().toString(36)}`;
          bills.set(id, {
            id,
            amount: Number(form.get("amount")),
            description: form.get("description") ?? "",
            name: form.get("name") ?? "",
            email: form.get("email") ?? "",
            mobile: form.get("mobile") ?? "",
            callbackUrl: form.get("callback_url") ?? "",
            redirectUrl: form.get("redirect_url") ?? "",
            state: "due",
          });
          return json(200, { id, url: `http://${req.headers.host}/bills/${id}`, state: "due" });
        }
        // The payment page the customer is sent to, and what they press there.
        const page = /^\/bills\/(\w+)(?:\/(pay|fail))?$/.exec(at.pathname);
        const bill = page ? bills.get(page[1]) : undefined;
        if (!page || !bill) {
          res.writeHead(404, { "content-type": "text/plain" });
          return res.end("Not found");
        }
        if (req.method === "GET" && !page[2]) {
          res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          return res.end(
            `<!doctype html><html><head><meta charset="utf-8"><title>Billplz stand-in</title></head><body>` +
              `<h1>Billplz stand-in (acceptance tests only, not Billplz)</h1>` +
              `<p data-testid="bill-amount">RM${(bill.amount / 100).toFixed(2)}</p>` +
              `<p data-testid="bill-description">${escape(bill.description)}</p>` +
              (bill.state === "due"
                ? `<form method="post" action="/bills/${bill.id}/pay"><button>Pay</button></form><form method="post" action="/bills/${bill.id}/fail"><button>Fail</button></form>`
                : `<p>This bill is ${bill.state}.</p>`) +
              `</body></html>`
          );
        }
        if (req.method === "POST" && page[2] && bill.state === "due") {
          const paid = page[2] === "pay";
          bill.state = paid ? "paid" : "failed";
          const paidAt = paid ? new Date().toISOString().replace("T", " ").slice(0, 19) + " +0800" : "";
          // Server to server first, as Billplz does: the message that counts.
          const fields: Record<string, string> = {
            id: bill.id,
            collection_id: BILLPLZ_STAND_IN.collectionId,
            paid: String(paid),
            state: bill.state === "paid" ? "paid" : "due",
            amount: String(bill.amount),
            paid_amount: paid ? String(bill.amount) : "0",
            due_at: new Date().toISOString().slice(0, 10),
            email: bill.email,
            mobile: bill.mobile,
            name: bill.name,
            url: `http://${req.headers.host}/bills/${bill.id}`,
            paid_at: paidAt,
          };
          await fetch(bill.callbackUrl, {
            method: "POST",
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams({ ...fields, x_signature: sign(fields) }).toString(),
          }).catch(() => undefined);
          // Then the customer's browser back to the app, with the signed result.
          const back: Record<string, string> = { billplzid: bill.id, billplzpaid: String(paid), billplzpaid_at: paidAt };
          const query = new URLSearchParams({
            "billplz[id]": bill.id,
            "billplz[paid]": String(paid),
            "billplz[paid_at]": paidAt,
            "billplz[x_signature]": sign(back),
          });
          res.writeHead(303, { location: `${bill.redirectUrl}${bill.redirectUrl.includes("?") ? "&" : "?"}${query}` });
          return res.end();
        }
        res.writeHead(409, { "content-type": "text/plain" });
        res.end("This bill is not due.");
      })();
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as import("net").AddressInfo;
  process.env.UAT_BILLPLZ_STAND_IN = `127.0.0.1:${port}`;
  const preload = path.join(import.meta.dirname, "gateway-preload.mjs");
  process.env.NODE_OPTIONS = `${process.env.NODE_OPTIONS ?? ""} --import ${preload}`.trim();
  project.provide("uatGateway", `127.0.0.1:${port}`);
  return async () => {
    await new Promise<void>((resolve) => server?.close(() => resolve()));
  };
}

declare module "vitest" {
  export interface ProvidedContext {
    uatGateway: string | null;
  }
}
