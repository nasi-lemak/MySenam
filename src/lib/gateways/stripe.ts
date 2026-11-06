import crypto from "crypto";
import type { DisputeEvent, GatewayAccount, Inbound, PaymentGateway, PaymentResult, RefundResult, RefundsEvent, SubscriptionEvent } from "./types";
import { englishOf, said } from "../staff-text";

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

/** A subscription's later charges, and its end. The first charge comes as its checkout session. */
const SUBSCRIPTION_EVENTS = new Set(["invoice.paid", "customer.subscription.deleted"]);

/** A chargeback opened, moving on, or decided. */
const DISPUTE_EVENTS = new Set(["charge.dispute.created", "charge.dispute.updated", "charge.dispute.closed"]);

/** A refund made on a payment, by MySenam or in the venue's own Stripe dashboard. */
const REFUND_EVENTS = new Set(["charge.refunded", "charge.refund.updated"]);

/** Every event the webhook acts on: what a venue is told to send, so the two cannot drift apart. */
export const HANDLED_EVENTS = [...PAYMENT_EVENTS, ...SUBSCRIPTION_EVENTS, ...DISPUTE_EVENTS, ...REFUND_EVENTS];

/** What to set up in Stripe, for the settings form. */
const SETUP = said("srv.rg7.stripeSetup", {
  payment: [...PAYMENT_EVENTS].join(", "),
  subscription: said("srv.list.and", { a: [...SUBSCRIPTION_EVENTS].slice(0, -1).join(", "), b: [...SUBSCRIPTION_EVENTS].at(-1)! }),
  dispute: [...DISPUTE_EVENTS].join(", "),
  refund: said("srv.list.and", { a: [...REFUND_EVENTS].slice(0, -1).join(", "), b: [...REFUND_EVENTS].at(-1)! }),
});

interface Dispute {
  id: string;
  object: "dispute";
  payment_intent?: string | null;
  charge?: string | null;
  amount: number;
  reason?: string;
  status: string;
  evidence_details?: { due_by?: number | null };
}

interface Session {
  id: string;
  url?: string | null;
  payment_status?: "paid" | "unpaid" | "no_payment_required";
  status?: "open" | "complete" | "expired";
  payment_intent?: string | null;
  subscription?: string | null;
}

interface Invoice {
  id: string;
  object: "invoice";
  billing_reason?: string;
  amount_paid?: number;
  /** Where API versions before 2025 put it. */
  subscription?: string | null;
  parent?: { subscription_details?: { subscription?: string | null } | null } | null;
}

interface Subscription {
  id: string;
  object: "subscription";
}

interface Refund {
  id: string;
  /** In the currency's smallest unit. */
  amount?: number;
  status?: "pending" | "requires_action" | "succeeded" | "failed" | "canceled";
  metadata?: Record<string, string>;
}

/** The refunds made against a payment so far (Stripe lists at most 100 at a time; a booking payment has a handful). */
async function refundsOf(account: GatewayAccount, paymentIntent: string): Promise<Refund[]> {
  const res = await fetch(`${API}/refunds?payment_intent=${encodeURIComponent(paymentIntent)}&limit=100`, {
    headers: { Authorization: `Bearer ${account.credentials.secretKey}` },
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await res.json().catch(() => null)) as { data?: Refund[]; error?: { message?: string } } | null;
  if (!res.ok || !Array.isArray(data?.data)) {
    const why = data?.error?.message;
    throw new StripeError(`Stripe refused the request (${res.status})${why ? `: ${why}` : ""}`, res.status);
  }
  return data.data;
}

/** Stripe's answer was not a success: its status, for a message that says what to do. */
class StripeError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

async function call<T extends { id: string } = Session>(
  account: GatewayAccount,
  method: "GET" | "POST" | "DELETE",
  path: string,
  form?: URLSearchParams,
  idempotencyKey?: string
): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${account.credentials.secretKey}`,
      ...(form ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
    },
    body: form?.toString(),
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await res.json().catch(() => null)) as (T & { error?: { message?: string } }) | null;
  if (!res.ok || !data?.id) {
    const why = data?.error?.message;
    throw new StripeError(`Stripe refused the request (${res.status})${why ? `: ${why}` : ""}`, res.status);
  }
  return data;
}

function result(session: Session, paidAt: string | null): PaymentResult {
  return {
    billId: session.id,
    paid: session.payment_status === "paid",
    paidAt,
    ...(session.subscription ? { subscriptionId: session.subscription } : {}),
  };
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
      help: "Stripe → Developers → API keys → Create restricted key, with Checkout Sessions, Refunds and Subscriptions set to Write. Starts rk_live_ (or rk_test_).",
    },
    {
      key: "webhookSecret",
      label: "Webhook signing secret",
      secret: true,
      help: "Stripe → Developers → Webhooks → the endpoint below → Signing secret. Starts whsec_.",
    },
  ],
  webhook: true,
  setup: englishOf(SETUP),
  setupPhrase: SETUP,

  checkCredentials(c) {
    if (!/^(rk|sk)_(live|test)_[A-Za-z0-9]{10,}$/.test(c.secretKey)) return "That does not look like a Stripe key (rk_live_… or sk_live_…).";
    if (!/^whsec_[A-Za-z0-9+/=]{10,}$/.test(c.webhookSecret)) return "That does not look like a Stripe webhook signing secret (whsec_…).";
    return null;
  },

  sandboxFrom(c) {
    return c.secretKey.includes("_test_");
  },

  async testConnection(account) {
    let res: Response;
    try {
      res = await fetch(`${API}/checkout/sessions?limit=1`, {
        headers: { Authorization: `Bearer ${account.credentials.secretKey}` },
        signal: AbortSignal.timeout(15_000),
      });
    } catch (err) {
      return `Could not reach Stripe to check the key: ${err instanceof Error ? err.message : err}. Try again.`;
    }
    if (res.ok) return null;
    if (res.status === 401) return "Stripe did not accept that key. Copy it again from Developers → API keys.";
    if (res.status === 403) return "That key cannot use Checkout Sessions. Edit the restricted key in Stripe and set Checkout Sessions to Write.";
    return `Stripe answered ${res.status} when the key was checked. Try again.`;
  },

  async createCheckout(account, request) {
    const minor = 10 ** request.currency.minorUnits;
    const form = new URLSearchParams({
      mode: request.recurring ? "subscription" : "payment",
      "line_items[0][quantity]": "1",
      "line_items[0][price_data][currency]": request.currency.code.toLowerCase(),
      "line_items[0][price_data][unit_amount]": String(Math.round(request.amount * minor)),
      "line_items[0][price_data][product_data][name]": request.description.slice(0, 250),
      success_url: returnTo(request.redirectUrl),
      cancel_url: returnTo(request.redirectUrl),
    });
    if (request.recurring) {
      form.set("line_items[0][price_data][recurring][interval]", "month");
      form.set("line_items[0][price_data][recurring][interval_count]", String(request.recurring.months));
    }
    // Stripe closes a page no sooner than 30 minutes, and no later than (and by default after) a day.
    if (request.expiresInMinutes)
      form.set("expires_at", String(Math.floor(Date.now() / 1000) + Math.min(24 * 60, Math.max(30, request.expiresInMinutes)) * 60));
    if (request.email) form.set("customer_email", request.email);
    if (request.reference) {
      form.set("client_reference_id", request.reference.value.slice(0, 200));
      form.set(`metadata[${request.reference.label.toLowerCase().replace(/\W+/g, "_")}]`, request.reference.value.slice(0, 500));
    }
    const session = await call(account, "POST", "/checkout/sessions", form);
    if (!session.url) throw new Error("Stripe gave no payment page for that session.");
    return { id: session.id, url: session.url };
  },

  async refund(account, request): Promise<RefundResult> {
    let asked = false;
    try {
      const session = await call(account, "GET", `/checkout/sessions/${encodeURIComponent(request.billId)}`);
      if (!session.payment_intent) return { ok: false, error: "Stripe has no payment on that page to refund." };
      // Made already under this key? Stripe keeps an idempotency key for a
      // day; a retry after that, or one whose answer was lost, would make a
      // second refund. The key is on the refund itself, so it is found. If
      // Stripe cannot say, nothing is sent: it is asked again later.
      asked = true;
      const made = (await refundsOf(account, session.payment_intent)).find(
        (r) => r.metadata?.mysenam_key === request.idempotencyKey && r.status !== "failed" && r.status !== "canceled"
      );
      if (made) return { ok: true, refundId: made.id, pending: made.status !== "succeeded" };
      const form = new URLSearchParams({
        payment_intent: session.payment_intent,
        amount: String(Math.round(request.amount * 10 ** request.currency.minorUnits)),
        "metadata[mysenam_bill]": request.billId,
        "metadata[mysenam_key]": request.idempotencyKey,
      });
      const refund = await call<Refund>(account, "POST", "/refunds", form, request.idempotencyKey);
      if (refund.status === "failed" || refund.status === "canceled")
        return { ok: false, error: `Stripe could not make that refund (${refund.status}). Refund it in Stripe instead.` };
      return { ok: true, refundId: refund.id, pending: refund.status !== "succeeded" };
    } catch (err) {
      if (err instanceof StripeError && err.status === 403)
        return {
          ok: false,
          error: "The venue's Stripe key cannot make refunds. Edit the restricted key in Stripe and set Refunds to Write, or refund it in Stripe and mark it refunded.",
        };
      // Sent, and no clear answer: no reply, Stripe's own error, an answer we
      // could not read, or the same key still being worked on (409).
      const unknown =
        asked && (!(err instanceof StripeError) || err.status >= 500 || err.status === 409 || (err.status >= 200 && err.status < 300));
      return {
        ok: false,
        error: unknown
          ? "Stripe did not say whether it made that refund. It will be asked again in a few minutes, under the same key, so it is made once."
          : err instanceof Error
            ? err.message
            : "Stripe could not be reached. Try again.",
        ...(unknown ? { unknown: true } : {}),
      };
    }
  },

  async refundStatus(account, refundId) {
    try {
      const refund = await call<Refund>(account, "GET", `/refunds/${encodeURIComponent(refundId)}`);
      if (refund.status === "succeeded") return "succeeded";
      if (refund.status === "failed" || refund.status === "canceled") return "failed";
      return "pending";
    } catch {
      return "unknown";
    }
  },

  subscriptions: true,
  // A Checkout Session's `expires_at`: 30 minutes to 24 hours after it is made (createCheckout above).
  pageExpiry: { minMinutes: 30, maxMinutes: 24 * 60 },

  async billForPayment(account, paymentRef) {
    // The checkout session that made this payment intent: our page for it.
    try {
      const res = await fetch(`${API}/checkout/sessions?payment_intent=${encodeURIComponent(paymentRef)}&limit=1`, {
        headers: { Authorization: `Bearer ${account.credentials.secretKey}` },
        signal: AbortSignal.timeout(20_000),
      });
      const list = (await res.json().catch(() => null)) as { data?: { id: string }[] } | null;
      return res.ok ? (list?.data?.[0]?.id ?? null) : null;
    } catch {
      return null;
    }
  },

  async cancelSubscription(account, subscriptionId) {
    try {
      await call<Subscription>(account, "DELETE", `/subscriptions/${encodeURIComponent(subscriptionId)}`);
      return null;
    } catch (err) {
      if (err instanceof StripeError && err.status === 404) return null; // already gone
      if (err instanceof StripeError && err.status === 403)
        return "The venue's Stripe key cannot stop subscriptions. Edit the restricted key in Stripe and set Subscriptions to Write.";
      return err instanceof Error ? err.message : "Stripe could not be reached. Try again.";
    }
  },

  async pauseSubscription(account, subscriptionId, paused) {
    try {
      // Paused: invoices made meanwhile are voided, so nothing is charged and nothing is owed afterwards for the time paused; the
      // billing dates themselves do not move. Resumed: the field is cleared (Stripe takes an empty value as unsetting it).
      const form = new URLSearchParams(paused ? { "pause_collection[behavior]": "void" } : { pause_collection: "" });
      await call<Subscription>(account, "POST", `/subscriptions/${encodeURIComponent(subscriptionId)}`, form);
      return null;
    } catch (err) {
      if (err instanceof StripeError && err.status === 404) return null; // already gone
      if (err instanceof StripeError && err.status === 403)
        return "The venue's Stripe key cannot change subscriptions. Edit the restricted key in Stripe and set Subscriptions to Write.";
      return err instanceof Error ? err.message : "Stripe could not be reached. Try again.";
    }
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
    const signature = headers.get("stripe-signature");
    if (DISPUTE_EVENTS.has(event.type)) {
      const dispute = session as unknown as Dispute;
      const paymentRef = dispute.payment_intent ?? null;
      if (dispute.object !== "dispute" || !paymentRef) return { billId: null, ignored: true, verify: async () => null };
      return {
        billId: null,
        dispute: true,
        verify: async () => null,
        verifyDispute: async (account): Promise<DisputeEvent | null> => {
          if (!stripeSignatureValid(body, signature, account.credentials.webhookSecret)) return null;
          const due = dispute.evidence_details?.due_by;
          return {
            disputeId: dispute.id,
            paymentRef,
            amountMinor: dispute.amount,
            reason: dispute.reason ?? "general",
            status: dispute.status,
            dueBy: due ? new Date(due * 1000).toISOString() : null,
            outcome: dispute.status === "won" ? "won" : dispute.status === "lost" ? "lost" : null,
          };
        },
      };
    }
    if (REFUND_EVENTS.has(event.type)) {
      // A charge refunded (`charge.refunded`) or one of its refunds moving on (`charge.refund.updated`): either way,
      // every refund on the payment is read back from Stripe with the account's key, the list being what counts.
      const object = session as unknown as { object?: string; payment_intent?: string | null };
      const paymentRef = object.payment_intent ?? null;
      if ((object.object !== "charge" && object.object !== "refund") || !paymentRef) return { billId: null, ignored: true, verify: async () => null };
      return {
        billId: null,
        refunds: true,
        verify: async () => null,
        verifyRefunds: async (account): Promise<RefundsEvent | null> => {
          if (!stripeSignatureValid(body, signature, account.credentials.webhookSecret)) return null;
          const refunds = await refundsOf(account, paymentRef);
          return {
            paymentRef,
            refunds: refunds.map((r) => ({
              id: r.id,
              amountMinor: r.amount ?? 0,
              status: r.status === "succeeded" ? "succeeded" : r.status === "failed" || r.status === "canceled" ? "failed" : "pending",
              // Every refund MySenam asks for carries its key (`refund` above).
              ours: Boolean(r.metadata?.mysenam_key),
            })),
          };
        },
      };
    }
    if (SUBSCRIPTION_EVENTS.has(event.type)) {
      const object = session as unknown as Invoice | Subscription;
      const subscriptionId =
        object.object === "subscription"
          ? object.id
          : (object.parent?.subscription_details?.subscription ?? object.subscription ?? null);
      // A first charge is its checkout session's; and the venue's other Stripe business is not ours.
      if (!subscriptionId || (object.object === "invoice" && object.billing_reason !== "subscription_cycle"))
        return { billId: null, ignored: true, verify: async () => null };
      const created = event.created;
      return {
        billId: null,
        subscriptionId,
        verify: async () => null,
        verifySubscription: async (account): Promise<SubscriptionEvent | null> => {
          if (!stripeSignatureValid(body, signature, account.credentials.webhookSecret)) return null;
          if (object.object === "subscription") return { kind: "ended", subscriptionId };
          return {
            kind: "renewed",
            subscriptionId,
            chargeId: object.id,
            amountMinor: object.amount_paid ?? 0,
            paidAt: created ? new Date(created * 1000).toISOString() : null,
          };
        },
      };
    }
    // Other events on the venue's account are not ours to settle.
    if (!PAYMENT_EVENTS.has(event.type) || session.object !== "checkout.session")
      return { billId: null, ignored: true, verify: async () => null };
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
