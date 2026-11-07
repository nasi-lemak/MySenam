import { billplzHost, createBill, fetchBill, redirectBillId, verifyCallback, verifyRedirect, type BillResult } from "../billplz";
import type { GatewayAccount, PaymentGateway, PaymentResult } from "./types";
import { englishOf, said } from "../staff-text";

/** Billplz (Malaysia): FPX online banking and cards. The protocol itself is in lib/billplz.ts. */
export const billplz: PaymentGateway = {
  id: "billplz",
  name: "Billplz",
  methods: "FPX online banking or card",
  currencies: ["MYR"],
  fields: [
    { key: "apiKey", label: "API secret key", secret: true, help: "Billplz → Settings → Keys & Integration" },
    { key: "collectionId", label: "Collection ID", secret: false, help: "Billplz → Billing → the collection to pay into" },
    { key: "xSignatureKey", label: "X Signature key", secret: true, help: "Billplz → Settings → Keys & Integration" },
  ],
  setup: englishOf(said("srv.gw.billplz.setup")),
  setupPhrase: said("srv.gw.billplz.setup"),
  // No `pageExpiry`: a Billplz bill stays payable until it is paid, so nothing here can close one at a set time.

  checkCredentials(c) {
    return /^[\w-]{3,40}$/.test(c.collectionId) ? null : "That does not look like a Billplz collection ID.";
  },

  async testConnection(account) {
    const { apiKey, collectionId } = account.credentials;
    let res: Response;
    try {
      res = await fetch(`${billplzHost(account.sandbox)}/api/v3/collections/${encodeURIComponent(collectionId)}`, {
        headers: { Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}` },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      return `Could not reach Billplz to check the keys: ${err instanceof Error ? err.message : err}. Try again.`;
    }
    if (res.ok) return null;
    if (res.status === 401)
      return `Billplz did not accept the API key${account.sandbox ? " on its sandbox" : ""}. A sandbox key only works with Sandbox ticked, and a live key only without.`;
    if (res.status === 404) return `That Billplz account has no collection ${collectionId}.`;
    return `Billplz answered ${res.status} when the keys were checked. Try again.`;
  },

  async createCheckout(account, request) {
    if (request.currency.code !== "MYR") throw new Error("Billplz takes ringgit only.");
    return createBill(toBillplz(account), request);
  },

  readCallback(body) {
    const fields: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(body)) fields[k] = v;
    return {
      billId: fields.id || null,
      verify: async (account) => {
        const result = verifyCallback(fields, account.credentials.xSignatureKey);
        return result && resultOf(result, account);
      },
    };
  },

  readRedirect(query) {
    const billId = redirectBillId(query);
    if (!billId) return null;
    return {
      billId,
      verify: async (account) => {
        const seen = verifyRedirect(query, account.credentials.xSignatureKey);
        if (!seen || !seen.paid) return seen;
        // The redirect says nothing of the amount (Billplz sends the id, the paid flag, the time and the signature),
        // so a paid one is believed only once the bill itself says the same. If Billplz cannot be asked, or does not
        // say paid, the outcome is unconfirmed here and the callback, which carries the amounts, decides.
        const bill = await fetchBill(toBillplz(account), seen.billId).catch(() => null);
        if (!bill || !bill.paid) return { billId: seen.billId, paid: true, paidAt: seen.paidAt, unconfirmed: true };
        return resultOf({ ...bill, paidAt: seen.paidAt ?? bill.paidAt }, account);
      },
    };
  },

  platformAccount(env) {
    const { BILLPLZ_API_KEY: apiKey, BILLPLZ_COLLECTION_ID: collectionId, BILLPLZ_X_SIGNATURE_KEY: xSignatureKey } = env;
    if (!apiKey || !collectionId || !xSignatureKey) return null;
    return { provider: "billplz", sandbox: env.BILLPLZ_SANDBOX === "on", credentials: { apiKey, collectionId, xSignatureKey } };
  },
};

/**
 * A signed report as the settlement sees it: the amounts Billplz gave, in sen and ringgit (Billplz takes ringgit only),
 * or why it cannot be checked. A paid report in another collection than the account pays into, or without the amounts
 * Billplz documents on it, is held for staff and applied to nothing (lib/payment-settlement.ts).
 */
function resultOf(r: BillResult, account: GatewayAccount): PaymentResult {
  const out: PaymentResult = { billId: r.billId, paid: r.paid, paidAt: r.paidAt };
  if (!r.paid) return out;
  const known = { billedMinor: r.billedMinor ?? null, receivedMinor: r.receivedMinor ?? null, currency: "MYR" };
  const collection = account.credentials.collectionId;
  if (r.collectionId && collection && r.collectionId !== collection) return { ...out, ...known, mismatch: "collection" };
  if (known.billedMinor === null || known.receivedMinor === null) return { ...out, ...known, mismatch: "unverified" };
  return { ...out, ...known };
}

function toBillplz(account: GatewayAccount) {
  const { apiKey, collectionId, xSignatureKey } = account.credentials;
  return { apiKey, collectionId, xSignatureKey, sandbox: account.sandbox };
}
