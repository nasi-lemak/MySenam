/**
 * What an accounting package must do for the live push (lib/accounting-push.ts; ADR 0041).
 *
 * The push never speaks to Xero directly: it speaks to this interface, so a second package (QuickBooks Online, which
 * has the same shape: OAuth 2.0, a sales invoice, a payment, a credit note, a chart of accounts and tax rates) is a
 * second adapter and nothing else changes. Only Xero is built (lib/xero.ts). SQL Account and AutoCount have no common
 * cloud API and stay on the export (lib/accounting.ts, `journalCsv`).
 *
 * Money crosses it in cents (whole numbers); the adapter alone turns them into the package's own representation.
 */

export interface Tokens {
  accessToken: string;
  refreshToken: string;
  /** Seconds the access token is good for. */
  expiresInSeconds: number;
  scopes: string;
}

/** A way to call the package for one organisation. */
export interface Session {
  accessToken: string;
  tenantId: string;
}

export interface Organisation {
  tenantId: string;
  connectionId: string;
  name: string;
}

export interface OrganisationDetails {
  name: string;
  /** The currency its books are kept in (ISO 4217). */
  currency: string;
  /** The package says this is its demo company, not a real business's books. Null where it does not say. */
  isDemo: boolean | null;
}

export interface ChartAccount {
  code: string;
  name: string;
  /** The package's own type (Xero: BANK, REVENUE, CURRLIAB …). */
  type: string;
  /** Its class: ASSET, LIABILITY, REVENUE, EXPENSE, EQUITY. */
  class: string;
  /** A payment can be recorded against it (a bank account, or one the package was told to allow). */
  acceptsPayments: boolean;
}

export interface ChartTaxRate {
  /** What a line is sent with. */
  type: string;
  name: string;
  /** Percent. */
  rate: number;
}

export interface DocumentLine {
  description: string;
  /** The line's amount with the tax inside it, in cents. */
  grossCents: number;
  taxCents: number;
  accountCode: string;
  taxType: string;
}

export interface Contact {
  name: string;
  /** Absent for a customer who has no account. */
  email: string | null;
}

export interface DocumentToSend {
  /** Unique in the package: the venue's and the document's number together. */
  number: string;
  /** Our own key for it (the `source_ref`), so a person looking in the package can find it here. */
  reference: string;
  /** The venue's calendar day, YYYY-MM-DD. */
  date: string;
  contact: Contact;
  lines: DocumentLine[];
}

export interface SentDocument {
  id: string;
  number: string;
  /** What the package holds for it, in cents, as it answered. */
  totalCents: number;
  taxCents: number;
}

export interface PaymentToSend {
  /** The invoice or credit note it settles. */
  documentId: string;
  accountCode: string;
  date: string;
  amountCents: number;
  reference: string;
}

export interface DocumentState {
  /** Nothing left to pay (an invoice), or nothing left to give back (a credit note). */
  settled: boolean;
}

export type ProviderErrorKind =
  /** Too many calls (HTTP 429): nothing is sent until `retryAfterSeconds` has passed. */
  | "rate_limited"
  /** The access was refused (HTTP 401, or a refresh token that no longer works): reconnect. */
  | "unauthorised"
  /** The package refused what was sent (a validation error): it will not work again unchanged. */
  | "rejected"
  /** The package already holds a document with this number. */
  | "duplicate"
  /** A 5xx, a timeout, no connection: try again later. */
  | "unavailable";

export class ProviderError extends Error {
  // Plain fields, not parameter properties: the verification script runs this file as it is (`node` strips types only).
  readonly kind: ProviderErrorKind;
  readonly retryAfterSeconds?: number;

  constructor(kind: ProviderErrorKind, message: string, retryAfterSeconds?: number) {
    super(message);
    this.name = "ProviderError";
    this.kind = kind;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export interface AccountingProvider {
  readonly id: "xero";
  /** Whether the install has registered its app with the package (client id, secret and redirect address). */
  configured(): boolean;
  authorizeUrl(input: { state: string; challenge: string }): string;
  exchangeCode(input: { code: string; verifier: string }): Promise<Tokens>;
  refresh(refreshToken: string): Promise<Tokens>;
  /** Give the grant up at the package (and its connection to the organisation, with `connectionId`). Never throws; says whether it worked. */
  revoke(input: { refreshToken: string; accessToken: string | null; connectionId: string | null }): Promise<boolean>;
  /** The organisations the grant that `accessToken` came from reaches. */
  organisations(accessToken: string): Promise<Organisation[]>;
  organisation(session: Session): Promise<OrganisationDetails>;
  chart(session: Session): Promise<{ accounts: ChartAccount[]; taxRates: ChartTaxRate[] }>;
  /** A sales invoice, authorised (approved), with the tax inside its lines. `key` makes a replay harmless. */
  createInvoice(session: Session, doc: DocumentToSend, key: string): Promise<SentDocument>;
  findInvoice(session: Session, number: string): Promise<(SentDocument & { reference: string }) | null>;
  invoiceState(session: Session, id: string): Promise<DocumentState>;
  /** A payment received against an invoice. */
  createPayment(session: Session, payment: PaymentToSend, key: string): Promise<{ id: string }>;
  /** A credit note, authorised, for what an invoice gave back. */
  createCreditNote(session: Session, doc: DocumentToSend, key: string): Promise<SentDocument>;
  findCreditNote(session: Session, number: string): Promise<(SentDocument & { reference: string }) | null>;
  creditNoteState(session: Session, id: string): Promise<DocumentState>;
  /** Money paid back against a credit note. */
  createRefund(session: Session, payment: PaymentToSend, key: string): Promise<{ id: string }>;
}
