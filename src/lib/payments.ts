import { getDb } from "./db";
import { BillResult, BillplzAccount, createBill } from "./billplz";
import { seal, unseal } from "./secrets";
import { findBooking, getCourt, getVenue } from "./store";
import { baseUrl } from "./outbox";
import { toWhatsAppNumber } from "./transports";
import { formatHour } from "./time";
import { Booking } from "./types";
import { platformAccount, settleInvoice } from "./billing";
import { venueBaseUrl } from "./storefront";

/**
 * Paying for a booking online, into the venue's own account.
 *
 * The gateway account belongs to the venue, not to the platform: a customer's
 * money goes straight to the business they booked with. Nothing here holds
 * money, owes it, or pays it out — which is the line between running booking
 * software and running a payments business.
 *
 * A booking does not wait on its payment. It stands the moment it is made, as
 * it always has, and paying online is one more way to settle it, beside the
 * counter, credit and passes. An abandoned payment page leaves a booking
 * unpaid, exactly as walking away from the counter would.
 */

// ------------------------------------------------------------ the account

interface AccountRow {
  venue_id: number;
  provider: string;
  api_key: string;
  collection_id: string;
  x_signature_key: string;
  sandbox: number;
  enabled: number;
  updated_at: string;
}

/** What staff see of a venue's gateway account. The keys never leave. */
export interface PaymentSettings {
  provider: "billplz";
  configured: boolean;
  enabled: boolean;
  sandbox: boolean;
  collectionId: string | null;
  /** The last four characters of the API key, to tell which one is in. */
  apiKeyEnding: string | null;
  /**
   * The keys are stored but cannot be read: this install was restored onto
   * another machine, or its secret changed. They need entering again.
   */
  unreadable: boolean;
  updatedAt: string | null;
}

function accountRow(venueId: number): AccountRow | undefined {
  return getDb().prepare("SELECT * FROM venue_payment_accounts WHERE venue_id = ?").get(venueId) as
    | AccountRow
    | undefined;
}

export function paymentSettings(venueId: number): PaymentSettings {
  const row = accountRow(venueId);
  if (!row)
    return {
      provider: "billplz",
      configured: false,
      enabled: false,
      sandbox: false,
      collectionId: null,
      apiKeyEnding: null,
      unreadable: false,
      updatedAt: null,
    };
  const apiKey = unseal(row.api_key);
  const signatureKey = unseal(row.x_signature_key);
  return {
    provider: "billplz",
    configured: true,
    enabled: row.enabled === 1,
    sandbox: row.sandbox === 1,
    collectionId: row.collection_id,
    apiKeyEnding: apiKey ? apiKey.slice(-4) : null,
    unreadable: apiKey === null || signatureKey === null,
    updatedAt: row.updated_at,
  };
}

/** The account to bill through, or null when the venue takes no payment online. */
export function venueAccount(venueId: number): BillplzAccount | null {
  const row = accountRow(venueId);
  if (!row || row.enabled !== 1) return null;
  const apiKey = unseal(row.api_key);
  const xSignatureKey = unseal(row.x_signature_key);
  if (!apiKey || !xSignatureKey) return null;
  return { apiKey, collectionId: row.collection_id, xSignatureKey, sandbox: row.sandbox === 1 };
}

export function takesPaymentOnline(venueId: number): boolean {
  return venueAccount(venueId) !== null;
}

export type SettingsResult = { ok: true; settings: PaymentSettings } | { ok: false; error: string };

/**
 * Set a venue's gateway account. The keys may be left out to keep the ones
 * already stored, so turning it off or switching to sandbox does not mean
 * finding them again.
 */
export function savePaymentSettings(
  venueId: number,
  input: {
    apiKey?: string;
    collectionId: string;
    xSignatureKey?: string;
    sandbox: boolean;
    enabled: boolean;
  }
): SettingsResult {
  if (!getVenue(venueId)) return { ok: false, error: "Venue not found." };
  const existing = accountRow(venueId);
  const apiKey = input.apiKey?.trim();
  const signatureKey = input.xSignatureKey?.trim();
  const collectionId = input.collectionId.trim();
  if (!/^[\w-]{3,40}$/.test(collectionId))
    return { ok: false, error: "That does not look like a Billplz collection ID." };
  if (!existing && (!apiKey || !signatureKey))
    return { ok: false, error: "The API key and the X Signature key are both needed the first time." };
  if (existing && (!unseal(existing.api_key) || !unseal(existing.x_signature_key)) && (!apiKey || !signatureKey))
    return {
      ok: false,
      error: "The stored keys cannot be read on this install. Enter both keys again.",
    };

  getDb()
    .prepare(`
      INSERT INTO venue_payment_accounts
        (venue_id, provider, api_key, collection_id, x_signature_key, sandbox, enabled, updated_at)
      VALUES (?, 'billplz', ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(venue_id) DO UPDATE SET
        api_key = excluded.api_key,
        collection_id = excluded.collection_id,
        x_signature_key = excluded.x_signature_key,
        sandbox = excluded.sandbox,
        enabled = excluded.enabled,
        updated_at = excluded.updated_at
    `)
    .run(
      venueId,
      apiKey ? seal(apiKey) : existing!.api_key,
      collectionId,
      signatureKey ? seal(signatureKey) : existing!.x_signature_key,
      input.sandbox ? 1 : 0,
      input.enabled ? 1 : 0
    );
  return { ok: true, settings: paymentSettings(venueId) };
}

export function removePaymentSettings(venueId: number): void {
  getDb().prepare("DELETE FROM venue_payment_accounts WHERE venue_id = ?").run(venueId);
}

// ------------------------------------------------------------ paying

interface PaymentRow {
  id: number;
  provider: string;
  bill_id: string;
  url: string;
  venue_id: number | null;
  amount: number;
  status: "pending" | "paid";
  payer_name: string | null;
  payer_phone: string | null;
  created_at: string;
  paid_at: string | null;
  refund_due: number;
  refunded: number;
  purpose: "booking" | "invoice";
  invoice_id: number | null;
}

export interface OnlinePayment {
  id: number;
  billId: string;
  url: string;
  venueId: number | null;
  amount: number;
  status: "pending" | "paid";
  payerName: string | null;
  payerPhone: string | null;
  createdAt: string;
  paidAt: string | null;
  /** Still to be refunded in the gateway, for bookings cancelled after paying. */
  refundOwed: number;
  refunded: number;
  bookingCodes: string[];
  /** A customer paying for bookings, or a venue paying its marketplace invoice. */
  purpose: "booking" | "invoice";
}

function toPayment(r: PaymentRow): OnlinePayment {
  const codes = getDb()
    .prepare(
      "SELECT b.code FROM online_payment_bookings pb JOIN bookings b ON b.id = pb.booking_id WHERE pb.payment_id = ? ORDER BY b.date, b.start_hour"
    )
    .all(r.id) as { code: string }[];
  return {
    id: r.id,
    billId: r.bill_id,
    url: r.url,
    venueId: r.venue_id,
    amount: r.amount,
    status: r.status,
    payerName: r.payer_name,
    payerPhone: r.payer_phone,
    createdAt: r.created_at,
    paidAt: r.paid_at,
    refundOwed: Math.max(0, r.refund_due - r.refunded),
    refunded: r.refunded,
    bookingCodes: codes.map((c) => c.code),
    purpose: r.purpose,
  };
}

export function paymentByBill(billId: string): OnlinePayment | null {
  const row = getDb().prepare("SELECT * FROM online_payments WHERE bill_id = ?").get(billId) as
    | PaymentRow
    | undefined;
  return row ? toPayment(row) : null;
}

export type StartResult =
  | { ok: true; url: string; amount: number; reused: boolean }
  | { ok: false; error: string; status: number };

/**
 * Send a customer to pay for one or more of their bookings.
 *
 * Every code must be theirs — the phone number proves it, as it does for
 * looking a booking up — and at the same venue, because the money goes to that
 * venue's account. Sessions already paid, or cancelled, are left out rather
 * than refused, so paying for a series after settling one week at the counter
 * charges for the rest.
 */
export async function startBookingPayment(input: {
  codes: string[];
  phone: string;
}): Promise<StartResult> {
  const codes = [...new Set(input.codes.map((c) => c.trim().toUpperCase()).filter(Boolean))];
  if (codes.length === 0) return { ok: false, error: "Which booking is this for?", status: 400 };

  const bookings: Booking[] = [];
  for (const code of codes) {
    const booking = findBooking(code, input.phone);
    if (!booking)
      return { ok: false, error: "Booking not found. Check the code and phone number.", status: 404 };
    bookings.push(booking);
  }

  const venueIds = new Set(bookings.map((b) => getCourt(b.courtId)?.venueId));
  if (venueIds.size !== 1)
    return { ok: false, error: "Bookings at different venues are paid separately.", status: 400 };
  const venueId = [...venueIds][0]!;
  const venue = getVenue(venueId)!;
  const account = venueAccount(venueId);
  if (!account)
    return { ok: false, error: `${venue.name} does not take payment online.`, status: 409 };

  const due = bookings.filter((b) => b.status === "confirmed" && b.paymentStatus === "unpaid");
  if (due.length === 0)
    return { ok: false, error: "There is nothing left to pay on this booking.", status: 409 };
  const amount = Math.round(due.reduce((sum, b) => sum + b.totalPrice, 0) * 100) / 100;
  if (amount <= 0)
    return { ok: false, error: "There is nothing left to pay on this booking.", status: 409 };

  // Pressing the button twice, or coming back to it, should not make a second
  // bill for the same thing.
  const ids = due.map((b) => b.id).sort((a, b) => a - b);
  const reusable = pendingPaymentFor(ids, amount);
  if (reusable) return { ok: true, url: reusable.url, amount, reused: true };

  const first = due[0];
  const court = getCourt(first.courtId)!;
  const what =
    due.length === 1
      ? `${court.name}, ${first.date} ${formatHour(first.startHour)}-${formatHour(first.endHour)}`
      : `${due.length} sessions, ${court.name}, from ${first.date}`;

  let bill;
  try {
    bill = await createBill(account, {
      amount,
      name: first.name,
      email: first.email,
      mobile: first.phone ? toWhatsAppNumber(first.phone) : null,
      description: `${venue.name}: ${what} (${first.seriesCode && due.length > 1 ? first.seriesCode : first.code})`,
      callbackUrl: `${baseUrl()}/api/payments/billplz/callback`,
      // The customer comes back to the site they paid on; Billplz reports to ours.
      redirectUrl: `${venueBaseUrl(venueId)}/payments/return`,
      reference: { label: "Booking", value: due.map((b) => b.code).join(" ") },
    });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "The payment page could not be opened.",
      status: 502,
    };
  }

  const db = getDb();
  db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO online_payments (provider, bill_id, url, venue_id, amount, payer_name, payer_phone)
         VALUES ('billplz', ?, ?, ?, ?, ?, ?)`
      )
      .run(bill.id, bill.url, venueId, amount, first.name, first.phone);
    const link = db.prepare(
      "INSERT INTO online_payment_bookings (payment_id, booking_id) VALUES (?, ?)"
    );
    for (const id of ids) link.run(info.lastInsertRowid, id);
  })();
  return { ok: true, url: bill.url, amount, reused: false };
}

/** A bill already made for exactly these bookings, still unpaid and recent. */
function pendingPaymentFor(bookingIds: number[], amount: number): PaymentRow | null {
  const candidates = getDb()
    .prepare(`
      SELECT p.* FROM online_payments p
       WHERE p.status = 'pending' AND p.purpose = 'booking' AND p.amount = ?
         AND p.created_at > datetime('now', '-1 day')
         AND p.id IN (SELECT payment_id FROM online_payment_bookings WHERE booking_id = ?)
       ORDER BY p.id DESC
    `)
    .all(amount, bookingIds[0]) as PaymentRow[];
  for (const row of candidates) {
    const linked = (
      getDb()
        .prepare("SELECT booking_id FROM online_payment_bookings WHERE payment_id = ? ORDER BY booking_id")
        .all(row.id) as { booking_id: number }[]
    ).map((r) => r.booking_id);
    if (linked.length === bookingIds.length && linked.every((id, i) => id === bookingIds[i]))
      return row;
  }
  return null;
}

/** Whose key checks a callback or redirect for this bill. */
export function accountForBill(billId: string): BillplzAccount | null {
  const row = getDb()
    .prepare("SELECT venue_id, purpose FROM online_payments WHERE bill_id = ?")
    .get(billId) as { venue_id: number | null; purpose: string } | undefined;
  if (!row) return null;
  // A venue's fee was billed to the platform's account, and is checked with its key.
  if (row.purpose === "invoice") return platformAccount();
  if (row.venue_id === null) return null;
  // Checked even when the venue has since switched online payment off: a bill
  // it already sent can still be paid, and that money still arrived.
  const account = accountRow(row.venue_id);
  if (!account) return null;
  const apiKey = unseal(account.api_key);
  const xSignatureKey = unseal(account.x_signature_key);
  if (!apiKey || !xSignatureKey) return null;
  return { apiKey, collectionId: account.collection_id, xSignatureKey, sandbox: account.sandbox === 1 };
}

export interface Settled {
  payment: OnlinePayment;
  /** The bookings this payment settled just now. */
  newlyPaid: Booking[];
}

/**
 * Record what the gateway said about a bill, once.
 *
 * Billplz tells us by callback and by redirect, in either order, and retries a
 * callback it thinks failed — so this is safe to call any number of times. A
 * booking cancelled, or paid some other way, before the money arrived is not
 * marked paid twice: the amount is written down as owed back instead.
 */
export function settleBill(result: BillResult): Settled | null {
  const db = getDb();
  const row = db.prepare("SELECT * FROM online_payments WHERE bill_id = ?").get(result.billId) as
    | PaymentRow
    | undefined;
  if (!row) return null;
  if (!result.paid || row.status === "paid") return { payment: toPayment(row), newlyPaid: [] };

  if (row.purpose === "invoice") {
    db.transaction(() => {
      const claimed = db
        .prepare("UPDATE online_payments SET status = 'paid', paid_at = datetime('now') WHERE id = ? AND status = 'pending'")
        .run(row.id);
      if (claimed.changes === 1 && row.invoice_id !== null) settleInvoice(row.invoice_id);
    })();
    const fresh = db.prepare("SELECT * FROM online_payments WHERE id = ?").get(row.id) as PaymentRow;
    return { payment: toPayment(fresh), newlyPaid: [] };
  }

  const paidAt = new Date().toISOString();
  const newlyPaid: number[] = [];
  db.transaction(() => {
    const claimed = db
      .prepare("UPDATE online_payments SET status = 'paid', paid_at = ? WHERE id = ? AND status = 'pending'")
      .run(paidAt, row.id);
    if (claimed.changes === 0) return;

    const linked = db
      .prepare(`
        SELECT b.id, b.status, b.payment_status, b.total_price
          FROM online_payment_bookings pb JOIN bookings b ON b.id = pb.booking_id
         WHERE pb.payment_id = ?
      `)
      .all(row.id) as { id: number; status: string; payment_status: string; total_price: number }[];
    let owed = 0;
    for (const b of linked) {
      if (b.status === "confirmed" && b.payment_status === "unpaid") {
        db.prepare(
          "UPDATE bookings SET payment_status = 'paid', paid_at = ?, paid_via = 'online' WHERE id = ?"
        ).run(paidAt, b.id);
        newlyPaid.push(b.id);
      } else {
        owed += b.total_price;
      }
    }
    if (owed > 0)
      db.prepare("UPDATE online_payments SET refund_due = refund_due + ? WHERE id = ?").run(owed, row.id);
  })();

  const fresh = db.prepare("SELECT * FROM online_payments WHERE id = ?").get(row.id) as PaymentRow;
  const bookings = newlyPaid.map((id) => bookingById(id)).filter((b): b is Booking => b !== null);
  return { payment: toPayment(fresh), newlyPaid: bookings };
}

function bookingById(id: number): Booking | null {
  const row = getDb().prepare("SELECT code, phone FROM bookings WHERE id = ?").get(id) as
    | { code: string; phone: string }
    | undefined;
  return row ? findBooking(row.code, row.phone) : null;
}

// ------------------------------------------------------------ for staff

export function listOnlinePayments(venueId: number, limit = 50): OnlinePayment[] {
  return (
    getDb()
      .prepare(
        "SELECT * FROM online_payments WHERE venue_id = ? AND purpose = 'booking' ORDER BY id DESC LIMIT ?"
      )
      .all(venueId, limit) as PaymentRow[]
  ).map(toPayment);
}

/** Payments with money still to go back, oldest first. */
export function refundsOwed(venueId: number): OnlinePayment[] {
  return (
    getDb()
      .prepare(
        "SELECT * FROM online_payments WHERE venue_id = ? AND purpose = 'booking' AND refund_due > refunded ORDER BY id"
      )
      .all(venueId) as PaymentRow[]
  ).map(toPayment);
}

/** Staff have made the refund in the gateway. */
export function markRefunded(
  paymentId: number,
  venueId: number
): { ok: true; payment: OnlinePayment } | { ok: false; error: string } {
  const db = getDb();
  const done = db
    .prepare(
      "UPDATE online_payments SET refunded = refund_due WHERE id = ? AND venue_id = ? AND refund_due > refunded"
    )
    .run(paymentId, venueId);
  if (done.changes === 0) return { ok: false, error: "Nothing is owed back on that payment." };
  return {
    ok: true,
    payment: toPayment(db.prepare("SELECT * FROM online_payments WHERE id = ?").get(paymentId) as PaymentRow),
  };
}

