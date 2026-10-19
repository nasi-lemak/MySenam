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

export type ProviderId = "billplz";

/** A venue's (or the platform's) account at one gateway, its secrets unsealed. */
export interface GatewayAccount {
  provider: ProviderId;
  sandbox: boolean;
  credentials: Record<string, string>;
}

export interface CheckoutRequest {
  /** In the install's currency, as prices are held: ringgit, not sen. */
  amount: number;
  name: string;
  email?: string | null;
  /** Digits with the country code, e.g. 60123456789. */
  mobile?: string | null;
  description: string;
  /** Where the gateway reports server to server. */
  callbackUrl: string;
  /** Where the customer's browser comes back to. */
  redirectUrl: string;
  /** Shown to the payer and on the venue's statement. */
  reference?: { label: string; value: string };
}

/** A hosted payment page: the gateway's id for it, and where to send the payer. */
export interface CheckoutPage {
  id: string;
  url: string;
}

/** What the gateway says happened to a payment page. */
export interface PaymentResult {
  billId: string;
  paid: boolean;
  paidAt: string | null;
}

/**
 * A callback or redirect, read but not yet believed: which payment it claims
 * to be about (to find whose key checks it), and the check itself.
 */
export interface Inbound {
  billId: string | null;
  verify(account: GatewayAccount): PaymentResult | null;
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
  /** Why these credentials cannot be right, or null. Every field is filled in. */
  checkCredentials(credentials: Record<string, string>): string | null;
  createCheckout(account: GatewayAccount, request: CheckoutRequest): Promise<CheckoutPage>;
  /** The server-to-server report, from its raw body and headers. */
  readCallback(body: string, headers: Headers): Inbound;
  /** The browser coming back, or null when the address is not this gateway's. */
  readRedirect(query: URLSearchParams): Inbound | null;
  /** The platform's own account (venue fees, WhatsApp packs) from the environment. */
  platformAccount(env: NodeJS.ProcessEnv): GatewayAccount | null;
}
