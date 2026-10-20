import crypto from "crypto";
import type { GatewayAccount, Inbound, PaymentGateway, PaymentResult } from "./types";

/**
 * Stripe (Singapore, and most places beyond): cards, PayNow and the wallets a
 * venue turns on in its own Stripe dashboard, through Stripe Checkout.
 *
 * The venue connects its own Stripe account with a restricted key and the
 * signing secret of a webhook it points at MySenam, so the money goes to the
 * venue and MySenam never holds it, as with Billplz. Checkout reports by
 * webhook (signed with that secret) and sends the customer back with the
 * session's id in the address, which carries no signature: the return page
 * asks Stripe what became of the session instead of believing the address.
 */

const API = "https://api.stripe.com/v1";
/** How old a signed webhook may be, as Stripe's own libraries allow. */
const TOLERANCE_SECONDS = 300;
/** The query parameter the customer comes back with. */
const RETURN_PARAM = "stripe_session";

/** The checkout session events that say something about a payment. */
const PAYMENT_EVENTS = new Set([
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "checkout.session.async_payment_failed",
  "checkout.session.expired",
]);

interface Session {
  id: string;
  url?: string | null;
  payment_status?: "paid" | "unpaid" | "no_payment_required";
  status?: "open" | "complete" | "expired";
}

async function call(account: GatewayAccount, method: "GET" | "POST", path: string, form?: URLSearchParams): Promise<Session> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${account.credentials.secretKey}`,
      ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: form?.toString(),
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await res.json().catch(() => null)) as (Session & { error?: { message?: string } }) | null;
  if (!res.ok || !data?.id) {
    const why = data?.error?.message;
    throw new Error(`Stripe refused the request (${res.status})${why ? `: ${why}` : ""}`);
  }
  return data;
}

function result(session: Session, paidAt: string | null): PaymentResult {
  return { billId: session.id, paid: session.payment_status === "paid", paidAt };
}

/** The address to come back to, with Stripe's placeholder for the session id. */
function returnTo(redirectUrl: string): string {
  const joiner = redirectUrl.includes("?") ? "&" : "?";
  return `${redirectUrl}${joiner}${RETURN_PARAM}={CHECKOUT_SESSION_ID}`;
}

/**
 * Stripe's `Stripe-Signature` header: `t=<unix time>,v1=<hex HMAC-SHA256 of
 * "<t>.<raw body>">`, possibly with several v1 entries while a secret is
 * being rolled.
 */
export function stripeSignatureValid(body: string, header: string | null, secret: string, now = Date.now()): boolean {
  if (!header) return false;
  const parts = header.split(",").map((p) => p.trim().split("="));
  const t = parts.find(([k]) => k === "t")?.[1];
  const signatures = parts.filter(([k]) => k === "v1").map(([, v]) => v ?? "");
  if (!t || !/^\d+$/.test(t) || signatures.length === 0) return false;
  if (Math.abs(now / 1000 - Number(t)) > TOLERANCE_SECONDS) return false;
  const expected = crypto.createHmac("sha256", secret).update(`${t}.${body}`).digest("hex");
  return signatures.some(
    (v) => v.length === expected.length && crypto.timingSafeEqual(Buffer.from(v), Buffer.from(expected))
  );
}

export const stripe: PaymentGateway = {
  id: "stripe",
  name: "Stripe",
  methods: "Card, PayNow or wallet",
  currencies: ["SGD", "MYR", "USD", "AUD", "THB", "PHP", "IDR", "HKD", "EUR", "GBP", "CAD"],
  fields: [
    {
      key: "secretKey",
      label: "Restricted key",
      secret: true,
      help: "Stripe → Developers → API keys → Create restricted key, with Checkout Sessions set to Write. Starts rk_live_ (or rk_test_).",
    },
    {
      key: "webhookSecret",
      label: "Webhook signing secret",
      secret: true,
      help: "Stripe → Developers → Webhooks → the endpoint below → Signing secret. Starts whsec_.",
    },
  ],
  webhook: true,
  setup:
    "In Stripe, add a webhook endpoint at the address below, sending checkout.session.completed, checkout.session.async_payment_succeeded, checkout.session.async_payment_failed and checkout.session.expired. Turn on PayNow and cards under Settings → Payment methods.",

  checkCredentials(c) {
    if (!/^(rk|sk)_(live|test)_[A-Za-z0-9]{10,}$/.test(c.secretKey)) return "That does not look like a Stripe key (rk_live_… or sk_live_…).";
    if (!/^whsec_[A-Za-z0-9+/=]{10,}$/.test(c.webhookSecret)) return "That does not look like a Stripe webhook signing secret (whsec_…).";
    return null;
  },

  async createCheckout(account, request) {
    const minor = 10 ** request.currency.minorUnits;
    const form = new URLSearchParams({
      mode: "payment",
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": request.currency.code.toLowerCase(),
      "line_items[0][price_data][unit_amount]": String(Math.round(request.amount * minor)),
      "line_items[0][price_data][product_data][name]": request.description.slice(0, 250),
      success_url: returnTo(request.redirectUrl),
      cancel_url: returnTo(request.redirectUrl),
    });
    if (request.email) form.set("customer_email", request.email);
    if (request.reference) {
      form.set("client_reference_id", request.reference.value.slice(0, 200));
      form.set(`metadata[${request.reference.label.toLowerCase().replace(/\W+/g, "_")}]`, request.reference.value.slice(0, 500));
    }
    const session = await call(account, "POST", "/checkout/sessions", form);
    if (!session.url) throw new Error("Stripe gave no payment page for that session.");
    return { id: session.id, url: session.url };
  },

  readCallback(body, headers): Inbound {
    let event: { type?: string; created?: number; data?: { object?: Session & { object?: string } } } | null = null;
    try {
      event = JSON.parse(body);
    } catch {
      event = null;
    }
    const session = event?.data?.object;
    if (!event?.type || !session?.id) return { billId: null, verify: async () => null };
    // Other events on the venue's account are not ours to settle.
    if (!PAYMENT_EVENTS.has(event.type) || session.object !== "checkout.session")
      return { billId: null, ignored: true, verify: async () => null };
    const signature = headers.get("stripe-signature");
    return {
      billId: session.id,
      verify: async (account) => {
        if (!stripeSignatureValid(body, signature, account.credentials.webhookSecret)) return null;
        const paidAt = event?.created ? new Date(event.created * 1000).toISOString() : null;
        return result(session, session.payment_status === "paid" ? paidAt : null);
      },
    };
  },

  readRedirect(query) {
    const billId = query.get(RETURN_PARAM);
    if (!billId || !/^cs_(live|test)_[A-Za-z0-9]+$/.test(billId)) return null;
    return {
      billId,
      // Nothing in the address is signed: ask Stripe, with the venue's key.
      verify: async (account) => {
        try {
          const session = await call(account, "GET", `/checkout/sessions/${encodeURIComponent(billId)}`);
          return session.id === billId ? result(session, null) : null;
        } catch {
          return null;
        }
      },
    };
  },

  platformAccount(env) {
    const { STRIPE_SECRET_KEY: secretKey, STRIPE_WEBHOOK_SECRET: webhookSecret } = env;
    if (!secretKey || !webhookSecret) return null;
    return { provider: "stripe", sandbox: secretKey.includes("_test_"), credentials: { secretKey, webhookSecret } };
  },
};
