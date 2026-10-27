/**
 * What MySenam needs from a payment gateway, whichever one it is.
 *
 * Every gateway MySenam uses works the same way at heart: open a hosted
 * payment page for an amount, send the customer to it, and be told what
 * happened twice: once server to server (the callback, which is what counts)
 * and once as the customer's browser comes back (the redirect, which may
 * arrive first, last or never). Each is believed only when it checks out under
 * the account's own key. What a payment was *for*, and what settling it does,
 * is the same for every gateway and lives in lib/payments.ts.
 */

import type { StaffText } from "../staff-text";

export type ProviderId = "billplz" | "stripe";

/** A venue's (or the platform's) account at one gateway, its secrets unsealed. */
export interface GatewayAccount {
  provider: ProviderId;
  sandbox: boolean;
  credentials: Record<string, string>;
}

/** The install's currency, as a gateway needs it. */
export interface Currency {
  /** ISO 4217, upper case: MYR, SGD. */
  code: string;
  /** Digits after the point the gateway counts in: 2 for cents and sen. */
  minorUnits: number;
}

export interface CheckoutRequest {
  /** In major units, as prices are held: ringgit or dollars, not sen or cents. */
  amount: number;
  currency: Currency;
  name: string;
  email?: string | null;
  /** Digits with the country code, e.g. 60123456789 or 6591234567. */
  mobile?: string | null;
  description: string;
  /** Where the gateway reports server to server. */
  callbackUrl: string;
  /** Where the customer's browser comes back to. */
  redirectUrl: string;
  /** Shown to the payer and on the venue's statement. */
  reference?: { label: string; value: string };
  /**
   * Close the page after this long, where the gateway can (a held booking is
   * let go then, and should not be paid for after). Left open otherwise.
   */
  expiresInMinutes?: number;
  /**
   * Charge the same again every this many months until stopped: a
   * subscription, where the gateway has them (`subscriptions`).
   */
  recurring?: { months: number };
}

/** A hosted payment page: the gateway's id for it, and where to send the payer. */
export interface CheckoutPage {
  id: string;
  url: string;
}

/** Money back to whoever paid on a page, through the gateway. */
export interface RefundRequest {
  /** The page that was paid. */
  billId: string;
  /** In major units. Up to what is left of the payment. */
  amount: number;
  currency: Currency;
  /** The same for a retry of the same refund, so the gateway makes it once. */
  idempotencyKey: string;
}

export type RefundResult =
  | { ok: true; refundId: string; /** Accepted, and still going through (some methods take days). */ pending: boolean }
  | {
      ok: false;
      error: string;
      /**
       * The request may have reached the gateway and nobody knows what it did
       * (no answer, a server error): asked again under the same idempotency
       * key, it says. Not a refusal, so what was claimed for it is kept.
       */
      unknown?: boolean;
    };

/** What the gateway says happened to a payment page. */
export interface PaymentResult {
  billId: string;
  paid: boolean;
  paidAt: string | null;
  /** A page that started a subscription: the gateway's id for it. */
  subscriptionId?: string | null;
}

/**
 * Word about a subscription rather than a page: charged again for a new
 * period, or ended (stopped, or the card kept failing).
 */
export type SubscriptionEvent =
  | { kind: "renewed"; subscriptionId: string; /** The gateway's id for this charge. */ chargeId: string; amountMinor: number; paidAt: string | null }
  | { kind: "ended"; subscriptionId: string };

/** A customer disputing a payment with their bank: opened, moving on, or decided. */
export interface DisputeEvent {
  disputeId: string;
  /** The gateway's id for the payment disputed, to find the page it was made on. */
  paymentRef: string;
  amountMinor: number;
  reason: string;
  status: string;
  /** Answer by then, or lose it. */
  dueBy: string | null;
  /** Decided, and which way. */
  outcome: "won" | "lost" | null;
}

/**
 * A callback or redirect, read but not yet believed: which payment it claims
 * to be about (to find whose key checks it), and the check itself.
 */
export interface Inbound {
  billId: string | null;
  /**
   * A report the gateway sends that is about nothing MySenam made (another
   * kind of event on the venue's account): answered OK and otherwise ignored,
   * so the gateway does not keep retrying it.
   */
  ignored?: boolean;
  /** About a subscription, not a page: which, so the account can be found by it. */
  subscriptionId?: string;
  /** Checked against the account: its signature, or the gateway's own API. */
  verify(account: GatewayAccount): Promise<PaymentResult | null>;
  /** For one about a subscription: what happened, once its signature checks out. */
  verifySubscription?(account: GatewayAccount): Promise<SubscriptionEvent | null>;
  /**
   * About a dispute, which names no page and no subscription: whose it is is
   * found by whose signing key it checks out under.
   */
  dispute?: boolean;
  verifyDispute?(account: GatewayAccount): Promise<DisputeEvent | null>;
}

/** One thing a venue types in to connect its account. */
export interface CredentialField {
  key: string;
  label: string;
  /** Sealed at rest and never shown back beyond its last four characters. */
  secret: boolean;
  help?: string;
}

export interface PaymentGateway {
  id: ProviderId;
  /** "Billplz" */
  name: string;
  /** How customers pay through it, in a few words. */
  methods: string;
  /** ISO 4217 codes it takes. */
  currencies: string[];
  fields: CredentialField[];
  /** Anything to do on the gateway's own side, for the settings form. */
  setup?: string;
  /** The same, as a phrase the settings form says in the staff language (lib/staff-text.ts). */
  setupPhrase?: StaffText;
  /**
   * The venue registers our callback address in the gateway's dashboard (it
   * is not sent with each payment), so the form shows it to copy.
   */
  webhook?: boolean;
  /**
   * Test or live, as the credentials themselves say (a Stripe key does), in
   * place of a sandbox switch the venue could set the wrong way.
   */
  sandboxFrom?(credentials: Record<string, string>): boolean;
  /**
   * One harmless call with these credentials, made when staff save them:
   * why they do not work, or null. So a wrong key shows up on the settings
   * page, not as a customer's failed payment.
   */
  testConnection?(account: GatewayAccount): Promise<string | null>;
  /** Why these credentials cannot be right, or null. Every field is filled in. */
  checkCredentials(credentials: Record<string, string>): string | null;
  createCheckout(account: GatewayAccount, request: CheckoutRequest): Promise<CheckoutPage>;
  /** The server-to-server report, from its raw body and headers. */
  readCallback(body: string, headers: Headers): Inbound;
  /** The browser coming back, or null when the address is not this gateway's. */
  readRedirect(query: URLSearchParams): Inbound | null;
  /**
   * Refund a payment through the gateway's API. Left out where the gateway
   * has none (Billplz): staff refund in its dashboard and mark it done.
   */
  refund?(account: GatewayAccount, request: RefundRequest): Promise<RefundResult>;
  /**
   * Where a refund the gateway accepted now stands: made, still going
   * through, failed (the money did not go back), or no clear answer.
   */
  refundStatus?(account: GatewayAccount, refundId: string): Promise<"succeeded" | "pending" | "failed" | "unknown">;
  /** It can charge again every period by itself (`CheckoutRequest.recurring`). */
  subscriptions?: boolean;
  /**
   * How soon and how late it can close a page by itself
   * (`CheckoutRequest.expiresInMinutes`): Stripe, 30 minutes to a day ahead.
   * Left out where a page stays payable until it is paid (Billplz).
   */
  pageExpiry?: { minMinutes: number; maxMinutes: number };
  /** Stop a subscription: why it could not be, or null. */
  cancelSubscription?(account: GatewayAccount, subscriptionId: string): Promise<string | null>;
  /** The platform's own account (venue fees, WhatsApp packs) from the environment. */
  platformAccount(env: NodeJS.ProcessEnv): GatewayAccount | null;
  /** The page a payment was made on, from the gateway's id for the payment (for a dispute). */
  billForPayment?(account: GatewayAccount, paymentRef: string): Promise<string | null>;
}
