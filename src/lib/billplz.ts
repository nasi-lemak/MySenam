import crypto from "crypto";

/**
 * Billplz: FPX online banking and cards, the way most Malaysian small
 * businesses take money online.
 *
 * Only what MySenam needs is here — create a bill, and check that a callback or
 * a redirect really came from Billplz. A bill is a hosted payment page: the
 * customer is sent to its URL, pays there, and Billplz tells us twice — once
 * server to server (the callback, which is what counts) and once by sending
 * the customer's browser back with the result (the redirect, which may arrive
 * first, last, or never).
 */

export interface BillplzAccount {
  apiKey: string;
  collectionId: string;
  xSignatureKey: string;
  sandbox: boolean;
}

export function billplzHost(sandbox: boolean): string {
  return sandbox ? "https://www.billplz-sandbox.com" : "https://www.billplz.com";
}

export interface NewBill {
  /** Ringgit, as a booking holds it. Sent to Billplz in sen. */
  amount: number;
  name: string;
  email?: string | null;
  /** Digits with the country code, e.g. 60123456789 or 6591234567. */
  mobile?: string | null;
  description: string;
  callbackUrl: string;
  redirectUrl: string;
  reference?: { label: string; value: string };
}

export interface Bill {
  id: string;
  url: string;
}

/** Ringgit to sen, the smallest unit Billplz counts in. */
export function toSen(amount: number): number {
  return Math.round(amount * 100);
}

export async function createBill(account: BillplzAccount, bill: NewBill): Promise<Bill> {
  const form = new URLSearchParams({
    collection_id: account.collectionId,
    name: bill.name.slice(0, 255),
    amount: String(toSen(bill.amount)),
    description: bill.description.slice(0, 200),
    callback_url: bill.callbackUrl,
    redirect_url: bill.redirectUrl,
  });
  if (bill.email) form.set("email", bill.email);
  if (bill.mobile) form.set("mobile", bill.mobile);
  if (!bill.email && !bill.mobile) throw new Error("A bill needs an email or a mobile number.");
  if (bill.reference) {
    form.set("reference_1_label", bill.reference.label.slice(0, 20));
    form.set("reference_1", bill.reference.value.slice(0, 120));
  }

  const res = await fetch(`${billplzHost(account.sandbox)}/api/v3/bills`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${account.apiKey}:`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
    signal: AbortSignal.timeout(20_000),
  });
  const data = (await res.json().catch(() => null)) as
    | { id?: string; url?: string; error?: { message?: string | string[] } }
    | null;
  if (!res.ok || !data?.id || !data.url) {
    const why = data?.error?.message;
    throw new Error(
      `Billplz refused the bill (${res.status})${why ? `: ${Array.isArray(why) ? why.join("; ") : why}` : ""}`
    );
  }
  return { id: data.id, url: data.url };
}

/**
 * Billplz's X-Signature over a set of fields.
 *
 * Each field becomes key-then-value with nothing between, the strings are
 * sorted without regard to case, joined with `|`, and signed with HMAC-SHA256
 * under the account's X Signature key.
 */
export function xSignature(fields: Record<string, string>, signatureKey: string): string {
  const source = Object.entries(fields)
    .filter(([k]) => k !== "x_signature")
    .map(([k, v]) => `${k}${v}`)
    .sort((a, b) => {
      const x = a.toLowerCase();
      const y = b.toLowerCase();
      return x < y ? -1 : x > y ? 1 : 0;
    })
    .join("|");
  return crypto.createHmac("sha256", signatureKey).update(source).digest("hex");
}

function sameSignature(given: string | undefined, expected: string): boolean {
  if (!given || given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

export interface BillResult {
  billId: string;
  paid: boolean;
  paidAt: string | null;
  /**
   * What Billplz says the bill was for (`amount`) and took (`paid_amount`), in sen, and the collection it is in
   * (`collection_id`): only on the callback and the bill itself, never on the redirect, which carries the id, the paid
   * flag, the time and the signature and nothing else. Null where the field was not there or not a whole number.
   */
  billedMinor?: number | null;
  receivedMinor?: number | null;
  collectionId?: string | null;
}

/** A whole number of sen, or null. */
function sen(value: string | number | undefined | null): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) && value >= 0 ? value : null;
  return typeof value === "string" && /^\d{1,12}$/.test(value) ? Number(value) : null;
}

/** The server-to-server callback: its form fields, checked. Null if forged. */
export function verifyCallback(
  fields: Record<string, string>,
  signatureKey: string
): BillResult | null {
  if (!fields.id || !sameSignature(fields.x_signature, xSignature(fields, signatureKey)))
    return null;
  return {
    billId: fields.id,
    // Billplz's `state` is due, paid or deleted: a report that says paid under any other state is not believed.
    paid: fields.paid === "true" && (fields.state === undefined || fields.state === "paid"),
    paidAt: fields.paid_at || null,
    billedMinor: sen(fields.amount),
    receivedMinor: sen(fields.paid_amount),
    collectionId: fields.collection_id || null,
  };
}

/**
 * The browser redirect: `billplz[id]`, `billplz[paid]`… in the query string.
 * Signed the same way, with each key written `billplz` + the bare name.
 */
export function verifyRedirect(
  query: URLSearchParams,
  signatureKey: string
): BillResult | null {
  const fields: Record<string, string> = {};
  let given: string | undefined;
  for (const [k, v] of query) {
    const m = k.match(/^billplz\[(\w+)\]$/);
    if (!m) continue;
    if (m[1] === "x_signature") given = v;
    else fields[`billplz${m[1]}`] = v;
  }
  const id = fields.billplzid;
  if (!id || !sameSignature(given, xSignature(fields, signatureKey))) return null;
  return {
    billId: id,
    paid: fields.billplzpaid === "true",
    paidAt: fields.billplzpaid_at || null,
  };
}

/** Which bill a redirect is about, before it is checked — to find whose key checks it. */
export function redirectBillId(query: URLSearchParams): string | null {
  return query.get("billplz[id]");
}

/**
 * The bill itself, from Billplz's API (`GET /api/v3/bills/:id`, the account's secret key): what the redirect cannot say.
 * Null when Billplz does not answer with a bill of that id; throws when it cannot be reached (the caller leaves the
 * outcome unknown and the callback decides). Documented fields only: `paid`, `state` (due, paid or deleted), `amount`,
 * `paid_amount` and `collection_id`, as docs/integrations/payment-gateways.md records; not yet exercised against
 * Billplz's sandbox.
 */
export async function fetchBill(account: BillplzAccount, billId: string): Promise<BillResult | null> {
  const res = await fetch(`${billplzHost(account.sandbox)}/api/v3/bills/${encodeURIComponent(billId)}`, {
    headers: { Authorization: `Basic ${Buffer.from(`${account.apiKey}:`).toString("base64")}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Billplz answered ${res.status} for the bill.`);
  const data = (await res.json().catch(() => null)) as
    | { id?: string; paid?: boolean; state?: string; amount?: number | string; paid_amount?: number | string; collection_id?: string; paid_at?: string | null }
    | null;
  if (!data || data.id !== billId) return null;
  return {
    billId: data.id,
    paid: data.paid === true && data.state === "paid",
    paidAt: data.paid_at || null,
    billedMinor: sen(data.amount),
    receivedMinor: sen(data.paid_amount),
    collectionId: data.collection_id || null,
  };
}
