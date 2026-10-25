import { billplzHost, createBill, redirectBillId, verifyCallback, verifyRedirect } from "../billplz";
import type { GatewayAccount, PaymentGateway } from "./types";
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
      verify: async (account) => verifyCallback(fields, account.credentials.xSignatureKey),
    };
  },

  readRedirect(query) {
    const billId = redirectBillId(query);
    if (!billId) return null;
    return { billId, verify: async (account) => verifyRedirect(query, account.credentials.xSignatureKey) };
  },

  platformAccount(env) {
    const { BILLPLZ_API_KEY: apiKey, BILLPLZ_COLLECTION_ID: collectionId, BILLPLZ_X_SIGNATURE_KEY: xSignatureKey } = env;
    if (!apiKey || !collectionId || !xSignatureKey) return null;
    return { provider: "billplz", sandbox: env.BILLPLZ_SANDBOX === "on", credentials: { apiKey, collectionId, xSignatureKey } };
  },
};

function toBillplz(account: GatewayAccount) {
  const { apiKey, collectionId, xSignatureKey } = account.credentials;
  return { apiKey, collectionId, xSignatureKey, sandbox: account.sandbox };
}
