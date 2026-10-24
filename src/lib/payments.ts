import { isOpen, venueIsOpen } from "./listing";
import { hoursOf } from "./interval";
import { creditScope, isMarketplace } from "./mode";
import { getDb, withTransaction } from "./db";
import {
  gatewayFor,
  offeredGateways,
  openCheckout,
  platformAccount,
  type CredentialField,
  type GatewayAccount,
  type PaymentGateway,
  type PaymentResult,
  type ProviderId,
} from "./gateways";
import type { DisputeEvent, SubscriptionEvent } from "./gateways/types";
import { tellOwners, tellVenueStaff } from "./owner-alerts";
import { siteName } from "./site";
import { seal, unseal } from "./secrets";
import { findBooking, getCourt, getVenue, membershipById, sellMembership } from "./store";
import { joinTerms } from "./membership-plans";
import { accessSettings, accountPhone } from "./access";
import { toWhatsAppNumber } from "./transports";
import { baseUrl } from "./outbox";
import { formatHour } from "./time";
import { Booking, MAX_TOP_UP } from "./types";
import { settleInvoice } from "./billing";
import { settlePack } from "./whatsapp-credit";
import { notifyBookingConfirmed, notifyPaid } from "./notify";
import { extendHolds, holdPolicy, PAYMENT_PAGE_MINUTES } from "./holds";
import { venueBaseUrl } from "./storefront";
import { errorText, isLocale, translator, type ErrorCode } from "./i18n";
import { money, region, isAmount, roundMoney } from "./region";
import { creditReceipt, documentFor, entrySale, issueReceipt, keepBookingReceipt, paidVia, placeSale, type Line } from "./documents";
import { venueTax } from "./tax";
import { cancelPolicy, struckOut, type OnlineRefunds } from "./cancel-policy";
import { activateVoucher, pendingVoucher, sendVoucher, type Voucher, type VoucherInput } from "./vouchers";

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
  /** JSON: each field the gateway asks for, its secrets sealed one by one. */
  credentials: string;
  sandbox: number;
  enabled: number;
  updated_at: string;
}

/** A gateway a venue can connect, as the settings form shows it. */
export interface GatewayChoice {
  id: ProviderId;
  name: string;
  methods: string;
  fields: CredentialField[];
  setup?: string;
  /** Where the gateway should send its reports, when the venue sets that up itself. */
  callbackUrl?: string;
  /** Test or live follows the key, so there is no sandbox switch to set. */
  sandboxFromKey: boolean;
}

/** What staff see of a venue's gateway account. The keys never leave. */
export interface PaymentSettings {
  provider: ProviderId;
  providerName: string;
  /** The gateways this install offers, to connect or switch to. */
  choices: GatewayChoice[];
  configured: boolean;
  enabled: boolean;
  sandbox: boolean;
  /**
   * Each field as it may be shown: a plain one in full, a secret by its last
   * four characters (to tell which key is in), null when not set.
   */
  details: Record<string, string | null>;
  /**
   * The keys are stored but cannot be read: this install was restored onto
   * another machine, or its secret changed. They need entering again.
   */
  unreadable: boolean;
  updatedAt: string | null;
}

async function accountRow(venueId: number): Promise<AccountRow | undefined> {
  return await getDb().prepare("SELECT * FROM venue_payment_accounts WHERE venue_id = ?").get(venueId) as
    | AccountRow
    | undefined;
}

function storedFields(row: AccountRow): Record<string, string> {
  try {
    const parsed = JSON.parse(row.credentials) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).filter((e): e is [string, string] => typeof e[1] === "string"));
  } catch {
    return {};
  }
}

/** The row's credentials in the clear, or null if any is missing or cannot be unsealed here. */
function readAccount(row: AccountRow): GatewayAccount | null {
  const gateway = gatewayFor(row.provider);
  if (!gateway) return null;
  const stored = storedFields(row);
  const credentials: Record<string, string> = {};
  for (const f of gateway.fields) {
    const value = stored[f.key] === undefined ? null : f.secret ? unseal(stored[f.key]) : stored[f.key];
    if (!value) return null;
    credentials[f.key] = value;
  }
  return { provider: gateway.id, sandbox: row.sandbox === 1, credentials };
}

const choice = (g: PaymentGateway): GatewayChoice => ({
  id: g.id,
  name: g.name,
  methods: g.methods,
  fields: g.fields,
  ...(g.setup ? { setup: g.setup } : {}),
  ...(g.webhook ? { callbackUrl: `${baseUrl()}/api/payments/${g.id}/callback` } : {}),
  sandboxFromKey: Boolean(g.sandboxFrom),
});

export async function paymentSettings(venueId: number): Promise<PaymentSettings> {
  const row = await accountRow(venueId);
  const choices = offeredGateways().map(choice);
  const gateway = (row && gatewayFor(row.provider)) || offeredGateways()[0];
  if (!row)
    return {
      provider: gateway.id,
      providerName: gateway.name,
      choices,
      configured: false,
      enabled: false,
      sandbox: false,
      details: Object.fromEntries(gateway.fields.map((f) => [f.key, null])),
      unreadable: false,
      updatedAt: null,
    };
  const stored = storedFields(row);
  const details: Record<string, string | null> = {};
  let unreadable = false;
  for (const f of gateway.fields) {
    if (stored[f.key] === undefined) {
      details[f.key] = null;
      continue;
    }
    if (!f.secret) {
      details[f.key] = stored[f.key];
      continue;
    }
    const value = unseal(stored[f.key]);
    if (value === null) unreadable = true;
    details[f.key] = value ? value.slice(-4) : null;
  }
  return {
    provider: gateway.id,
    providerName: gateway.name,
    // A venue on a gateway this install no longer offers still sees it.
    choices: choices.some((c) => c.id === gateway.id) ? choices : [...choices, choice(gateway)],
    configured: true,
    enabled: row.enabled === 1,
    sandbox: row.sandbox === 1,
    details,
    unreadable,
    updatedAt: row.updated_at,
  };
}

/** The account to take payment through, or null when the venue takes no payment online. */
export async function venueAccount(venueId: number): Promise<GatewayAccount | null> {
  const row = await accountRow(venueId);
  if (!row || row.enabled !== 1) return null;
  return readAccount(row);
}

export async function takesPaymentOnline(venueId: number): Promise<boolean> {
  return (await venueAccount(venueId)) !== null && (await venueIsOpen(venueId));
}

export type SettingsResult = { ok: true; settings: PaymentSettings } | { ok: false; error: string };

/**
 * Connect a venue's gateway account. A field may be left out to keep the one
 * already stored, so turning it off or switching to sandbox does not mean
 * finding the keys again; switching gateway means entering the new one's.
 * Billplz's three fields may also be given at the top level, as they were
 * before there was a choice of gateway.
 */
export async function savePaymentSettings(
  venueId: number,
  input: {
    provider?: string;
    credentials?: Record<string, unknown>;
    apiKey?: string;
    collectionId?: string;
    xSignatureKey?: string;
    sandbox: boolean;
    enabled: boolean;
    /** Try the credentials against the gateway before saving them (the settings form does). */
    check?: boolean;
  }
): Promise<SettingsResult> {
  if (!await getVenue(venueId)) return { ok: false, error: "Venue not found." };
  const existing = await accountRow(venueId);
  const gateway = gatewayFor(input.provider ?? existing?.provider ?? offeredGateways()[0].id);
  if (!gateway || (!offeredGateways().includes(gateway) && gateway.id !== existing?.provider))
    return { ok: false, error: "That payment gateway is not offered here." };

  const given: Record<string, unknown> = { ...(input.credentials ?? {}) };
  if (gateway.id === "billplz")
    for (const key of ["apiKey", "collectionId", "xSignatureKey"] as const)
      if (input[key] !== undefined && given[key] === undefined) given[key] = input[key];

  // Kept fields count only when they belong to the same gateway.
  const stored = existing && existing.provider === gateway.id ? storedFields(existing) : {};
  const plain: Record<string, string> = {};
  const sealed: Record<string, string> = {};
  for (const f of gateway.fields) {
    const typed = typeof given[f.key] === "string" ? (given[f.key] as string).trim() : "";
    if (typed !== "") {
      if (typed.length > 200) return { ok: false, error: `${f.label} is too long.` };
      plain[f.key] = typed;
      sealed[f.key] = f.secret ? seal(typed) : typed;
      continue;
    }
    if (stored[f.key] === undefined)
      return { ok: false, error: `${f.label} is needed${existing?.provider === gateway.id ? "" : " the first time"}.` };
    const kept = f.secret ? unseal(stored[f.key]) : stored[f.key];
    if (!kept)
      return { ok: false, error: "The stored keys cannot be read on this install. Enter them again." };
    plain[f.key] = kept;
    sealed[f.key] = stored[f.key];
  }
  const wrong = gateway.checkCredentials(plain);
  if (wrong) return { ok: false, error: wrong };
  const sandbox = gateway.sandboxFrom ? gateway.sandboxFrom(plain) : input.sandbox;
  if (input.check && input.enabled && gateway.testConnection) {
    const refused = await gateway.testConnection({ provider: gateway.id, sandbox, credentials: plain });
    if (refused) return { ok: false, error: refused };
  }

  await getDb()
    .prepare(`
      INSERT INTO venue_payment_accounts (venue_id, provider, credentials, sandbox, enabled, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(venue_id) DO UPDATE SET
        provider = excluded.provider,
        credentials = excluded.credentials,
        sandbox = excluded.sandbox,
        enabled = excluded.enabled,
        updated_at = excluded.updated_at
    `)
    .run(venueId, gateway.id, JSON.stringify(sealed), sandbox ? 1 : 0, input.enabled ? 1 : 0);
  return { ok: true, settings: await paymentSettings(venueId) };
}

export async function removePaymentSettings(venueId: number): Promise<void> {
  await getDb().prepare("DELETE FROM venue_payment_accounts WHERE venue_id = ?").run(venueId);
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
  /** 1: a page for the venue's deposit only, not the whole price. */
  deposit?: number;
  purpose: "booking" | "invoice" | "share" | "entry" | "league" | "pack" | "topup" | "membership" | "voucher" | "split";
  invoice_id: number | null;
  split_id?: number | null;
  game_player_id: number | null;
  tournament_entry_id: number | null;
  league_place_id: number | null;
  pack_id: number | null;
  topup_user_id?: number | null;
  voucher_id?: number | null;
  member_user_id?: number | null;
  membership_plan_id?: number | null;
  membership_id?: number | null;
  auto_renew?: number;
  subscription_id?: string | null;
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
  /** The gateway it was paid through: "Stripe". */
  providerName: string;
  /** Still to be refunded in the gateway, for bookings cancelled after paying. */
  refundOwed: number;
  refunded: number;
  /** The gateway refunds through its API, with one click; otherwise staff refund in its dashboard. */
  refundsByApi: boolean;
  bookingCodes: string[];
  /** A customer paying for bookings, a player paying their share of somebody's, or a venue its invoice. */
  purpose: "booking" | "invoice" | "share" | "entry" | "league" | "pack" | "topup" | "membership" | "voucher" | "split";
  /** The membership a paid membership fee made. */
  membership?: { code: string; venueId: number; venueName: string; startsOn: string; expiresOn: string };
  /** On a refund owed (`refundsOwed`): since when, the date the customer was told, and whether that has passed. */
  owed?: RefundClock;
}

/** How long a refund has been owed, against the days the venue tells customers it takes. */
export interface RefundClock {
  since: string;
  /** The last day of the venue's promise (`refund_within_days`), YYYY-MM-DD. */
  dueBy: string;
  days: number;
  overdue: boolean;
}

const DAY_MS = 86_400_000;

/** `since` is a stored UTC `YYYY-MM-DD HH:MM:SS`; null for one not yet noted, which is owed from now. */
export function refundClock(since: string | null, withinDays: number, now = new Date()): RefundClock {
  const start = since ? new Date(`${since.replace(" ", "T")}Z`) : now;
  const due = new Date(start.getTime() + withinDays * DAY_MS);
  return {
    since: start.toISOString().slice(0, 19).replace("T", " "),
    dueBy: due.toISOString().slice(0, 10),
    days: Math.max(0, Math.floor((now.getTime() - start.getTime()) / DAY_MS)),
    overdue: now.getTime() > due.getTime(),
  };
}

async function toPayment(r: PaymentRow): Promise<OnlinePayment> {
  const codes = await getDb()
    .prepare(
      "SELECT b.code FROM online_payment_bookings pb JOIN bookings b ON b.id = pb.booking_id WHERE pb.payment_id = ? ORDER BY b.date, b.start_min"
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
    providerName: gatewayFor(r.provider)?.name ?? r.provider,
    refundOwed: Math.max(0, roundMoney(r.refund_due - r.refunded)),
    refunded: r.refunded,
    refundsByApi: typeof gatewayFor(r.provider)?.refund === "function",
    bookingCodes: codes.map((c) => c.code),
    purpose: r.purpose,
    ...(r.membership_id ? { membership: await membershipSummary(r.membership_id) } : {}),
  };
}

async function membershipSummary(id: number): Promise<OnlinePayment["membership"]> {
  const m = await membershipById(id);
  return m ? { code: m.code, venueId: m.venueId, venueName: m.venueName, startsOn: m.startsOn, expiresOn: m.expiresOn } : undefined;
}

export async function paymentByBill(billId: string): Promise<OnlinePayment | null> {
  const row = await getDb().prepare("SELECT * FROM online_payments WHERE bill_id = ?").get(billId) as
    | PaymentRow
    | undefined;
  return row ? await toPayment(row) : null;
}

export type StartResult =
  | { ok: true; url: string; amount: number; reused: boolean; /** Only the venue's deposit. */ deposit?: boolean }
  | { ok: false; error: string; status: number; code?: ErrorCode; vars?: Record<string, string | number> };

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
  /** Only the venue's deposit now, where it takes one (lib/holds.ts): the rest at the counter. */
  deposit?: boolean;
}): Promise<StartResult> {
  const codes = [...new Set(input.codes.map((c) => c.trim().toUpperCase()).filter(Boolean))];
  if (codes.length === 0) return { ok: false, error: "Which booking is this for?", status: 400 };

  const bookings: Booking[] = [];
  for (const code of codes) {
    const booking = await findBooking(code, input.phone);
    if (!booking)
      return { ok: false, error: "Booking not found. Check the code and phone number.", status: 404 };
    bookings.push(booking);
  }

  const venueIds = new Set<number | undefined>();
  for (const b of bookings) venueIds.add((await getCourt(b.courtId))?.venueId);
  if (venueIds.size !== 1)
    return { ok: false, error: "Bookings at different venues are paid separately.", status: 400 };
  const venueId = [...venueIds][0]!;
  const venue = (await getVenue(venueId))!;
  // Not to a draft, nor a venue off the marketplace (lib/listing.ts).
  if (!isOpen(venue))
    return { ok: false, error: `${venue.name} is not taking payment online at the moment.`, status: 409 };
  const account = await venueAccount(venueId);
  if (!account)
    return { ok: false, error: `${venue.name} does not take payment online.`, status: 409 };

  const due = bookings.filter((b) => b.status === "confirmed" && b.paymentStatus === "unpaid");
  if (due.length === 0)
    return { ok: false, error: "There is nothing left to pay on this booking.", status: 409 };
  // Less whatever other players in an open game have paid towards it.
  const amount = Math.round(due.reduce((sum, b) => sum + b.totalPrice - b.sharesPaid, 0) * 100) / 100;
  if (amount <= 0)
    return { ok: false, error: "There is nothing left to pay on this booking.", status: 409 };

  // A deposit, where the venue takes one and none is paid on these yet: that share of what is due now,
  // split across the bookings in proportion, the last taking the rounding.
  // Not for a number past its strikes here, which pays in full to book (lib/cancel-policy.ts).
  const depositPercent =
    input.deposit && !(await struckOut(venueId, bookings[0].phone)).out ? (await holdPolicy(venueId)).depositPercent : null;
  const asDeposit = depositPercent !== null && due.every((b) => (b.depositPaid ?? 0) === 0);
  const owing = (b: Booking) => Math.round((b.totalPrice - b.sharesPaid) * 100) / 100;
  // Rounded exactly as the page showing it does (components/PayOnline.tsx).
  const charge = asDeposit ? Math.round(amount * depositPercent!) / 100 : amount;
  const billedFor = new Map<number, number>();
  let allotted = 0;
  due.forEach((b, i) => {
    const share = !asDeposit ? owing(b) : i === due.length - 1 ? Math.round((charge - allotted) * 100) / 100 : Math.round(owing(b) * depositPercent! / 100 * 100) / 100;
    allotted += share;
    billedFor.set(b.id, share);
  });

  // Pressing the button twice, or coming back to it, should not make a second
  // bill for the same thing.
  const ids = due.map((b) => b.id).sort((a, b) => a - b);
  // A held booking stays held while they are on the payment page, and the
  // page closes when the hold does; one opened earlier is used again only
  // while it has time left.
  const held = due.some((b) => b.holdUntil);
  await extendHolds(ids);
  const reusable = await pendingPaymentFor(ids, charge, held ? PAYMENT_PAGE_MINUTES - 5 : 23 * 60, asDeposit);
  if (reusable) return { ok: true, url: reusable.url, amount: charge, reused: true };

  const first = due[0];
  const court = (await getCourt(first.courtId))!;
  const what =
    due.length === 1
      ? `${court.name}, ${first.date} ${formatHour(first.startHour)}-${formatHour(first.endHour)}`
      : `${due.length} sessions, ${court.name}, from ${first.date}`;

  let bill;
  try {
    bill = await openCheckout(account, {
      amount: charge,
      name: first.name,
      email: first.email,
      mobile: first.phone ? toWhatsAppNumber(first.phone) : null,
      description: `${venue.name}: ${asDeposit ? `deposit, ${what}` : what} (${first.seriesCode && due.length > 1 ? first.seriesCode : first.code})`,
      // The customer comes back to the site they paid on; the gateway reports to ours.
      redirectUrl: `${await venueBaseUrl(venueId)}/payments/return`,
      reference: { label: "Booking", value: due.map((b) => b.code).join(" ") },
      ...(held ? { expiresInMinutes: PAYMENT_PAGE_MINUTES } : {}),
    });
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "The payment page could not be opened.",
      status: 502,
    };
  }

  const db = getDb();
  await db.transaction(async () => {
    const info = await db
      .prepare(
        `INSERT INTO online_payments (provider, bill_id, url, venue_id, amount, payer_name, payer_phone, deposit)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(account.provider, bill.id, bill.url, venueId, charge, first.name, first.phone, asDeposit ? 1 : 0);
    const link = db.prepare(
      "INSERT INTO online_payment_bookings (payment_id, booking_id, amount) VALUES (?, ?, ?)"
    );
    for (const b of due) await link.run(info.lastInsertRowid, b.id, billedFor.get(b.id)!);
  })();
  return { ok: true, url: bill.url, amount: charge, reused: false, ...(asDeposit ? { deposit: true } : {}) };
}

/**
 * A bill already made for exactly these bookings, still unpaid, and made
 * within `maxAgeMinutes` (so its page is still open: a day at most, which is
 * as long as Stripe keeps one).
 */
async function pendingPaymentFor(bookingIds: number[], amount: number, maxAgeMinutes: number, deposit = false): Promise<PaymentRow | null> {
  const candidates = await getDb()
    .prepare(`
      SELECT p.* FROM online_payments p
       WHERE p.status = 'pending' AND p.purpose = 'booking' AND p.deposit = ${deposit ? 1 : 0} AND p.amount = ?
         AND p.created_at > datetime('now', '-${Math.round(maxAgeMinutes)} minutes')
         AND p.id IN (SELECT payment_id FROM online_payment_bookings WHERE booking_id = ?)
       ORDER BY p.id DESC
    `)
    .all(amount, bookingIds[0]) as PaymentRow[];
  for (const row of candidates) {
    const linked = (
      await getDb()
        .prepare("SELECT booking_id FROM online_payment_bookings WHERE payment_id = ? ORDER BY booking_id")
        .all(row.id) as { booking_id: number }[]
    ).map((r) => r.booking_id);
    if (linked.length === bookingIds.length && linked.every((id, i) => id === bookingIds[i]))
      return row;
  }
  return null;
}

/**
 * Whose key checks a callback or redirect for this payment page, at this
 * gateway. A report that names a page made through another gateway is not
 * checked at all.
 */
export async function accountForBill(provider: string, billId: string): Promise<GatewayAccount | null> {
  const row = await getDb()
    .prepare("SELECT venue_id, purpose, provider FROM online_payments WHERE bill_id = ?")
    .get(billId) as { venue_id: number | null; purpose: string; provider: string } | undefined;
  if (!row || row.provider !== provider) return null;
  // A venue's fee was billed to the platform's account, and is checked with its key.
  // So was a venue's WhatsApp pack.
  if (row.purpose === "invoice" || row.purpose === "pack") {
    const platform = platformAccount();
    return platform?.provider === provider ? platform : null;
  }
  if (row.venue_id === null) return null;
  // Checked even when the venue has since switched online payment off: a page
  // it already sent can still be paid, and that money still arrived.
  const account = await accountRow(row.venue_id);
  if (!account || account.provider !== provider) return null;
  return readAccount(account);
}

export interface Settled {
  payment: OnlinePayment;
  /** The bookings this payment settled just now. */
  newlyPaid: Booking[];
}

/**
 * Record what the gateway said about a bill, once.
 *
 * A gateway tells us by callback and by redirect, in either order, and retries a
 * callback it thinks failed — so this is safe to call any number of times. A
 * booking cancelled, or paid some other way, before the money arrived is not
 * marked paid twice: the amount is written down as owed back instead.
 */
export async function settleBill(result: PaymentResult): Promise<Settled | null> {
  const db = getDb();
  const row = await db.prepare("SELECT * FROM online_payments WHERE bill_id = ?").get(result.billId) as
    | PaymentRow
    | undefined;
  if (!row) return null;
  if (!result.paid || row.status === "paid") return { payment: await toPayment(row), newlyPaid: [] };

  if (row.purpose === "entry") {
    await db.transaction(async () => {
      const claimed = await db
        .prepare("UPDATE online_payments SET status = 'paid', paid_at = datetime('now') WHERE id = ? AND status = 'pending'")
        .run(row.id);
      if (claimed.changes === 0) return;
      // Withdrawn, the tournament called off, or the fee already paid (at the
      // counter, or on another page) while they paid: owed back, and no
      // second receipt — one payment is the fee, the other is the customer's.
      const entry = (await db
        .prepare(
          `SELECT e.status, e.paid_at, t.status AS t_status FROM tournament_entries e JOIN tournaments t ON t.id = e.tournament_id WHERE e.id = ?`
        )
        .get(row.tournament_entry_id)) as { status: string; paid_at: string | null; t_status: string } | undefined;
      if (!entry || entry.status === "withdrawn" || entry.t_status === "cancelled" || entry.paid_at !== null)
        await db.prepare("UPDATE online_payments SET refund_due = amount WHERE id = ?").run(row.id);
      else {
        await db.prepare("UPDATE tournament_entries SET paid_at = datetime('now') WHERE id = ?").run(row.tournament_entry_id);
        const sale = await entrySale(row.tournament_entry_id!);
        if (sale) await receiptPayment(row, { description: sale.description, userId: sale.userId, taxable: true });
      }
    })();
    const fresh = await db.prepare("SELECT * FROM online_payments WHERE id = ?").get(row.id) as PaymentRow;
    return { payment: await toPayment(fresh), newlyPaid: [] };
  }

  if (row.purpose === "league") {
    await db.transaction(async () => {
      const claimed = await db
        .prepare("UPDATE online_payments SET status = 'paid', paid_at = datetime('now') WHERE id = ? AND status = 'pending'")
        .run(row.id);
      if (claimed.changes === 0) return;
      // Left the league, or paid at the counter, while they paid: owed back.
      const place = (await db.prepare("SELECT withdrawn_at, paid_at FROM league_places WHERE id = ?").get(row.league_place_id)) as
        | { withdrawn_at: string | null; paid_at: string | null }
        | undefined;
      if (!place || place.withdrawn_at !== null || place.paid_at !== null)
        await db.prepare("UPDATE online_payments SET refund_due = amount WHERE id = ?").run(row.id);
      else {
        await db.prepare("UPDATE league_places SET paid_at = datetime('now') WHERE id = ?").run(row.league_place_id);
        const sale = await placeSale(row.league_place_id!);
        if (sale) await receiptPayment(row, { description: sale.description, userId: sale.userId, taxable: true });
      }
    })();
    const fresh = await db.prepare("SELECT * FROM online_payments WHERE id = ?").get(row.id) as PaymentRow;
    return { payment: await toPayment(fresh), newlyPaid: [] };
  }

  if (row.purpose === "share") {
    await db.transaction(async () => {
      const claimed = await db
        .prepare("UPDATE online_payments SET status = 'paid', paid_at = datetime('now') WHERE id = ? AND status = 'pending'")
        .run(row.id);
      if (claimed.changes === 1) await settleShare(row);
    })();
    const fresh = await db.prepare("SELECT * FROM online_payments WHERE id = ?").get(row.id) as PaymentRow;
    return { payment: await toPayment(fresh), newlyPaid: [] };
  }

  if (row.purpose === "split") {
    await db.transaction(async () => {
      const claimed = await db
        .prepare("UPDATE online_payments SET status = 'paid', paid_at = datetime('now') WHERE id = ? AND status = 'pending'")
        .run(row.id);
      if (claimed.changes !== 1 || !row.split_id) return;
      const { countSplitShare } = await import("./splits");
      const counted = await countSplitShare(row.id, row.split_id, Number(row.amount));
      // Receipted either way: money was taken; one owed back is credited.
      await receiptPayment(row, { description: "Share of a booking, split with friends", userId: null, taxable: true });
      if (!counted) await creditReceipt(`payment:${row.id}`, "receipt.why.refunded");
    })();
    const fresh = await db.prepare("SELECT * FROM online_payments WHERE id = ?").get(row.id) as PaymentRow;
    return { payment: await toPayment(fresh), newlyPaid: [] };
  }

  if (row.purpose === "membership") {
    await db.transaction(async () => {
      const claimed = await db
        .prepare("UPDATE online_payments SET status = 'paid', paid_at = datetime('now') WHERE id = ? AND status = 'pending'")
        .run(row.id);
      if (claimed.changes !== 1) return;
      const made = await makePaidMembership(row);
      if (made !== null) await db.prepare("UPDATE online_payments SET membership_id = ? WHERE id = ?").run(made, row.id);
      // The plan went, the account went, or a second payment for the same
      // months came in: nothing to give for it, so it is owed back.
      else await db.prepare("UPDATE online_payments SET refund_due = amount WHERE id = ?").run(row.id);
      // The first charge of a membership that renews itself: from now on the gateway charges each period.
      if (result.subscriptionId && made !== null)
        await db
          .prepare(
            `INSERT INTO membership_subscriptions (venue_id, user_id, plan_id, provider, subscription_id, membership_id)
             VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (subscription_id) DO NOTHING`
          )
          .run(row.venue_id, row.member_user_id, row.membership_plan_id, row.provider, result.subscriptionId, made);
      if (result.subscriptionId)
        await db.prepare("UPDATE online_payments SET subscription_id = ? WHERE id = ?").run(result.subscriptionId, row.id);
    })();
    const fresh = await db.prepare("SELECT * FROM online_payments WHERE id = ?").get(row.id) as PaymentRow;
    // Paid for nothing it can give: no more charges either.
    if (fresh.membership_id == null && fresh.subscription_id) await stopSubscription(fresh.subscription_id);
    return { payment: await toPayment(fresh), newlyPaid: [] };
  }

  if (row.purpose === "topup") {
    await db.transaction(async () => {
      const claimed = await db
        .prepare("UPDATE online_payments SET status = 'paid', paid_at = datetime('now') WHERE id = ? AND status = 'pending'")
        .run(row.id);
      if (claimed.changes === 1 && row.topup_user_id) {
        // The credit is the venue's to honour where credit is per venue;
        // spendable anywhere on a single business's own copy.
        await db
          .prepare("INSERT INTO wallet_entries (user_id, amount, reason, venue_id) VALUES (?, ?, 'Online top-up', ?)")
          .run(row.topup_user_id, row.amount, creditScope() === "venue" ? row.venue_id : null);
        await receiptPayment(row, {
          description: "Stored credit: online top-up",
          userId: row.topup_user_id,
          // Credit is taxed when it is spent, on what it buys.
          taxable: false,
          note: row.venue_id !== null && (await venueTax(row.venue_id)).registered ? "receipt.creditNoTax" : null,
        });
      } else if (claimed.changes === 1) {
        // The account went away while they paid: owed back.
        await db.prepare("UPDATE online_payments SET refund_due = amount WHERE id = ?").run(row.id);
      }
    })();
    const fresh = await db.prepare("SELECT * FROM online_payments WHERE id = ?").get(row.id) as PaymentRow;
    return { payment: await toPayment(fresh), newlyPaid: [] };
  }

  if (row.purpose === "voucher") {
    let bought: Voucher | null = null;
    await db.transaction(async () => {
      const claimed = await db
        .prepare("UPDATE online_payments SET status = 'paid', paid_at = datetime('now') WHERE id = ? AND status = 'pending'")
        .run(row.id);
      if (claimed.changes !== 1 || row.voucher_id == null) return;
      bought = await activateVoucher(row.voucher_id, paidVia("online", gatewayFor(row.provider)?.name));
      if (bought)
        await receiptPayment(row, {
          description: `Gift voucher ${bought.code}`,
          userId: null,
          // Taxed when it is spent, on what it buys, like the credit it becomes.
          taxable: false,
          note: row.venue_id !== null && (await venueTax(row.venue_id)).registered ? "receipt.creditNoTax" : null,
        });
      // Nothing to give for it (the voucher went): owed back.
      else await db.prepare("UPDATE online_payments SET refund_due = amount WHERE id = ?").run(row.id);
    })();
    if (bought) await sendVoucher(bought);
    const fresh = await db.prepare("SELECT * FROM online_payments WHERE id = ?").get(row.id) as PaymentRow;
    return { payment: await toPayment(fresh), newlyPaid: [] };
  }

  if (row.purpose === "pack") {
    await db.transaction(async () => {
      const claimed = await db
        .prepare("UPDATE online_payments SET status = 'paid', paid_at = datetime('now') WHERE id = ? AND status = 'pending'")
        .run(row.id);
      if (claimed.changes !== 1) return;
      // A pack already paid (by hand, or on another page) or called off: this payment is owed back.
      if (row.pack_id === null || !(await settlePack(row.pack_id, "online")))
        await db.prepare("UPDATE online_payments SET refund_due = amount WHERE id = ?").run(row.id);
    })();
    const fresh = await db.prepare("SELECT * FROM online_payments WHERE id = ?").get(row.id) as PaymentRow;
    return { payment: await toPayment(fresh), newlyPaid: [] };
  }

  if (row.purpose === "invoice") {
    await db.transaction(async () => {
      const claimed = await db
        .prepare("UPDATE online_payments SET status = 'paid', paid_at = datetime('now') WHERE id = ? AND status = 'pending'")
        .run(row.id);
      if (claimed.changes !== 1) return;
      // An invoice already paid (marked by the owner, or on another page) or voided: owed back.
      if (row.invoice_id === null || !(await settleInvoice(row.invoice_id)))
        await db.prepare("UPDATE online_payments SET refund_due = amount WHERE id = ?").run(row.id);
    })();
    const fresh = await db.prepare("SELECT * FROM online_payments WHERE id = ?").get(row.id) as PaymentRow;
    return { payment: await toPayment(fresh), newlyPaid: [] };
  }

  const paidAt = new Date().toISOString();
  const newlyPaid: number[] = [];
  // Bookings a deposit was just paid on: held no longer, the rest due at the counter.
  const deposited: number[] = [];
  await db.transaction(async () => {
    const claimed = await db
      .prepare("UPDATE online_payments SET status = 'paid', paid_at = ? WHERE id = ? AND status = 'pending'")
      .run(paidAt, row.id);
    if (claimed.changes === 0) return;

    const linked = await db
      .prepare(`
        SELECT b.id, b.status, b.payment_status, b.total_price::float AS total_price, b.shares_paid::float AS shares_paid,
               b.deposit_paid::float AS deposit_paid, pb.amount::float AS billed
          FROM online_payment_bookings pb JOIN bookings b ON b.id = pb.booking_id
         WHERE pb.payment_id = ?
      `)
      .all(row.id) as {
      id: number;
      status: string;
      payment_status: string;
      total_price: number;
      shares_paid: number;
      deposit_paid: number;
      billed: number | null;
    }[];
    let owed = 0;
    if (row.deposit === 1) {
      // A deposit counts towards the booking like a share, on its own receipt; the booking stays unpaid
      // for the rest. Not for one cancelled, paid already, or with a deposit on it from another page.
      for (const b of linked) {
        const due = Math.round((Number(b.total_price) - Number(b.shares_paid)) * 100) / 100;
        const billed = Number(b.billed ?? 0);
        if (b.status === "confirmed" && b.payment_status === "unpaid" && Number(b.deposit_paid) === 0 && billed <= due + 0.005) {
          await db
            .prepare("UPDATE bookings SET shares_paid = shares_paid + ?, deposit_paid = deposit_paid + ? WHERE id = ?")
            .run(billed, billed, b.id);
          deposited.push(b.id);
        } else owed += billed;
      }
      if (owed > 0)
        await db
          .prepare("UPDATE online_payments SET refund_due = LEAST(amount, refund_due + ?) WHERE id = ?")
          .run(Math.round(owed * 100) / 100, row.id);
      if (deposited.length > 0) {
        const codes = (await db
          .prepare(`SELECT code FROM bookings WHERE id IN (${deposited.map(() => "?").join(",")}) ORDER BY id`)
          .all(...deposited)) as { code: string }[];
        await receiptPayment(
          { ...row, amount: Math.round((Number(row.amount) - owed) * 100) / 100 },
          { description: `Deposit for ${codes.map((c) => c.code).join(", ")}`, userId: null, taxable: true }
        );
      }
      return;
    }
    for (const b of linked) {
      const due = Math.round((Number(b.total_price) - Number(b.shares_paid)) * 100) / 100;
      // What this page asked for it; a page made before that was recorded asked what it cost.
      const billed = b.billed === null ? due : Number(b.billed);
      if (b.status === "confirmed" && b.payment_status === "unpaid" && billed >= due - 0.005) {
        await db.prepare(
          "UPDATE bookings SET payment_status = 'paid', paid_at = ?, paid_via = 'online' WHERE id = ?"
        ).run(paidAt, b.id);
        newlyPaid.push(b.id);
        // It came down while the page was open (a promo code, a cheaper time): the difference is owed back,
        // and what the payment keeps for it is what it now costs.
        if (billed > due + 0.005) {
          owed += billed - due;
          await db.prepare("UPDATE online_payment_bookings SET amount = ? WHERE payment_id = ? AND booking_id = ?").run(due, row.id, b.id);
        }
      } else {
        // Cancelled, paid another way, or dearer than the page asked: none of it is kept for this booking.
        owed += billed;
      }
    }
    if (owed > 0)
      await db
        .prepare("UPDATE online_payments SET refund_due = LEAST(amount, refund_due + ?) WHERE id = ?")
        .run(Math.round(owed * 100) / 100, row.id);
  })();

  const fresh = await db.prepare("SELECT * FROM online_payments WHERE id = ?").get(row.id) as PaymentRow;
  // A deposit on a held booking: it stands now, and is confirmed as one paid in full would be.
  if (deposited.length > 0) {
    const holding: Booking[] = [];
    for (const id of deposited) {
      const b = await bookingById(id);
      if (b?.holdUntil) holding.push(b);
    }
    if (holding.length > 0) {
      await db.prepare(`UPDATE bookings SET hold_until = NULL WHERE id IN (${holding.map(() => "?").join(",")})`).run(...holding.map((b) => b.id));
      for (const group of Map.groupBy(holding, (b) => b.seriesCode ?? b.groupCode ?? b.code).values()) {
        const stored = (await db.prepare("SELECT locale FROM bookings WHERE id = ?").get(group[0].id)) as { locale: string | null };
        await notifyBookingConfirmed(
          group.map((b) => ({ ...b, holdUntil: null })),
          isLocale(stored.locale) ? stored.locale : "en",
          group.length > 1 ? group[0].seriesCode : null
        );
      }
    }
    return { payment: await toPayment(fresh), newlyPaid: [] };
  }
  const bookings: Booking[] = [];
  for (const id of newlyPaid) {
    const b = await bookingById(id);
    if (b) bookings.push(b);
  }
  // Held until paid: it stands now, and this is the confirmation the
  // customer was waiting for, calendar invite and all. Anything else gets a
  // receipt, by email, for what was just paid.
  const held = bookings.filter((b) => b.holdUntil);
  if (held.length > 0) {
    await db
      .prepare(`UPDATE bookings SET hold_until = NULL WHERE id IN (${held.map(() => "?").join(",")})`)
      .run(...held.map((b) => b.id));
    for (const group of Map.groupBy(held, (b) => b.seriesCode ?? b.groupCode ?? b.code).values()) {
      const stored = (await db.prepare("SELECT locale FROM bookings WHERE id = ?").get(group[0].id)) as { locale: string | null };
      await notifyBookingConfirmed(
        group.map((b) => ({ ...b, holdUntil: null })),
        isLocale(stored.locale) ? stored.locale : "en",
        group.length > 1 ? group[0].seriesCode : null
      );
    }
  }
  await notifyPaid(
    bookings.filter((b) => !b.holdUntil),
    "online"
  );
  return { payment: await toPayment(fresh), newlyPaid: bookings };
}

/** Receipt an online payment for something other than court time, as it settles. */
async function receiptPayment(
  row: PaymentRow,
  sale: { description: string; userId: number | null; taxable: boolean; note?: string | null }
): Promise<void> {
  const lines: Line[] = [{ description: sale.description, amount: Number(row.amount) }];
  await issueReceipt({
    source: `payment:${row.id}`,
    venueId: row.venue_id,
    userId: sale.userId,
    name: row.payer_name ?? "Customer",
    phone: row.payer_phone,
    lines,
    paidVia: paidVia("online", gatewayFor(row.provider)?.name),
    taxable: sale.taxable,
    note: sale.note ?? null,
  });
}

async function bookingById(id: number): Promise<Booking | null> {
  const row = await getDb().prepare("SELECT code, phone FROM bookings WHERE id = ?").get(id) as
    | { code: string; phone: string }
    | undefined;
  return row ? await findBooking(row.code, row.phone) : null;
}

// ------------------------------------------------------------ for staff

export async function listOnlinePayments(venueId: number, limit = 50): Promise<OnlinePayment[]> {
  const rows = (await getDb()
    .prepare(
      "SELECT * FROM online_payments WHERE venue_id = ? AND purpose = 'booking' ORDER BY id DESC LIMIT ?"
    )
    .all(venueId, limit)) as PaymentRow[];
  return Promise.all(rows.map(toPayment));
}

/**
 * Payments to the venue with money still to go back, oldest first: bookings
 * cancelled after paying, and fees, shares and top-ups paid for something
 * that had gone by the time the money came in. Not the venue's own invoice
 * or WhatsApp packs, which it paid the platform.
 */
export async function refundsOwed(venueId: number): Promise<OnlinePayment[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT p.*, v.refund_within_days FROM online_payments p JOIN venues v ON v.id = p.venue_id
        WHERE p.venue_id = ? AND p.purpose NOT IN ('invoice', 'pack') AND p.refund_due > p.refunded ORDER BY p.id`
    )
    .all(venueId)) as (PaymentRow & { refund_seen_at: string | null; refund_within_days: number })[];
  return Promise.all(rows.map(async (r) => ({ ...(await toPayment(r)), owed: refundClock(r.refund_seen_at, r.refund_within_days) })));
}

/** A venue's refunds past the date its customers were told. */
export interface OverdueRefunds {
  venueId: number;
  venueName: string;
  count: number;
  amount: number;
  oldestDays: number;
}

/** Refunds owed longer than each venue says they take, for the venues given (null: every venue). */
export async function overdueRefunds(venueIds: number[] | null, now = new Date()): Promise<OverdueRefunds[]> {
  if (venueIds && venueIds.length === 0) return [];
  const only = venueIds ? ` AND p.venue_id IN (${venueIds.map(() => "?").join(",")})` : "";
  const rows = (await getDb()
    .prepare(
      `SELECT p.venue_id, v.name AS venue_name, v.refund_within_days, p.refund_seen_at, (p.refund_due - p.refunded)::float AS owed
         FROM online_payments p JOIN venues v ON v.id = p.venue_id
        WHERE p.refund_due > p.refunded AND p.status = 'paid' AND p.purpose NOT IN ('invoice', 'pack') AND p.refund_seen_at IS NOT NULL${only}
        ORDER BY p.venue_id, p.id`
    )
    .all(...(venueIds ?? []))) as { venue_id: number; venue_name: string; refund_within_days: number; refund_seen_at: string; owed: number }[];
  const byVenue = new Map<number, OverdueRefunds>();
  for (const r of rows) {
    const clock = refundClock(r.refund_seen_at, r.refund_within_days, now);
    if (!clock.overdue) continue;
    const v = byVenue.get(r.venue_id) ?? { venueId: r.venue_id, venueName: r.venue_name, count: 0, amount: 0, oldestDays: 0 };
    v.count++;
    v.amount = roundMoney(v.amount + r.owed);
    v.oldestDays = Math.max(v.oldestDays, clock.days);
    byVenue.set(r.venue_id, v);
  }
  return [...byVenue.values()];
}

/** Where a customer's money paid online for a booking stands, once any of it is owed back. */
export interface RefundStatus {
  paymentId: number;
  /** The bookings it paid for: a refund is shown with each. */
  bookingIds: number[];
  paid: number;
  owed: number;
  refunded: number;
  /** Straight back through the gateway, as credit, or by the venue's staff by hand. */
  how: OnlineRefunds;
  /** While anything is owed. */
  clock: RefundClock | null;
  /** When the last of it went back. */
  refundedAt: string | null;
}

/**
 * What a customer is told about refunds on these bookings: owed (and by
 * when, as the venue promises) or made (and when). Only payments with
 * something owed back; nothing about how staff made it beyond the date.
 */
export async function refundStatusFor(bookingIds: number[]): Promise<RefundStatus[]> {
  if (bookingIds.length === 0) return [];
  const rows = (await getDb()
    .prepare(
      `SELECT p.id, p.amount::float AS amount, p.refund_due::float AS refund_due, p.refunded::float AS refunded, p.refund_seen_at,
              v.refund_within_days, v.online_refunds,
              (SELECT MAX(r.created_at) FROM online_refunds r
                WHERE r.payment_id = p.id AND r.failed_at IS NULL AND COALESCE(r.provider_ref, '') NOT LIKE 'claim:%') AS refunded_at,
              (SELECT STRING_AGG(pb2.booking_id::text, ',') FROM online_payment_bookings pb2 WHERE pb2.payment_id = p.id) AS booking_ids
         FROM online_payments p JOIN venues v ON v.id = p.venue_id
        WHERE p.status = 'paid' AND p.refund_due > 0
          AND p.id IN (SELECT pb.payment_id FROM online_payment_bookings pb WHERE pb.booking_id IN (${bookingIds.map(() => "?").join(", ")}))
        ORDER BY p.id`
    )
    .all(...bookingIds)) as {
    id: number;
    amount: number;
    refund_due: number;
    refunded: number;
    refund_seen_at: string | null;
    refund_within_days: number;
    online_refunds: OnlineRefunds;
    refunded_at: string | null;
    booking_ids: string | null;
  }[];
  return rows.map((r) => {
    const owed = Math.max(0, roundMoney(r.refund_due - r.refunded));
    return {
      paymentId: r.id,
      bookingIds: (r.booking_ids ?? "").split(",").filter(Boolean).map(Number),
      paid: r.amount,
      owed,
      refunded: r.refunded,
      how: r.online_refunds,
      clock: owed > 0 ? refundClock(r.refund_seen_at, r.refund_within_days) : null,
      refundedAt: owed > 0 ? null : r.refunded_at,
    };
  });
}

/** One month of refunds made: how many by hand, how long they took, how many late. */
export interface RefundMonth {
  month: string;
  byHand: number;
  byHandAmount: number;
  /** Through the gateway's API, or as credit. */
  automatic: number;
  /** Days from owed to refunded, by hand, on average. */
  averageDays: number | null;
  /** By hand, later than the venue tells customers. */
  late: number;
}

export interface RefundWorkload {
  months: RefundMonth[];
  /** Owed now, and how many of those are past the date customers were told. */
  owed: number;
  overdue: number;
  oldestDays: number | null;
}

/**
 * The work refunds by hand make, month by month (a venue's, or with
 * `venueId` null every venue's, for the platform's owner): what decides
 * whether a gateway without a refund API is still worth its lower fees.
 */
export async function refundWorkload(venueId: number | null, months = 6, now = new Date()): Promise<RefundWorkload> {
  const db = getDb();
  const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - (months - 1), 1)).toISOString().slice(0, 10);
  const where = venueId === null ? "" : "AND p.venue_id = ?";
  const args = venueId === null ? [] : [venueId];
  const made = (await db
    .prepare(
      `SELECT SUBSTR(r.created_at, 1, 7) AS month,
              COUNT(*) FILTER (WHERE r.provider_ref IS NULL)::int AS by_hand,
              COALESCE(SUM(r.amount) FILTER (WHERE r.provider_ref IS NULL), 0)::float AS by_hand_amount,
              COUNT(*) FILTER (WHERE r.provider_ref IS NOT NULL)::int AS automatic,
              AVG(EXTRACT(EPOCH FROM (r.created_at::timestamp - COALESCE(p.refund_seen_at, r.created_at)::timestamp)) / 86400.0)
                FILTER (WHERE r.provider_ref IS NULL)::float AS average_days,
              COUNT(*) FILTER (WHERE r.provider_ref IS NULL
                AND r.created_at::timestamp > COALESCE(p.refund_seen_at, r.created_at)::timestamp + make_interval(days => v.refund_within_days))::int AS late
         FROM online_refunds r JOIN online_payments p ON p.id = r.payment_id JOIN venues v ON v.id = p.venue_id
        WHERE r.created_at >= ? AND r.failed_at IS NULL AND COALESCE(r.provider_ref, '') NOT LIKE 'claim:%'
          AND p.purpose NOT IN ('invoice', 'pack') ${where}
        GROUP BY 1 ORDER BY 1`
    )
    .all(from, ...args)) as { month: string; by_hand: number; by_hand_amount: number; automatic: number; average_days: number | null; late: number }[];
  const owing = (await db
    .prepare(
      `SELECT p.refund_seen_at, v.refund_within_days FROM online_payments p JOIN venues v ON v.id = p.venue_id
        WHERE p.refund_due > p.refunded AND p.status = 'paid' AND p.purpose NOT IN ('invoice', 'pack') ${where}`
    )
    .all(...args)) as { refund_seen_at: string | null; refund_within_days: number }[];
  const clocks = owing.map((o) => refundClock(o.refund_seen_at, o.refund_within_days, now));
  return {
    months: made.map((m) => ({
      month: m.month,
      byHand: m.by_hand,
      byHandAmount: roundMoney(m.by_hand_amount),
      automatic: m.automatic,
      averageDays: m.average_days === null ? null : Math.round(m.average_days * 10) / 10,
      late: m.late,
    })),
    owed: clocks.length,
    overdue: clocks.filter((c) => c.overdue).length,
    oldestDays: clocks.length ? Math.max(...clocks.map((c) => c.days)) : null,
  };
}

/**
 * Owed back on what venues paid the platform (an invoice or a WhatsApp pack
 * paid twice, or after it was voided): the platform owner's to refund, from
 * the platform's own account.
 */
export async function platformRefundsOwed(): Promise<OnlinePayment[]> {
  const rows = (await getDb()
    .prepare("SELECT * FROM online_payments WHERE purpose IN ('invoice', 'pack') AND refund_due > refunded ORDER BY id")
    .all()) as PaymentRow[];
  return Promise.all(rows.map(toPayment));
}

/** A refund on its way: asked of the gateway with no answer yet, or accepted and still going through. */
export interface RefundInFlight {
  paymentId: number;
  billId: string;
  payerName: string | null;
  amount: number;
  since: string;
  /** Asked with no answer yet; accepted and going through; or accepted and then failed in the last 30 days (owed again). */
  state: "asked" | "processing" | "failed";
}

/** What staff cannot yet count as refunded or owed: a venue's, or (`null`) the platform's own. */
export async function refundsInFlight(venueId: number | null): Promise<RefundInFlight[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT p.id, p.bill_id, p.payer_name, r.amount::float AS amount, r.created_at, r.provider_ref, r.failed_at FROM online_refunds r
         JOIN online_payments p ON p.id = r.payment_id
        WHERE (r.provider_ref LIKE 'claim:%' OR r.pending = 1 OR r.failed_at > datetime('now', '-30 days'))
          AND ${venueId === null ? "p.purpose IN ('invoice', 'pack')" : "p.venue_id = ? AND p.purpose NOT IN ('invoice', 'pack')"}
        ORDER BY r.id`
    )
    .all(...(venueId === null ? [] : [venueId]))) as {
    id: number;
    bill_id: string;
    payer_name: string | null;
    amount: number;
    created_at: string;
    provider_ref: string;
    failed_at: string | null;
  }[];
  return rows.map((r) => ({
    paymentId: r.id,
    billId: r.bill_id,
    payerName: r.payer_name,
    amount: r.amount,
    since: r.failed_at ?? r.created_at,
    state: r.failed_at ? "failed" : r.provider_ref.startsWith("claim:") ? "asked" : "processing",
  }));
}

export type RefundDone =
  | { ok: true; payment: OnlinePayment; pending: boolean }
  /** `unknown`: sent, with no clear answer; it stays claimed and is asked again (settleRefundClaims). */
  | { ok: false; error: string; unknown?: boolean };

/** A payment with something owed back: a venue's own (by its id), or one made to the platform (`null`). */
async function owedRow(paymentId: number, venueId: number | null): Promise<PaymentRow | null> {
  const row = (await getDb()
    .prepare(
      venueId === null
        ? "SELECT * FROM online_payments WHERE id = ? AND purpose IN ('invoice', 'pack') AND refund_due > refunded"
        : `SELECT * FROM online_payments
            WHERE id = ? AND venue_id = ? AND purpose NOT IN ('invoice', 'pack') AND refund_due > refunded`
    )
    .get(...(venueId === null ? [paymentId] : [paymentId, venueId]))) as PaymentRow | undefined;
  return row ?? null;
}

/**
 * Write a refund down against its payment. Counted once: the same refund
 * reported again (a double click; the gateway answering a retry with the
 * refund it already made) finds its id already there and changes nothing.
 */
async function recordRefund(
  row: PaymentRow,
  amount: number,
  ref: string | null,
  pending: boolean,
  adminId: number | null,
  /** Whatever else the refund is, in the same transaction: credit it became. */
  also?: () => Promise<void>,
  /** What staff wrote down making it by hand: a transfer reference. */
  note: string | null = null
): Promise<boolean> {
  const db = getDb();
  return db.transaction(async () => {
    const added = await db
      .prepare(
        `INSERT INTO online_refunds (payment_id, amount, provider_ref, pending, admin_id, note) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (provider_ref) DO NOTHING`
      )
      .run(row.id, amount, ref, pending ? 1 : 0, adminId, note);
    if (added.changes === 0) return false;
    const done = await db
      .prepare("UPDATE online_payments SET refunded = refunded + ? WHERE id = ? AND refunded + ? <= refund_due")
      .run(amount, row.id, amount);
    if (done.changes === 0) throw new Error("REFUND_RACE");
    await also?.();
    // What its receipt said was sold is reversed. A booking's is reversed when it is cancelled.
    await creditReceipt(`payment:${row.id}`, "receipt.why.refunded");
    return true;
  })();
}

const reread = async (id: number) =>
  toPayment((await getDb().prepare("SELECT * FROM online_payments WHERE id = ?").get(id)) as PaymentRow);

/** A refund claimed but refused, or abandoned: the amount is owed again. */
async function releaseClaim(paymentId: number, amount: number, claim: string): Promise<void> {
  const db = getDb();
  await db.transaction(async () => {
    const gone = await db.prepare("DELETE FROM online_refunds WHERE provider_ref = ?").run(claim);
    if (gone.changes > 0) await db.prepare("UPDATE online_payments SET refunded = refunded - ? WHERE id = ?").run(amount, paymentId);
  })();
}

/** A claimed refund the gateway made: the claim becomes its record, and the receipt is credited. */
async function finishClaim(paymentId: number, amount: number, claim: string, refundId: string, pending: boolean): Promise<void> {
  const db = getDb();
  await db.transaction(async () => {
    // Stripe answers a retry under the same key with the same refund: one row for it.
    if (await db.prepare("SELECT 1 FROM online_refunds WHERE provider_ref = ?").get(refundId)) {
      const gone = await db.prepare("DELETE FROM online_refunds WHERE provider_ref = ?").run(claim);
      if (gone.changes > 0) await db.prepare("UPDATE online_payments SET refunded = refunded - ? WHERE id = ?").run(amount, paymentId);
      return;
    }
    const kept = await db.prepare("UPDATE online_refunds SET provider_ref = ?, pending = ? WHERE provider_ref = ?").run(refundId, pending ? 1 : 0, claim);
    if (kept.changes === 0) return;
    // What its receipt said was sold is reversed, as for any refund.
    await creditReceipt(`payment:${paymentId}`, "receipt.why.refunded");
  })();
}

/**
 * Refunds claimed and never finished: the app stopped while the gateway was
 * being asked. Asked again under the same idempotency key, the gateway makes
 * the refund or hands back the one it already made; refused, the amount is
 * owed again. From the scheduler, for claims older than a few minutes.
 */
export async function settleRefundClaims(olderThanMinutes = 10): Promise<number> {
  const db = getDb();
  const cutoff = new Date(Date.now() - olderThanMinutes * 60_000).toISOString().replace("T", " ").slice(0, 19);
  const claims = (await db
    .prepare(
      `SELECT r.payment_id, r.amount::float AS amount, r.provider_ref, p.provider, p.bill_id
         FROM online_refunds r JOIN online_payments p ON p.id = r.payment_id
        WHERE r.provider_ref LIKE 'claim:%' AND r.created_at < ?`
    )
    .all(cutoff)) as { payment_id: number; amount: number; provider_ref: string; provider: string; bill_id: string }[];
  let settled = 0;
  for (const c of claims) {
    const gateway = gatewayFor(c.provider);
    const account = gateway?.refund ? await accountForBill(c.provider, c.bill_id) : null;
    if (!gateway?.refund || !account) {
      await releaseClaim(c.payment_id, c.amount, c.provider_ref);
      settled++;
      continue;
    }
    const { code, minorUnits } = region().currency;
    const result = await gateway
      .refund(account, { billId: c.bill_id, amount: c.amount, currency: { code, minorUnits }, idempotencyKey: c.provider_ref.slice("claim:".length) })
      .catch(() => null);
    if (result === null || (!result.ok && result.unknown)) continue; // no answer again: asked next time
    if (result.ok) await finishClaim(c.payment_id, c.amount, c.provider_ref, result.refundId, result.pending);
    else await releaseClaim(c.payment_id, c.amount, c.provider_ref);
    settled++;
  }
  return settled;
}

/**
 * Refunds the gateway accepted and is still making: asked how each stands,
 * at most once an hour. Made, it is done. Failed (a closed card, say), the
 * money did not go back: it is owed again, the row stays as the record, and
 * staff see it under *Refunds on their way* and from the integrity check.
 * Not asked for again by itself, since the same card would refuse it again.
 */
export async function settlePendingRefunds(): Promise<number> {
  const db = getDb();
  const rows = (await db
    .prepare(
      `SELECT r.id, r.payment_id, r.amount::float AS amount, r.provider_ref, p.provider, p.bill_id
         FROM online_refunds r JOIN online_payments p ON p.id = r.payment_id
        WHERE r.pending = 1 AND r.failed_at IS NULL AND r.provider_ref NOT LIKE 'claim:%'
          AND (r.checked_at IS NULL OR r.checked_at < datetime('now', '-60 minutes'))
        ORDER BY r.id LIMIT 50`
    )
    .all()) as { id: number; payment_id: number; amount: number; provider_ref: string; provider: string; bill_id: string }[];
  let changed = 0;
  for (const r of rows) {
    const gateway = gatewayFor(r.provider);
    const account = gateway?.refundStatus ? await accountForBill(r.provider, r.bill_id) : null;
    const status = gateway?.refundStatus && account ? await gateway.refundStatus(account, r.provider_ref).catch(() => "unknown" as const) : "unknown";
    if (status === "succeeded") {
      await db.prepare("UPDATE online_refunds SET pending = 0, checked_at = datetime('now') WHERE id = ? AND pending = 1").run(r.id);
      changed++;
    } else if (status === "failed") {
      const owedAgain = await db.transaction(async () => {
        const marked = await db
          .prepare("UPDATE online_refunds SET pending = 0, failed_at = datetime('now'), checked_at = datetime('now') WHERE id = ? AND failed_at IS NULL")
          .run(r.id);
        if (marked.changes === 0) return false;
        await db.prepare("UPDATE online_payments SET refunded = refunded - ? WHERE id = ?").run(r.amount, r.payment_id);
        return true;
      })();
      if (owedAgain) changed++;
    } else {
      await db.prepare("UPDATE online_refunds SET checked_at = datetime('now') WHERE id = ?").run(r.id);
    }
  }
  return changed;
}

/**
 * Money owed back on online payments, reconciled for every venue; refunded
 * through the gateway only where the venue refunds automatically. Two
 * separate things:
 *
 * - Reconciliation (all venues): each obligation is noted when first seen,
 *   with the venue's refund policy at that moment. Those that need staff —
 *   at a venue refunding by hand, through a gateway with no refund API,
 *   failed, or still owed after an automatic attempt — are put to the
 *   venue's staff in one message a day, and stay listed under Refunds owed
 *   until staff refund them (one click, or by hand and marked).
 * - Execution (automatic venues only): an obligation first seen while the
 *   venue refunded automatically, and still so, is asked of the gateway ten
 *   minutes after it was first seen (so a refund the cancelling request is
 *   still making is left to it), at most once a day, under the same
 *   idempotency key as any other refund of it. An obligation first seen
 *   while the venue refunded by hand is never refunded automatically, even
 *   if the venue switches later: its staff were handling it.
 *
 * Disputed payments and the platform's own are left to people. A refund
 * marked as made by hand leaves nothing owed, so nothing is refunded twice.
 * Returns how many were refunded automatically.
 */
export async function reconcileRefunds(): Promise<{ refunded: number; told: number }> {
  const db = getDb();
  const owed = `p.refund_due > p.refunded AND p.status = 'paid' AND p.venue_id IS NOT NULL
      AND p.purpose NOT IN ('invoice', 'pack')
      AND NOT EXISTS (SELECT 1 FROM online_refunds r WHERE r.payment_id = p.id AND r.provider_ref LIKE 'claim:%')
      AND NOT EXISTS (SELECT 1 FROM payment_disputes d WHERE d.payment_id = p.id AND COALESCE(d.outcome, '') <> 'won')`;
  // First sight, every venue: noted with the policy it was owed under.
  await db
    .prepare(
      `UPDATE online_payments p SET refund_seen_at = datetime('now'),
              refund_seen_policy = CASE WHEN EXISTS (SELECT 1 FROM venues v WHERE v.id = p.venue_id AND v.online_refunds = 'gateway') THEN 'auto' ELSE 'manual' END
        WHERE refund_seen_at IS NULL AND ${owed}`
    )
    .run();
  const due = (await db
    .prepare(
      `SELECT p.id, p.venue_id, p.provider FROM online_payments p
        WHERE ${owed} AND p.refund_seen_policy = 'auto'
          AND EXISTS (SELECT 1 FROM venues v WHERE v.id = p.venue_id AND v.online_refunds = 'gateway')
          AND NOT EXISTS (SELECT 1 FROM online_refunds r WHERE r.payment_id = p.id AND r.failed_at IS NOT NULL)
          AND p.refund_seen_at < datetime('now', '-10 minutes')
          AND (p.auto_refund_tried_at IS NULL OR p.auto_refund_tried_at < datetime('now', '-1 day'))
        ORDER BY p.id LIMIT 20`
    )
    .all()) as { id: number; venue_id: number; provider: string }[];
  let refunded = 0;
  for (const p of due) {
    if (!gatewayFor(p.provider)?.refund) continue;
    await db.prepare("UPDATE online_payments SET auto_refund_tried_at = datetime('now') WHERE id = ?").run(p.id);
    const done = await refundOnline(p.id, p.venue_id).catch(() => null);
    if (done?.ok) refunded++;
  }
  // What waits for staff, a day after it was first seen: a digest to each venue's staff, at most daily.
  const waiting = (await db
    .prepare(
      `SELECT p.venue_id, COUNT(*)::int AS n, SUM(p.refund_due - p.refunded)::float AS amount, MIN(p.refund_seen_at) AS oldest,
              COUNT(*) FILTER (WHERE p.refund_seen_at::timestamp + make_interval(days => (SELECT v.refund_within_days FROM venues v WHERE v.id = p.venue_id))
                               < datetime('now')::timestamp)::int AS overdue,
              COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM online_refunds r WHERE r.payment_id = p.id AND r.failed_at IS NOT NULL))::int AS failed
         FROM online_payments p
        WHERE ${owed} AND p.refund_seen_at < datetime('now', '-1 day')
          AND NOT (p.refund_seen_policy = 'auto' AND p.auto_refund_tried_at IS NULL
                   AND EXISTS (SELECT 1 FROM venues v WHERE v.id = p.venue_id AND v.online_refunds = 'gateway'))
        GROUP BY p.venue_id`
    )
    .all()) as { venue_id: number; n: number; amount: number; oldest: string; failed: number; overdue: number }[];
  let told = 0;
  for (const w of waiting) {
    const claimed = await db
      .prepare("UPDATE venues SET refund_digest_at = datetime('now') WHERE id = ? AND (refund_digest_at IS NULL OR refund_digest_at < datetime('now', '-20 hours'))")
      .run(w.venue_id);
    if (claimed.changes === 0) continue;
    await tellVenueStaff(
      w.venue_id,
      `${w.n} refund${w.n === 1 ? "" : "s"} waiting for you`,
      `${w.n} online payment${w.n === 1 ? " is" : "s are"} owed back to customers, ${money(roundMoney(w.amount).toFixed(2))} in all, the oldest since ${w.oldest.slice(0, 10)}.` +
        (w.overdue > 0 ? ` ${w.overdue} ${w.overdue === 1 ? "is" : "are"} past the date customers were told.` : "") +
        (w.failed > 0 ? ` ${w.failed} of them the gateway accepted and then could not make.` : "") +
        " Refund them from Online payments → Refunds owed: with one click where the gateway allows, or in its own dashboard and then mark each refunded."
    );
    told++;
  }
  return { refunded, told };
}

/** The automatic part of `reconcileRefunds`, as the scheduler and tests have called it: how many were refunded. */
export async function settleOwedRefunds(): Promise<number> {
  return (await reconcileRefunds()).refunded;
}

/**
 * Staff have made the refund themselves — in the gateway's dashboard, by bank
 * transfer — (`venueId` null: the platform owner, for one paid to the
 * platform), with what they wrote down to find it again (`note`). What is
 * owed is re-read and settled in one transaction, so a second click, or two
 * people at once, records it once.
 */
export async function markRefunded(paymentId: number, venueId: number | null, adminId: number | null = null, note: string | null = null): Promise<RefundDone> {
  const row = await owedRow(paymentId, venueId);
  if (!row) return { ok: false, error: "Nothing is owed back on that payment." };
  const written = note?.trim().slice(0, 200) || null;
  try {
    await recordRefund(row, roundMoney(row.refund_due - row.refunded), null, false, adminId, undefined, written);
  } catch {
    return { ok: false, error: "Nothing is owed back on that payment." };
  }
  return { ok: true, payment: await reread(row.id), pending: false };
}

/**
 * Refund what is owed on a payment through the gateway it was paid through,
 * with the venue's own account: one click instead of a trip to the
 * gateway's dashboard. Only where the gateway has a refund API (Stripe).
 */
export async function refundOnline(paymentId: number, venueId: number | null, adminId: number | null = null): Promise<RefundDone> {
  const row = await owedRow(paymentId, venueId);
  if (!row) return { ok: false, error: "Nothing is owed back on that payment." };
  const gateway = gatewayFor(row.provider);
  if (!gateway?.refund)
    return { ok: false, error: `${gateway?.name ?? row.provider} refunds are made in its own dashboard. Refund it there, then mark it refunded.` };
  const account = await accountForBill(row.provider, row.bill_id);
  if (!account)
    return { ok: false, error: `This was paid through ${gateway.name}, which this venue no longer has connected. Refund it there, then mark it refunded.` };
  const amount = roundMoney(row.refund_due - row.refunded);
  const { code, minorUnits } = region().currency;
  // What has been owed in all, so a retry of this refund is the same one
  // and a later one (another booking off the same payment) is new; and how
  // many the gateway accepted and then could not make, since a refund asked
  // for again after one failed is a new one too.
  const { failed } = (await getDb()
    .prepare("SELECT COUNT(*)::int AS failed FROM online_refunds WHERE payment_id = ? AND failed_at IS NOT NULL")
    .get(row.id)) as { failed: number };
  const idempotencyKey = `mysenam-refund-${row.id}-${Math.round(row.refund_due * 100)}${failed > 0 ? `-r${failed}` : ""}`;
  const claim = `claim:${idempotencyKey}`;
  const db = getDb();
  // Claimed before the gateway is asked: the amount counts as refunded, so a
  // hand mark or a second click meanwhile finds nothing owed and cannot send
  // it twice. Given back if the gateway refuses.
  const claimed = await db.transaction(async () => {
    const reserved = await db
      .prepare("UPDATE online_payments SET refunded = refunded + ? WHERE id = ? AND refunded + ? <= refund_due")
      .run(amount, row.id, amount);
    if (reserved.changes === 0) return false;
    const added = await db
      .prepare(
        `INSERT INTO online_refunds (payment_id, amount, provider_ref, pending, admin_id) VALUES (?, ?, ?, 1, ?)
         ON CONFLICT (provider_ref) DO NOTHING`
      )
      .run(row.id, amount, claim, adminId);
    if (added.changes === 0) throw new Error("CLAIMED");
    return true;
  })().catch(() => false);
  if (!claimed) return { ok: false, error: "That payment is being refunded, or was just marked refunded." };

  // Should the gateway throw, nobody knows what it did: the claim stays, and is asked again.
  const result = await gateway.refund(account, { billId: row.bill_id, amount, currency: { code, minorUnits }, idempotencyKey });
  // No clear answer: the claim stays, and the scheduler asks again under the same key (settleRefundClaims).
  if (!result.ok && result.unknown) return { ok: false, error: result.error, unknown: true };
  if (!result.ok) {
    await releaseClaim(row.id, amount, claim);
    return result;
  }
  await finishClaim(row.id, amount, claim, result.refundId, result.pending);
  return { ok: true, payment: await reread(row.id), pending: result.pending };
}

/** How money paid online for a booking a customer cancelled went back, or is to. */
export interface CancelRefund {
  how: OnlineRefunds;
  amount: number;
  /** Through the gateway, and it has not finished yet. */
  pending?: boolean;
  /** By staff: the date the venue says it will be refunded by. */
  dueBy?: string;
}

/**
 * A customer has cancelled these bookings: what is now owed back on what
 * they paid online goes back as the venue chose (lib/cancel-policy.ts). Where
 * that cannot happen — a gateway with no refund API or that refuses, credit
 * for a booking made without an account — it stays owed for staff, as before.
 */
export async function refundCancelled(
  bookingIds: number[],
  /** The venue called it off: the money goes back to the card where it can, not into credit the customer did not choose. */
  opts: { byVenue?: boolean } = {}
): Promise<CancelRefund[]> {
  if (bookingIds.length === 0) return [];
  const marks = bookingIds.map(() => "?").join(",");
  const rows = (await getDb()
    .prepare(
      `SELECT * FROM online_payments
        WHERE id IN (SELECT payment_id FROM online_payment_bookings WHERE booking_id IN (${marks}))
          AND venue_id IS NOT NULL AND purpose NOT IN ('invoice', 'pack') AND refund_due > refunded
        ORDER BY id`
    )
    .all(...bookingIds)) as PaymentRow[];
  const done: CancelRefund[] = [];
  for (const row of rows) {
    const amount = roundMoney(row.refund_due - row.refunded);
    const venuePolicy = await cancelPolicy(row.venue_id!);
    const policy = venuePolicy.onlineRefunds;
    const onlineRefunds = opts.byVenue && policy === "credit" ? "gateway" : policy;
    if (onlineRefunds === "gateway") {
      const sent = await refundOnline(row.id, row.venue_id!).catch(() => null);
      if (sent?.ok) {
        done.push({ how: "gateway", amount, ...(sent.pending ? { pending: true } : {}) });
        continue;
      }
      // Sent with no clear answer: it goes through when asked again, not by staff.
      if (sent && !sent.ok && sent.unknown) {
        done.push({ how: "gateway", amount, pending: true });
        continue;
      }
    } else if (onlineRefunds === "credit" && (await refundToCredit(row, bookingIds, amount))) {
      done.push({ how: "credit", amount });
      continue;
    }
    done.push({ how: "staff", amount, dueBy: refundClock(null, venuePolicy.refundWithinDays).dueBy });
  }
  return done;
}

/** What is owed on a payment, as stored credit at its venue for the account that booked. */
async function refundToCredit(row: PaymentRow, bookingIds: number[], amount: number): Promise<boolean> {
  const db = getDb();
  const booking = (await db
    .prepare(
      `SELECT b.id, b.code, b.user_id FROM bookings b JOIN online_payment_bookings pb ON pb.booking_id = b.id
        WHERE pb.payment_id = ? AND b.id IN (${bookingIds.map(() => "?").join(",")}) AND b.user_id IS NOT NULL
        ORDER BY b.id LIMIT 1`
    )
    .get(row.id, ...bookingIds)) as { id: number; code: string; user_id: number } | undefined;
  if (!booking) return false;
  try {
    // Keyed on what has been owed in all, like a gateway refund: the same cancellation twice is one credit.
    return await recordRefund(row, amount, `credit-${row.id}-${Math.round(row.refund_due * 100)}`, false, null, async () => {
      await db
        .prepare("INSERT INTO wallet_entries (user_id, amount, reason, booking_id, venue_id) VALUES (?, ?, ?, ?, ?)")
        // Into the same pot a top-up there would go: the venue's own, or the one spendable anywhere.
        .run(booking.user_id, amount, `Refund for ${booking.code}, as credit`, booking.id, creditScope() === "venue" ? row.venue_id : null);
    });
  } catch {
    return false;
  }
}


// ------------------------------------------------------------ shares of open games

/**
 * A player in somebody else's open game paying their share to the venue
 * (lib/games.ts). Towards the host's booking: what the host then owes is the
 * rest. Not once the court is paid for in full — that is between them.
 */
export async function startSharePayment(user: { id: number; name: string; phone: string; email: string }, gameId: number): Promise<StartResult> {
  const db = getDb();
  const row = (await db
    .prepare(
      `SELECT p.id AS player_id, p.status, p.paid_at, g.share::float AS share, b.id AS booking_id, b.code,
              b.status AS booking_status, b.payment_status, c.venue_id, c.name AS court_name, b.date, b.start_min, b.end_min
         FROM open_game_players p
         JOIN open_games g ON g.id = p.game_id
         JOIN bookings b ON b.id = g.booking_id
         JOIN courts c ON c.id = b.court_id
        WHERE g.id = ? AND p.user_id = ?`
    )
    .get(gameId, user.id)) as
    | {
        player_id: number;
        status: string;
        paid_at: string | null;
        share: number;
        booking_id: number;
        code: string;
        booking_status: string;
        payment_status: string;
        venue_id: number;
        court_name: string;
        date: string;
        start_min: number;
        end_min: number;
      }
    | undefined;
  if (!row || row.status !== "accepted") return { ok: false, error: "You are not in that game.", status: 404 };
  if (row.paid_at) return { ok: false, error: "Your share is paid already.", status: 409 };
  if (row.share <= 0) return { ok: false, error: "There is nothing to pay for this game.", status: 409 };
  if (row.booking_status !== "confirmed") return { ok: false, error: "That game is off.", status: 409 };
  if (row.payment_status === "paid")
    return { ok: false, error: "The court is paid for already: settle your share with the host.", status: 409 };
  const venue = (await getVenue(row.venue_id))!;
  if (!isOpen(venue))
    return { ok: false, error: `${venue.name} is not taking payment online at the moment.`, status: 409 };
  const account = await venueAccount(row.venue_id);
  if (!account) return { ok: false, error: `${venue.name} does not take payment online. Pay at the venue.`, status: 409 };

  const reusable = (await db
    .prepare(
      `SELECT * FROM online_payments WHERE game_player_id = ? AND purpose = 'share' AND status = 'pending'
          AND amount = ? AND created_at > datetime('now', '-1 day') ORDER BY id DESC LIMIT 1`
    )
    .get(row.player_id, row.share)) as PaymentRow | undefined;
  if (reusable) return { ok: true, url: reusable.url, amount: row.share, reused: true };

  let bill;
  try {
    bill = await openCheckout(account, {
      amount: row.share,
      name: user.name,
      email: user.email,
      mobile: toWhatsAppNumber(user.phone),
      description: `${venue.name}: share of ${row.court_name}, ${row.date} ${formatHour(hoursOf(row.start_min))}-${formatHour(hoursOf(row.end_min))} (${row.code})`,
      redirectUrl: `${await venueBaseUrl(row.venue_id)}/payments/return`,
      reference: { label: "Booking", value: row.code },
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "The payment page could not be opened.", status: 502 };
  }
  await db
    .prepare(
      `INSERT INTO online_payments (provider, bill_id, url, venue_id, amount, payer_name, payer_phone, purpose, game_player_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'share', ?)`
    )
    .run(account.provider, bill.id, bill.url, row.venue_id, row.share, user.name, user.phone, row.player_id);
  return { ok: true, url: bill.url, amount: row.share, reused: false };
}

/**
 * A share arrived. Counted towards the booking if the player is still in and
 * the court still unpaid; owed back if not — they left, the game went, or the
 * host paid for the whole court meanwhile.
 */
async function settleShare(row: PaymentRow): Promise<void> {
  const db = getDb();
  const target = (await db
    .prepare(
      `SELECT p.id, p.status, b.id AS booking_id, b.status AS booking_status, b.payment_status,
              b.total_price::float AS total_price, b.shares_paid::float AS shares_paid
         FROM open_game_players p JOIN open_games g ON g.id = p.game_id JOIN bookings b ON b.id = g.booking_id
        WHERE p.id = ?`
    )
    .get(row.game_player_id)) as
    | { id: number; status: string; booking_id: number; booking_status: string; payment_status: string; total_price: number; shares_paid: number }
    | undefined;
  if (!target || target.status !== "accepted" || target.booking_status !== "confirmed" || target.payment_status === "paid") {
    await db.prepare("UPDATE online_payments SET refund_due = amount WHERE id = ?").run(row.id);
    return;
  }
  await db.prepare("UPDATE open_game_players SET paid_at = datetime('now') WHERE id = ?").run(target.id);
  const sharesPaid = Math.round((target.shares_paid + Number(row.amount)) * 100) / 100;
  await db.prepare("UPDATE bookings SET shares_paid = ? WHERE id = ?").run(sharesPaid, target.booking_id);
  const court = (await db
    .prepare(
      `SELECT c.name, b.date, b.start_min, b.end_min, p.user_id FROM bookings b JOIN courts c ON c.id = b.court_id
         JOIN open_game_players p ON p.id = ? WHERE b.id = ?`
    )
    .get(target.id, target.booking_id)) as { name: string; date: string; start_min: number; end_min: number; user_id: number };
  await receiptPayment(row, {
    description: `Share of ${court.name}, ${court.date} ${formatHour(hoursOf(court.start_min))}–${formatHour(hoursOf(court.end_min))}`,
    userId: court.user_id,
    taxable: true,
  });
  // Shares alone covered the court: nothing is left for the host to pay.
  if (sharesPaid >= target.total_price)
    await db
      .prepare("UPDATE bookings SET payment_status = 'paid', paid_at = datetime('now'), paid_via = 'online' WHERE id = ?")
      .run(target.booking_id);
}

// ------------------------------------------------------------ shares of a split booking

/** A friend, through the booker's split link, paying one share to the venue (lib/splits.ts). No account needed. */
export async function startSplitPayment(
  token: string,
  payer: { name: unknown; phone: unknown; email?: unknown }
): Promise<StartResult> {
  const { splitByToken } = await import("./splits");
  const split = await splitByToken(token);
  if (!split) return { ok: false, error: "That link is not valid.", status: 404 };
  if (split.closed === "cancelled") return { ok: false, error: "That booking was cancelled.", status: 409 };
  if (split.closed === "paid") return { ok: false, error: "That booking is paid in full: settle up with the booker.", status: 409 };
  if (split.closed === "started") return { ok: false, error: "That booking has started: settle up with the booker.", status: 409 };
  if (split.closed === "full") return { ok: false, error: "Every share is paid already.", status: 409 };
  const name = typeof payer.name === "string" ? payer.name.trim().slice(0, 80) : "";
  const phone = typeof payer.phone === "string" ? payer.phone.trim() : "";
  const email = typeof payer.email === "string" && payer.email.trim() ? payer.email.trim() : null;
  if (name.length < 2 || phone.length < 7) return { ok: false, error: "Give your name and phone number.", status: 400 };
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "That email address does not look right.", status: 400 };
  const venue = (await getVenue(split.venueId))!;
  if (!isOpen(venue)) return { ok: false, error: `${venue.name} is not taking payment online at the moment.`, status: 409 };
  const account = await venueAccount(split.venueId);
  if (!account) return { ok: false, error: `${venue.name} does not take payment online.`, status: 409 };
  let bill;
  try {
    bill = await openCheckout(account, {
      amount: split.share,
      name,
      email: email ?? undefined,
      mobile: toWhatsAppNumber(phone),
      description: `${venue.name}: share of ${split.courtName}, ${split.date} ${formatHour(split.startHour)}-${formatHour(split.endHour)} (${split.code})`,
      redirectUrl: `${await venueBaseUrl(split.venueId)}/payments/return`,
      reference: { label: "Booking", value: split.code },
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "The payment page could not be opened.", status: 502 };
  }
  await getDb()
    .prepare(
      `INSERT INTO online_payments (provider, bill_id, url, venue_id, amount, payer_name, payer_phone, purpose, split_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'split', ?)`
    )
    .run(account.provider, bill.id, bill.url, split.venueId, split.share, name, phone, split.id);
  return { ok: true, url: bill.url, amount: split.share, reused: false };
}

// ------------------------------------------------------------ tournament entry fees

/** A player paying their tournament entry fee, online, to the venue running it. */
export async function startEntryPayment(user: { id: number; name: string; phone: string; email: string }, tournamentId: number): Promise<StartResult> {
  const db = getDb();
  const row = (await db
    .prepare(
      `SELECT e.id, e.status, e.paid_at, t.name, t.entry_fee::float AS fee, t.status AS t_status, t.venue_id, t.starts_on
         FROM tournament_entries e JOIN tournaments t ON t.id = e.tournament_id
        WHERE e.tournament_id = ? AND e.user_id = ? AND e.status <> 'withdrawn' ORDER BY e.id DESC LIMIT 1`
    )
    .get(tournamentId, user.id)) as
    | { id: number; status: string; paid_at: string | null; name: string; fee: number; t_status: string; venue_id: number; starts_on: string }
    | undefined;
  if (!row) return { ok: false, error: "You have not entered.", status: 404 };
  if (row.status !== "entered") return { ok: false, error: "You are on the waiting list: pay once you are in.", status: 409 };
  if (row.paid_at) return { ok: false, error: "Your entry fee is paid already.", status: 409 };
  if (row.fee <= 0) return { ok: false, error: "There is no entry fee.", status: 409 };
  if (row.t_status === "cancelled" || row.t_status === "finished") return { ok: false, error: "That tournament is over.", status: 409 };
  const venue = (await getVenue(row.venue_id))!;
  if (!isOpen(venue)) return { ok: false, error: `${venue.name} is not taking payment online at the moment.`, status: 409 };
  const account = await venueAccount(row.venue_id);
  if (!account) return { ok: false, error: `${venue.name} does not take payment online. Pay at the venue.`, status: 409 };

  const reusable = (await db
    .prepare(
      `SELECT * FROM online_payments WHERE tournament_entry_id = ? AND purpose = 'entry' AND status = 'pending'
          AND created_at > datetime('now', '-1 day') ORDER BY id DESC LIMIT 1`
    )
    .get(row.id)) as PaymentRow | undefined;
  if (reusable) return { ok: true, url: reusable.url, amount: row.fee, reused: true };

  let bill;
  try {
    bill = await openCheckout(account, {
      amount: row.fee,
      name: user.name,
      email: user.email,
      mobile: toWhatsAppNumber(user.phone),
      description: `${venue.name}: entry, ${row.name} (${row.starts_on})`,
      redirectUrl: `${await venueBaseUrl(row.venue_id)}/payments/return`,
      reference: { label: "Entry", value: `T${tournamentId}-${row.id}` },
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "The payment page could not be opened.", status: 502 };
  }
  await db
    .prepare(
      `INSERT INTO online_payments (provider, bill_id, url, venue_id, amount, payer_name, payer_phone, purpose, tournament_entry_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'entry', ?)`
    )
    .run(account.provider, bill.id, bill.url, row.venue_id, row.fee, user.name, user.phone, row.id);
  return { ok: true, url: bill.url, amount: row.fee, reused: false };
}

// ------------------------------------------------------------ credit top-ups

export const MIN_ONLINE_TOP_UP = 10;

/**
 * Whether credit can be bought online at this venue: where credit is the
 * venue's own (a marketplace), or on a single business's own copy. Never
 * where credit bought at one venue is spent at others on a marketplace —
 * that money would be the platform holding other venues' takings.
 */
export function onlineTopUpsAllowed(): boolean {
  return creditScope() === "venue" || !isMarketplace();
}

/** A customer buying credit online, into the venue's own account. */
export async function startTopUpPayment(
  user: { id: number; name: string; phone: string; email: string },
  venueId: number,
  amount: number
): Promise<StartResult> {
  if (!onlineTopUpsAllowed()) return { ok: false, error: "Credit is bought at the counter here.", status: 409 };
  if (!isAmount(amount, MIN_ONLINE_TOP_UP, MAX_TOP_UP))
    return { ok: false, error: `Top up ${money(MIN_ONLINE_TOP_UP)}–${MAX_TOP_UP}.`, status: 400 };
  const venue = await getVenue(venueId);
  if (!venue || !isOpen(venue)) return { ok: false, error: "That venue is not taking payment online at the moment.", status: 409 };
  const account = await venueAccount(venueId);
  if (!account) return { ok: false, error: `${venue.name} does not take payment online. Top up at the counter.`, status: 409 };
  let bill;
  try {
    bill = await openCheckout(account, {
      amount,
      name: user.name,
      email: user.email,
      mobile: toWhatsAppNumber(user.phone),
      description: `${venue.name}: credit top-up`,
      redirectUrl: `${await venueBaseUrl(venueId)}/payments/return`,
      reference: { label: "Top-up", value: `U${user.id}` },
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "The payment page could not be opened.", status: 502 };
  }
  await getDb()
    .prepare(
      `INSERT INTO online_payments (provider, bill_id, url, venue_id, amount, payer_name, payer_phone, purpose, topup_user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'topup', ?)`
    )
    .run(account.provider, bill.id, bill.url, venueId, amount, user.name, user.phone, user.id);
  return { ok: true, url: bill.url, amount, reused: false };
}

// ------------------------------------------------------------ gift vouchers

/**
 * Somebody buying a gift voucher online, into the venue's own account. Where
 * credit bought at one venue would be spent at others on a marketplace, as
 * with a top-up, only at the counter.
 */
export async function startVoucherPayment(input: VoucherInput): Promise<StartResult> {
  if (!onlineTopUpsAllowed()) return { ok: false, error: "Gift vouchers are sold at the counter here.", status: 409 };
  const venue = await getVenue(input.venueId);
  if (!venue || !isOpen(venue)) return { ok: false, error: "That venue is not taking payment online at the moment.", status: 409 };
  const account = await venueAccount(input.venueId);
  if (!account) return { ok: false, error: `${venue.name} sells gift vouchers at the counter.`, status: 409 };
  if (!input.buyerEmail?.trim()) return { ok: false, error: "An email address to send the voucher to is needed.", status: 400 };
  const made = await pendingVoucher(input);
  if (!made.ok) return { ...made, status: 400 };
  let bill;
  try {
    bill = await openCheckout(account, {
      amount: made.voucher.amount,
      name: made.voucher.buyerName,
      email: made.voucher.buyerEmail ?? "",
      mobile: made.voucher.buyerPhone ? toWhatsAppNumber(made.voucher.buyerPhone) : "",
      description: `${venue.name}: gift voucher`,
      redirectUrl: `${await venueBaseUrl(input.venueId)}/payments/return`,
      reference: { label: "Voucher", value: made.voucher.code },
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "The payment page could not be opened.", status: 502 };
  }
  await getDb()
    .prepare(
      `INSERT INTO online_payments (provider, bill_id, url, venue_id, amount, payer_name, payer_phone, purpose, voucher_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'voucher', ?)`
    )
    .run(account.provider, bill.id, bill.url, input.venueId, made.voucher.amount, made.voucher.buyerName, made.voucher.buyerPhone, made.voucher.id);
  return { ok: true, url: bill.url, amount: made.voucher.amount, reused: false };
}

// ------------------------------------------------------------ memberships

const ENGLISH = translator("en");

/** A customer joining, or renewing, on one of the venue's membership plans. */
export async function startMembershipPayment(
  user: { id: number; name: string; email: string },
  planId: number,
  /** Charge the plan's price again each period until stopped, where the venue's gateway can. */
  opts: { autoRenew?: boolean } = {}
): Promise<StartResult> {
  const joining = await joinTerms(user.id, planId);
  if (!joining.ok) return { ok: false, error: joining.error, code: joining.code, vars: joining.vars, status: 409 };
  const { plan, phone, startsOn, expiresOn, renewing } = joining.terms;
  // A private venue's door is its list, which a fee does not put anyone on.
  if ((await accessSettings(plan.venueId)).access === "private")
    return { ok: false, error: errorText(ENGLISH, "JOIN_NO_PLAN"), code: "JOIN_NO_PLAN", status: 409 };
  const venue = await getVenue(plan.venueId);
  const account = venue && isOpen(venue) ? await venueAccount(plan.venueId) : null;
  if (!venue || !account)
    return { ok: false, error: errorText(ENGLISH, "JOIN_OFFLINE"), code: "JOIN_OFFLINE", status: 409 };
  const autoRenew = opts.autoRenew === true;
  if (autoRenew && !gatewayFor(account.provider)?.subscriptions)
    return { ok: false, error: "This venue's payments cannot renew by themselves. Pay for one period instead.", status: 409 };
  let bill;
  try {
    bill = await openCheckout(account, {
      amount: plan.price,
      name: user.name,
      email: user.email,
      mobile: toWhatsAppNumber(phone),
      description: `${venue.name}: ${plan.name}, ${startsOn} to ${expiresOn}${renewing ? " (renewal)" : ""}`,
      redirectUrl: `${await venueBaseUrl(plan.venueId)}/payments/return`,
      reference: { label: "Membership", value: `U${user.id}` },
      ...(autoRenew ? { recurring: { months: plan.months } } : {}),
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "The payment page could not be opened.", status: 502 };
  }
  await getDb()
    .prepare(
      `INSERT INTO online_payments (provider, bill_id, url, venue_id, amount, payer_name, payer_phone, purpose, member_user_id, membership_plan_id, auto_renew)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'membership', ?, ?, ?)`
    )
    .run(account.provider, bill.id, bill.url, plan.venueId, plan.price, user.name, phone, user.id, plan.id, autoRenew ? 1 : 0);
  return { ok: true, url: bill.url, amount: plan.price, reused: false };
}

/**
 * The membership a settled fee buys, its dates worked out now rather than
 * when the page was opened, so a renewal paid late still runs on from the
 * old one. Null when there is nothing it can buy any more.
 */
async function makePaidMembership(row: PaymentRow): Promise<number | null> {
  if (!row.member_user_id || !row.membership_plan_id) return null;
  // A plan retired while they paid still gives what they paid for.
  const joining = await joinTerms(row.member_user_id, row.membership_plan_id, { retired: true, renewal: Boolean(row.subscription_id) });
  if (!joining.ok) return null;
  const { plan, phone, startsOn, expiresOn } = joining.terms;
  const user = (await getDb().prepare("SELECT name FROM users WHERE id = ?").get(row.member_user_id)) as { name: string } | undefined;
  if (!user) return null;
  const sold = await sellMembership({
    venueId: plan.venueId,
    holderName: user.name,
    holderPhone: phone,
    startsOn,
    expiresOn,
    // What they paid, which a plan's later price change does not rewrite.
    price: roundMoney(row.amount),
    userId: row.member_user_id,
    planId: plan.id,
    paidVia: paidVia("online", gatewayFor(row.provider)?.name) ?? undefined,
  });
  return sold.ok ? sold.membership.id : null;
}

// ------------------------------------------------------------ league fees

/** A player paying this season's league fee, online, to the venue running it. */
export async function startLeaguePayment(user: { id: number; name: string; phone: string; email: string }, leagueId: number): Promise<StartResult> {
  const db = getDb();
  const row = (await db
    .prepare(
      `SELECT lp.id, lp.paid_at, lp.withdrawn_at, s.number, l.name, l.fee::float AS fee, l.venue_id
         FROM league_places lp
         JOIN league_seasons s ON s.id = lp.season_id AND s.status = 'running'
         JOIN league_players p ON p.id = lp.player_id
         JOIN leagues l ON l.id = s.league_id
        WHERE l.id = ? AND p.user_id = ? AND p.status = 'active'`
    )
    .get(leagueId, user.id)) as
    | { id: number; paid_at: string | null; withdrawn_at: string | null; number: number; name: string; fee: number; venue_id: number }
    | undefined;
  if (!row || row.withdrawn_at) return { ok: false, error: "You are not in a box this season.", status: 404 };
  if (row.paid_at) return { ok: false, error: "This season's fee is paid already.", status: 409 };
  if (row.fee <= 0) return { ok: false, error: "There is no fee.", status: 409 };
  const venue = (await getVenue(row.venue_id))!;
  if (!isOpen(venue)) return { ok: false, error: `${venue.name} is not taking payment online at the moment.`, status: 409 };
  const account = await venueAccount(row.venue_id);
  if (!account) return { ok: false, error: `${venue.name} does not take payment online. Pay at the venue.`, status: 409 };

  const reusable = (await db
    .prepare(
      `SELECT * FROM online_payments WHERE league_place_id = ? AND purpose = 'league' AND status = 'pending'
          AND created_at > datetime('now', '-1 day') ORDER BY id DESC LIMIT 1`
    )
    .get(row.id)) as PaymentRow | undefined;
  if (reusable) return { ok: true, url: reusable.url, amount: row.fee, reused: true };

  let bill;
  try {
    bill = await openCheckout(account, {
      amount: row.fee,
      name: user.name,
      email: user.email,
      mobile: toWhatsAppNumber(user.phone),
      description: `${venue.name}: ${row.name}, season ${row.number}`,
      redirectUrl: `${await venueBaseUrl(row.venue_id)}/payments/return`,
      reference: { label: "League", value: `L${leagueId}-${row.id}` },
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "The payment page could not be opened.", status: 502 };
  }
  await db
    .prepare(
      `INSERT INTO online_payments (provider, bill_id, url, venue_id, amount, payer_name, payer_phone, purpose, league_place_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'league', ?)`
    )
    .run(account.provider, bill.id, bill.url, row.venue_id, row.fee, user.name, user.phone, row.id);
  return { ok: true, url: bill.url, amount: row.fee, reused: false };
}

// ------------------------------------------------------------ memberships that renew themselves

export interface Renewal {
  id: number;
  venueId: number;
  planId: number | null;
  /** When the membership its latest charge made runs out, and so when it charges again. */
  until: string | null;
}

/** Whose key checks word about this subscription: the venue's that sold it, at the same gateway. */
export async function accountForSubscription(provider: string, subscriptionId: string): Promise<GatewayAccount | null> {
  const sub = (await getDb()
    .prepare("SELECT venue_id, provider FROM membership_subscriptions WHERE subscription_id = ?")
    .get(subscriptionId)) as { venue_id: number; provider: string } | undefined;
  if (!sub || sub.provider !== provider) return null;
  const account = await accountRow(sub.venue_id);
  if (!account || account.provider !== provider) return null;
  return readAccount(account);
}

/**
 * The gateway charged a subscription again, or ended it. A charge is an
 * online payment of its own, settled like the first: the next membership,
 * run on from the last, and its receipt. Told twice, it counts once.
 */
export async function settleSubscription(provider: string, event: SubscriptionEvent): Promise<void> {
  const db = getDb();
  const sub = (await db
    .prepare("SELECT * FROM membership_subscriptions WHERE subscription_id = ? AND provider = ?")
    .get(event.subscriptionId, provider)) as
    | { id: number; venue_id: number; user_id: number | null; plan_id: number | null; status: string }
    | undefined;
  if (!sub) return;
  if (event.kind === "ended") {
    await db
      .prepare("UPDATE membership_subscriptions SET status = 'stopped', stopped_at = datetime('now') WHERE id = ? AND status = 'active'")
      .run(sub.id);
    return;
  }
  const user = sub.user_id
    ? ((await db.prepare("SELECT name FROM users WHERE id = ?").get(sub.user_id)) as { name: string } | undefined)
    : undefined;
  const amount = roundMoney(event.amountMinor / 10 ** region().currency.minorUnits);
  const added = await db
    .prepare(
      `INSERT INTO online_payments (provider, bill_id, url, venue_id, amount, payer_name, payer_phone, purpose,
         member_user_id, membership_plan_id, auto_renew, subscription_id)
       VALUES (?, ?, '', ?, ?, ?, ?, 'membership', ?, ?, 1, ?) ON CONFLICT (bill_id) DO NOTHING`
    )
    .run(provider, event.chargeId, sub.venue_id, amount, user?.name ?? null, sub.user_id ? await accountPhone(sub.user_id) : null,
      sub.user_id, sub.plan_id, event.subscriptionId);
  if (added.changes === 0) return;
  await settleBill({ billId: event.chargeId, paid: true, paidAt: event.paidAt });
  const made = (await db.prepare("SELECT membership_id FROM online_payments WHERE bill_id = ?").get(event.chargeId)) as {
    membership_id: number | null;
  };
  if (made.membership_id !== null)
    await db.prepare("UPDATE membership_subscriptions SET membership_id = ? WHERE id = ?").run(made.membership_id, sub.id);
}

/** Stop a subscription at the gateway and here. Why it could not be, or null. */
async function stopSubscription(subscriptionId: string): Promise<string | null> {
  const db = getDb();
  const sub = (await db
    .prepare("SELECT id, provider, status FROM membership_subscriptions WHERE subscription_id = ?")
    .get(subscriptionId)) as { id: number; provider: string; status: string } | undefined;
  const provider = sub?.provider ?? ((await db.prepare("SELECT provider FROM online_payments WHERE subscription_id = ? LIMIT 1").get(subscriptionId)) as { provider: string } | undefined)?.provider;
  const gateway = provider ? gatewayFor(provider) : null;
  if (!gateway?.cancelSubscription) return "That subscription cannot be stopped from here.";
  const venue = (await db.prepare("SELECT venue_id FROM online_payments WHERE subscription_id = ? LIMIT 1").get(subscriptionId)) as
    | { venue_id: number }
    | undefined;
  const row = venue ? await accountRow(venue.venue_id) : null;
  if (!row || row.provider !== provider) return `The venue no longer has ${gateway.name} connected. Stop it in ${gateway.name}.`;
  const account = readAccount(row);
  if (!account) return `The venue's ${gateway.name} keys cannot be read on this install. Stop it in ${gateway.name}.`;
  const why = await gateway.cancelSubscription(account, subscriptionId);
  if (why) return why;
  if (sub)
    await db
      .prepare("UPDATE membership_subscriptions SET status = 'stopped', stopped_at = datetime('now') WHERE id = ? AND status = 'active'")
      .run(sub.id);
  return null;
}

/** Whether a membership bought online at this venue can renew itself: its gateway has subscriptions. */
export async function renewsByItself(venueId: number): Promise<boolean> {
  const account = await venueAccount(venueId);
  return Boolean(account && gatewayFor(account.provider)?.subscriptions);
}

/** A customer's membership at this venue that renews itself, if they have one. */
export async function renewalFor(userId: number, venueId: number): Promise<Renewal | null> {
  const row = (await getDb()
    .prepare(
      `SELECT s.id, s.venue_id, s.plan_id, m.expires_on FROM membership_subscriptions s
         LEFT JOIN memberships m ON m.id = s.membership_id
        WHERE s.user_id = ? AND s.venue_id = ? AND s.status = 'active' ORDER BY s.id DESC LIMIT 1`
    )
    .get(userId, venueId)) as { id: number; venue_id: number; plan_id: number | null; expires_on: string | null } | undefined;
  return row ? { id: row.id, venueId: row.venue_id, planId: row.plan_id, until: row.expires_on } : null;
}

/** The member stops renewing: the membership they have runs to its end, and nothing more is charged. */
export async function stopRenewal(userId: number, renewalId: number): Promise<{ ok: true } | { ok: false; error: string }> {
  const row = (await getDb()
    .prepare("SELECT subscription_id FROM membership_subscriptions WHERE id = ? AND user_id = ? AND status = 'active'")
    .get(renewalId, userId)) as { subscription_id: string } | undefined;
  if (!row) return { ok: false, error: "That membership is not renewing." };
  const why = await stopSubscription(row.subscription_id);
  return why ? { ok: false, error: why } : { ok: true };
}

/** Staff cancel a membership: it stops renewing too. */
export async function stopRenewalOf(membershipId: number): Promise<string | null> {
  const row = (await getDb()
    .prepare("SELECT subscription_id FROM membership_subscriptions WHERE membership_id = ? AND status = 'active'")
    .get(membershipId)) as { subscription_id: string } | undefined;
  return row ? stopSubscription(row.subscription_id) : null;
}

// ------------------------------------------------------------ disputes (chargebacks)

/** Every venue's account at this gateway that can be read: to find whose signing key a report checks out under. */
export async function gatewayAccounts(provider: string): Promise<(GatewayAccount & { venueId: number })[]> {
  const rows = (await getDb().prepare("SELECT * FROM venue_payment_accounts WHERE provider = ?").all(provider)) as AccountRow[];
  return rows
    .map((row) => {
      const account = readAccount(row);
      return account ? { ...account, venueId: row.venue_id } : null;
    })
    .filter((a): a is GatewayAccount & { venueId: number } => a !== null);
}

export interface PaymentDispute {
  id: number;
  paymentId: number;
  providerDisputeId: string;
  amount: number;
  reason: string;
  status: string;
  dueBy: string | null;
  outcome: "won" | "lost" | null;
  openedAt: string;
  payerName: string | null;
  bookingCodes: string[];
}

/** Paid to the platform rather than to a venue: a venue's monthly invoice, a WhatsApp pack. */
const PLATFORM_PURPOSES = ["invoice", "pack"];

/**
 * A dispute written down against its payment, once, and kept up to date as
 * it moves. Gateways repeat themselves, sometimes twice at once: whichever
 * copy writes the dispute down first says it opened, and whichever moves its
 * outcome acts on it. Each is one statement, inside the transaction that acts.
 */
async function noteDispute(
  paymentId: number,
  amount: number,
  event: DisputeEvent,
  lost: () => Promise<void> = async () => {}
): Promise<{ opened: boolean; decided: "won" | "lost" | null }> {
  const db = getDb();
  return withTransaction(async () => {
    const inserted = await db
      .prepare(
        `INSERT INTO payment_disputes (payment_id, provider_dispute_id, amount, reason, status, due_by)
         VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (provider_dispute_id) DO NOTHING RETURNING id`
      )
      .get(paymentId, event.disputeId, amount, event.reason, event.status, event.dueBy);
    if (!inserted)
      await db
        .prepare(
          `UPDATE payment_disputes SET status = ?, due_by = COALESCE(?, due_by), updated_at = datetime('now')
            WHERE provider_dispute_id = ?`
        )
        .run(event.status, event.dueBy, event.disputeId);
    const moved = event.outcome
      ? await db
          .prepare(
            `UPDATE payment_disputes SET outcome = ?, updated_at = datetime('now')
              WHERE provider_dispute_id = ? AND outcome IS DISTINCT FROM ? RETURNING id`
          )
          .get(event.outcome, event.disputeId, event.outcome)
      : undefined;
    if (moved && event.outcome === "lost") await lost();
    return { opened: Boolean(inserted), decided: moved ? event.outcome : null };
  });
}

/**
 * A venue has disputed, with its bank, what it paid the platform: a monthly
 * invoice or a WhatsApp pack, paid through the platform's own gateway
 * account. Written down once, and the platform owners told by email when it
 * opens and when it is decided, since only they can answer it, in that
 * account's dashboard. A lost one changes nothing here by itself: the owners
 * decide whether the invoice is owed again or the pack is taken back.
 */
export async function recordPlatformDispute(provider: string, billId: string, event: DisputeEvent): Promise<boolean> {
  const db = getDb();
  const payment = (await db.prepare("SELECT * FROM online_payments WHERE provider = ? AND bill_id = ?").get(provider, billId)) as
    | PaymentRow
    | undefined;
  if (!payment || !PLATFORM_PURPOSES.includes(payment.purpose)) return false;
  const amount = roundMoney(event.amountMinor / 10 ** region().currency.minorUnits);
  const { opened, decided } = await noteDispute(payment.id, amount, event);
  const venue = payment.venue_id === null ? null : await getVenue(payment.venue_id);
  const who = venue?.name ?? payment.payer_name ?? "A venue";
  const what =
    payment.purpose === "invoice" && payment.invoice_id !== null
      ? `its invoice (number ${payment.invoice_id})`
      : payment.purpose === "pack"
        ? "a WhatsApp pack"
        : "a payment";
  const gateway = gatewayFor(provider)?.name ?? provider;
  if (opened)
    await tellOwners(
      `A venue has disputed a payment to ${siteName()}: ${money(amount)}`,
      [
        `${who} has disputed ${money(amount)} paid online for ${what} with their bank (reason given: ${event.reason.replace(/_/g, " ")}).`,
        event.dueBy ? `Answer it in the platform's ${gateway} dashboard by ${event.dueBy.slice(0, 10)}.` : `Answer it in the platform's ${gateway} dashboard.`,
        "Nothing changes here on its own: if the bank decides for the venue, decide whether the invoice is owed again or the pack taken back.",
      ].join("\n\n")
    );
  if (decided && !opened)
    await tellOwners(
      `Dispute ${decided}: ${money(amount)} from ${who}`,
      decided === "won"
        ? `The bank decided for ${siteName()}: the ${money(amount)} ${who} paid for ${what} stays.`
        : `The bank decided for ${who}: ${money(amount)} paid for ${what} has gone back to them. It still shows as paid here; decide whether it is owed again.`
    );
  return true;
}

/**
 * A customer has disputed a payment with their bank. Written down against the
 * payment, once, and kept up to date as it moves. Opened: the venue's staff
 * are told by email, with the date to answer by, since only the venue can
 * answer it (in the gateway's dashboard). Lost: the money went back to the
 * customer, so the bookings it paid for are unpaid again and its receipt is
 * credited; staff collect at the counter or let them go. Won: nothing changes.
 */
export async function recordDispute(provider: string, billId: string, event: DisputeEvent): Promise<PaymentDispute | null> {
  const db = getDb();
  const payment = (await db.prepare("SELECT * FROM online_payments WHERE provider = ? AND bill_id = ?").get(provider, billId)) as
    | PaymentRow
    | undefined;
  if (!payment || payment.venue_id === null) return null;
  // What a venue paid the platform is the platform's to answer.
  if (PLATFORM_PURPOSES.includes(payment.purpose)) return null;
  const minor = region().currency.minorUnits;
  const amount = roundMoney(event.amountMinor / 10 ** minor);
  const { opened, decided } = await noteDispute(payment.id, amount, event, () => disputeLost(payment, amount));
  const venue = await getVenue(payment.venue_id);
  const name = venue?.name ?? "your venue";
  const gateway = gatewayFor(provider)?.name ?? provider;
  if (opened)
    await tellVenueStaff(
      payment.venue_id,
      `A customer has disputed a payment: ${money(amount)}`,
      [
        `${payment.payer_name ?? "A customer"} has disputed ${money(amount)} paid online to ${name} with their bank (reason given: ${event.reason.replace(/_/g, " ")}).`,
        event.dueBy ? `Answer it in your ${gateway} dashboard by ${event.dueBy.slice(0, 10)}, with whatever shows the booking was real and played: the booking, the check-in, messages.` : `Answer it in your ${gateway} dashboard.`,
        "If the bank decides for the customer, the money goes back to them and the booking shows as unpaid again.",
      ].join("\n\n")
    );
  if (decided && !opened)
    await tellVenueStaff(
      payment.venue_id,
      `Dispute ${decided}: ${money(amount)}`,
      decided === "won"
        ? `The bank decided for ${name}: the ${money(amount)} stays yours.`
        : `The bank decided for the customer: ${money(amount)} has gone back to them. What it paid for is owed again: a booking shows as unpaid for that much.`
    );
  return (await disputesFor(payment.venue_id)).find((d) => d.providerDisputeId === event.disputeId) ?? null;
}

/**
 * The money went back, all of it or the part disputed: what it paid for is
 * owed again for that much, and its receipt is credited for it.
 *
 * A booking it paid in full keeps its receipt as a document of its own, dated
 * when it was paid, so the sale stays in that period and the credit note
 * falls in this one; the booking is unpaid for what was taken back. A deposit,
 * or a part paid before a share was handed back, stops counting towards its
 * booking by as much.
 */
async function disputeLost(payment: PaymentRow, disputed: number): Promise<void> {
  const db = getDb();
  const paid = Number(payment.amount);
  const share = paid > 0 ? Math.min(1, disputed / paid) : 1;
  const credit = new Set<string>();
  const linked = (await db
    .prepare(
      `SELECT b.id, b.status, b.payment_status, b.paid_via, b.paid_at, pb.amount::float AS part
         FROM online_payment_bookings pb JOIN bookings b ON b.id = pb.booking_id WHERE pb.payment_id = ?`
    )
    .all(payment.id)) as {
    id: number;
    status: string;
    payment_status: string;
    paid_via: string | null;
    paid_at: string | null;
    part: number | null;
  }[];
  for (const b of linked) {
    if (payment.deposit === 0 && b.payment_status === "paid" && b.paid_via === "online") {
      const source = `booking-paid:${b.id}:${payment.id}`;
      const receipt = await keepBookingReceipt(b.id, source, b.paid_at);
      const kept = receipt ? roundMoney(receipt.total * (1 - share)) : 0;
      if (receipt) credit.add(source);
      await db
        .prepare(
          `UPDATE bookings SET payment_status = 'unpaid', paid_via = NULL, paid_at = NULL,
                  shares_paid = shares_paid + ?, deposit_paid = deposit_paid + ? WHERE id = ?`
        )
        .run(kept, kept, b.id);
      continue;
    }
    const source = payment.deposit === 1 ? `payment:${payment.id}` : `booking-part:${b.id}:${payment.id}`;
    if (!(await documentFor(source))) continue;
    credit.add(source);
    const part = roundMoney(Number(b.part ?? 0) * share);
    // A link made before each booking's part was recorded: nothing to unpay it by.
    if (b.payment_status === "paid" && part <= 0) continue;
    if (b.payment_status === "paid") {
      // Called off since: what was owed back was settled then. Paid the rest
      // online: that payment's own refund rules hang on the booking being
      // paid online, so it stands and the venue is told what went back.
      if (b.status === "cancelled" || b.paid_via === "online") continue;
      // Paid the rest at the counter, with credit or with a pass: what was
      // paid that way stands, on a receipt of its own dated when it was paid;
      // the booking is unpaid for the part that went back.
      const kept = await keepBookingReceipt(b.id, `booking-paid:${b.id}:${payment.id}`, b.paid_at);
      await db
        .prepare(
          `UPDATE bookings SET payment_status = 'unpaid', paid_via = NULL, paid_at = NULL,
                  shares_paid = GREATEST(0, shares_paid - ?) + ?, deposit_paid = GREATEST(0, deposit_paid - ?) + ? WHERE id = ?`
        )
        .run(part, kept?.total ?? 0, part, kept?.total ?? 0, b.id);
      continue;
    }
    await db
      .prepare("UPDATE bookings SET shares_paid = GREATEST(0, shares_paid - ?), deposit_paid = GREATEST(0, deposit_paid - ?) WHERE id = ?")
      .run(part, part, b.id);
  }
  if (linked.length === 0) credit.add(`payment:${payment.id}`);
  for (const source of credit) await creditReceipt(source, "receipt.why.disputed", share);
  await takeBackWhatItBought(payment, roundMoney(paid * share));
  // The bank has given that much back: it is no longer owed, whatever happens to what it paid for.
  await db
    .prepare(
      `UPDATE online_payments SET refunded = LEAST(amount, refunded + ?),
              refund_due = GREATEST(refund_due, LEAST(amount, refunded + ?)) WHERE id = ?`
    )
    .run(disputed, disputed, payment.id);
}

/**
 * The money behind a payment went back to the cardholder through the bank:
 * what it bought is taken back too, as it would be for a refund, as far as
 * the money that went back. Credit already spent leaves the account below
 * nothing, settled by the next top-up or at the counter. A membership, a
 * tournament entry or a league place is not divisible, and goes on any loss.
 */
async function takeBackWhatItBought(payment: PaymentRow, amount: number): Promise<void> {
  const db = getDb();
  const whole = amount >= Number(payment.amount) - 0.005;
  const scope = creditScope() === "venue" ? payment.venue_id : null;
  const { unpayShare } = await import("./games");
  switch (payment.purpose) {
    case "topup":
      if (payment.topup_user_id)
        await db
          .prepare("INSERT INTO wallet_entries (user_id, amount, reason, venue_id) VALUES (?, ?, 'Top-up charged back', ?)")
          .run(payment.topup_user_id, -amount, scope);
      break;
    case "voucher": {
      if (payment.voucher_id == null) break;
      // Not yet used: void, or worth less by what went back.
      if (!whole) {
        const cut = await db
          .prepare("UPDATE gift_vouchers SET amount = GREATEST(0, amount - ?) WHERE id = ? AND status = 'active' RETURNING id")
          .get(amount, payment.voucher_id);
        if (cut) break;
      }
      const voucher = (await db
        .prepare("UPDATE gift_vouchers SET status = 'void' WHERE id = ? AND status IN ('active', 'redeemed') RETURNING redeemed_by, status")
        .get(payment.voucher_id)) as { redeemed_by: number | null } | undefined;
      // Already turned into credit: that credit goes.
      if (voucher?.redeemed_by)
        await db
          .prepare("INSERT INTO wallet_entries (user_id, amount, reason, venue_id) VALUES (?, ?, 'Gift voucher charged back', ?)")
          .run(voucher.redeemed_by, -amount, scope);
      break;
    }
    case "membership":
      if (payment.membership_id != null)
        await db.prepare("UPDATE memberships SET status = 'void' WHERE id = ?").run(payment.membership_id);
      if (payment.subscription_id) await stopSubscription(payment.subscription_id);
      break;
    case "share": {
      const place = (await db
        .prepare("SELECT g.booking_id FROM open_game_players p JOIN open_games g ON g.id = p.game_id WHERE p.id = ? AND p.paid_at IS NOT NULL")
        .get(payment.game_player_id)) as { booking_id: number } | undefined;
      if (!place) break;
      if (whole) await db.prepare("UPDATE open_game_players SET paid_at = NULL WHERE id = ?").run(payment.game_player_id);
      await unpayShare(place.booking_id, amount);
      break;
    }
    case "split": {
      if (payment.split_id == null || Number(payment.refund_due) >= Number(payment.amount)) break;
      const split = (await db.prepare("SELECT booking_id FROM booking_splits WHERE id = ?").get(payment.split_id)) as
        | { booking_id: number }
        | undefined;
      if (split) await unpayShare(split.booking_id, amount);
      break;
    }
    case "entry":
      if (payment.tournament_entry_id != null)
        await db.prepare("UPDATE tournament_entries SET paid_at = NULL WHERE id = ?").run(payment.tournament_entry_id);
      break;
    case "league":
      if (payment.league_place_id != null)
        await db.prepare("UPDATE league_places SET paid_at = NULL WHERE id = ?").run(payment.league_place_id);
      break;
  }
}

/** A venue's disputes: those still open first, then the last few decided. */
export async function disputesFor(venueId: number): Promise<PaymentDispute[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT d.*, p.payer_name,
              (SELECT STRING_AGG(b.code, ', ') FROM online_payment_bookings pb JOIN bookings b ON b.id = pb.booking_id WHERE pb.payment_id = p.id) AS codes
         FROM payment_disputes d JOIN online_payments p ON p.id = d.payment_id
        WHERE p.venue_id = ? AND p.purpose NOT IN ('invoice', 'pack')
        ORDER BY (d.outcome IS NULL) DESC, d.id DESC LIMIT 50`
    )
    .all(venueId)) as {
    id: number;
    payment_id: number;
    provider_dispute_id: string;
    amount: number | string;
    reason: string;
    status: string;
    due_by: string | null;
    outcome: "won" | "lost" | null;
    opened_at: string;
    payer_name: string | null;
    codes: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    paymentId: r.payment_id,
    providerDisputeId: r.provider_dispute_id,
    amount: Number(r.amount),
    reason: r.reason,
    status: r.status,
    dueBy: r.due_by,
    outcome: r.outcome,
    openedAt: r.opened_at,
    payerName: r.payer_name,
    bookingCodes: r.codes ? r.codes.split(", ") : [],
  }));
}
