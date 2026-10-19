import { createBill, redirectBillId, verifyCallback, verifyRedirect } from "../billplz";
import type { GatewayAccount, PaymentGateway } from "./types";

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
  setup: "Nothing needs setting up on the Billplz side: each bill tells Billplz where to report back.",

  checkCredentials(c) {
    return /^[\w-]{3,40}$/.test(c.collectionId) ? null : "That does not look like a Billplz collection ID.";
  },

  createCheckout(account, request) {
    return createBill(toBillplz(account), request);
  },

  readCallback(body) {
    const fields: Record<string, string> = {};
    for (const [k, v] of new URLSearchParams(body)) fields[k] = v;
    return {
      billId: fields.id || null,
      verify: (account) => verifyCallback(fields, account.credentials.xSignatureKey),
    };
  },

  readRedirect(query) {
    const billId = redirectBillId(query);
    if (!billId) return null;
    return { billId, verify: (account) => verifyRedirect(query, account.credentials.xSignatureKey) };
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
