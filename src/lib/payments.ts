import { isOpen, venueIsOpen } from "./listing";
import { creditScope, isMarketplace } from "./mode";
import { getDb } from "./db";
import { BillResult, BillplzAccount, createBill } from "./billplz";
import { seal, unseal } from "./secrets";
import { findBooking, getCourt, getVenue } from "./store";
import { baseUrl } from "./outbox";
import { toWhatsAppNumber } from "./transports";
import { formatHour } from "./time";
import { Booking, MAX_TOP_UP } from "./types";
import { platformAccount, settleInvoice } from "./billing";
import { settlePack } from "./whatsapp-credit";
import { notifyBookingConfirmed, notifyPaid } from "./notify";
import { extendHolds } from "./holds";
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

async function accountRow(venueId: number): Promise<AccountRow | undefined> {
  return await getDb().prepare("SELECT * FROM venue_payment_accounts WHERE venue_id = ?").get(venueId) as
    | AccountRow
    | undefined;
}

export async function paymentSettings(venueId: number): Promise<PaymentSettings> {
  const row = await accountRow(venueId);
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
export async function venueAccount(venueId: number): Promise<BillplzAccount | null> {
  const row = await accountRow(venueId);
  if (!row || row.enabled !== 1) return null;
  const apiKey = unseal(row.api_key);
  const xSignatureKey = unseal(row.x_signature_key);
  if (!apiKey || !xSignatureKey) return null;
  return { apiKey, collectionId: row.collection_id, xSignatureKey, sandbox: row.sandbox === 1 };
}

export async function takesPaymentOnline(venueId: number): Promise<boolean> {
  return (await venueAccount(venueId)) !== null && (await venueIsOpen(venueId));
}

export type SettingsResult = { ok: true; settings: PaymentSettings } | { ok: false; error: string };

/**
 * Set a venue's gateway account. The keys may be left out to keep the ones
 * already stored, so turning it off or switching to sandbox does not mean
 * finding them again.
 */
export async function savePaymentSettings(
  venueId: number,
  input: {
    apiKey?: string;
    collectionId: string;
    xSignatureKey?: string;
    sandbox: boolean;
    enabled: boolean;
  }
): Promise<SettingsResult> {
  if (!await getVenue(venueId)) return { ok: false, error: "Venue not found." };
  const existing = await accountRow(venueId);
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

  await getDb()
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
  purpose: "booking" | "invoice" | "share" | "entry" | "league" | "pack" | "topup";
  invoice_id: number | null;
  game_player_id: number | null;
  tournament_entry_id: number | null;
  league_place_id: number | null;
  pack_id: number | null;
  topup_user_id?: number | null;
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
  /** A customer paying for bookings, a player paying their share of somebody's, or a venue its invoice. */
  purpose: "booking" | "invoice" | "share" | "entry" | "league" | "pack" | "topup";
}

async function toPayment(r: PaymentRow): Promise<OnlinePayment> {
  const codes = await getDb()
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

export async function paymentByBill(billId: string): Promise<OnlinePayment | null> {
  const row = await getDb().prepare("SELECT * FROM online_payments WHERE bill_id = ?").get(billId) as
    | PaymentRow
    | undefined;
  return row ? await toPayment(row) : null;
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

  // Pressing the button twice, or coming back to it, should not make a second
  // bill for the same thing.
  const ids = due.map((b) => b.id).sort((a, b) => a - b);
  // A held booking stays held while they are on the payment page.
  await extendHolds(ids);
  const reusable = await pendingPaymentFor(ids, amount);
  if (reusable) return { ok: true, url: reusable.url, amount, reused: true };

  const first = due[0];
  const court = (await getCourt(first.courtId))!;
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
      redirectUrl: `${await venueBaseUrl(venueId)}/payments/return`,
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
  await db.transaction(async () => {
    const info = await db
      .prepare(
        `INSERT INTO online_payments (provider, bill_id, url, venue_id, amount, payer_name, payer_phone)
         VALUES ('billplz', ?, ?, ?, ?, ?, ?)`
      )
      .run(bill.id, bill.url, venueId, amount, first.name, first.phone);
    const link = db.prepare(
      "INSERT INTO online_payment_bookings (payment_id, booking_id) VALUES (?, ?)"
    );
    for (const id of ids) await link.run(info.lastInsertRowid, id);
  })();
  return { ok: true, url: bill.url, amount, reused: false };
}

/** A bill already made for exactly these bookings, still unpaid and recent. */
async function pendingPaymentFor(bookingIds: number[], amount: number): Promise<PaymentRow | null> {
  const candidates = await getDb()
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
      await getDb()
        .prepare("SELECT booking_id FROM online_payment_bookings WHERE payment_id = ? ORDER BY booking_id")
        .all(row.id) as { booking_id: number }[]
    ).map((r) => r.booking_id);
    if (linked.length === bookingIds.length && linked.every((id, i) => id === bookingIds[i]))
      return row;
  }
  return null;
}

/** Whose key checks a callback or redirect for this bill. */
export async function accountForBill(billId: string): Promise<BillplzAccount | null> {
  const row = await getDb()
    .prepare("SELECT venue_id, purpose FROM online_payments WHERE bill_id = ?")
    .get(billId) as { venue_id: number | null; purpose: string } | undefined;
  if (!row) return null;
  // A venue's fee was billed to the platform's account, and is checked with its key.
  // So was a venue's WhatsApp pack.
  if (row.purpose === "invoice" || row.purpose === "pack") return platformAccount();
  if (row.venue_id === null) return null;
  // Checked even when the venue has since switched online payment off: a bill
  // it already sent can still be paid, and that money still arrived.
  const account = await accountRow(row.venue_id);
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
export async function settleBill(result: BillResult): Promise<Settled | null> {
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
      // Withdrawn, or the tournament called off, while they paid: owed back.
      const entry = (await db
        .prepare(
          `SELECT e.status, t.status AS t_status FROM tournament_entries e JOIN tournaments t ON t.id = e.tournament_id WHERE e.id = ?`
        )
        .get(row.tournament_entry_id)) as { status: string; t_status: string } | undefined;
      if (!entry || entry.status === "withdrawn" || entry.t_status === "cancelled")
        await db.prepare("UPDATE online_payments SET refund_due = amount WHERE id = ?").run(row.id);
      else await db.prepare("UPDATE tournament_entries SET paid_at = datetime('now') WHERE id = ?").run(row.tournament_entry_id);
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
      else await db.prepare("UPDATE league_places SET paid_at = datetime('now') WHERE id = ?").run(row.league_place_id);
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
      } else if (claimed.changes === 1) {
        // The account went away while they paid: owed back.
        await db.prepare("UPDATE online_payments SET refund_due = amount WHERE id = ?").run(row.id);
      }
    })();
    const fresh = await db.prepare("SELECT * FROM online_payments WHERE id = ?").get(row.id) as PaymentRow;
    return { payment: await toPayment(fresh), newlyPaid: [] };
  }

  if (row.purpose === "pack") {
    await db.transaction(async () => {
      const claimed = await db
        .prepare("UPDATE online_payments SET status = 'paid', paid_at = datetime('now') WHERE id = ? AND status = 'pending'")
        .run(row.id);
      if (claimed.changes === 1 && row.pack_id !== null) await settlePack(row.pack_id, "online");
    })();
    const fresh = await db.prepare("SELECT * FROM online_payments WHERE id = ?").get(row.id) as PaymentRow;
    return { payment: await toPayment(fresh), newlyPaid: [] };
  }

  if (row.purpose === "invoice") {
    await db.transaction(async () => {
      const claimed = await db
        .prepare("UPDATE online_payments SET status = 'paid', paid_at = datetime('now') WHERE id = ? AND status = 'pending'")
        .run(row.id);
      if (claimed.changes === 1 && row.invoice_id !== null) await settleInvoice(row.invoice_id);
    })();
    const fresh = await db.prepare("SELECT * FROM online_payments WHERE id = ?").get(row.id) as PaymentRow;
    return { payment: await toPayment(fresh), newlyPaid: [] };
  }

  const paidAt = new Date().toISOString();
  const newlyPaid: number[] = [];
  await db.transaction(async () => {
    const claimed = await db
      .prepare("UPDATE online_payments SET status = 'paid', paid_at = ? WHERE id = ? AND status = 'pending'")
      .run(paidAt, row.id);
    if (claimed.changes === 0) return;

    const linked = await db
      .prepare(`
        SELECT b.id, b.status, b.payment_status, b.total_price
          FROM online_payment_bookings pb JOIN bookings b ON b.id = pb.booking_id
         WHERE pb.payment_id = ?
      `)
      .all(row.id) as { id: number; status: string; payment_status: string; total_price: number }[];
    let owed = 0;
    for (const b of linked) {
      if (b.status === "confirmed" && b.payment_status === "unpaid") {
        await db.prepare(
          "UPDATE bookings SET payment_status = 'paid', paid_at = ?, paid_via = 'online' WHERE id = ?"
        ).run(paidAt, b.id);
        newlyPaid.push(b.id);
      } else {
        owed += b.total_price;
      }
    }
    if (owed > 0)
      await db.prepare("UPDATE online_payments SET refund_due = refund_due + ? WHERE id = ?").run(owed, row.id);
  })();

  const fresh = await db.prepare("SELECT * FROM online_payments WHERE id = ?").get(row.id) as PaymentRow;
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
    for (const group of Map.groupBy(held, (b) => b.seriesCode ?? b.code).values()) {
      const stored = (await db.prepare("SELECT locale FROM bookings WHERE id = ?").get(group[0].id)) as { locale: string | null };
      await notifyBookingConfirmed(
        group.map((b) => ({ ...b, holdUntil: null })),
        stored.locale === "ms" ? "ms" : "en",
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

/** Payments with money still to go back, oldest first. */
export async function refundsOwed(venueId: number): Promise<OnlinePayment[]> {
  const rows = (await getDb()
    .prepare(
      "SELECT * FROM online_payments WHERE venue_id = ? AND purpose = 'booking' AND refund_due > refunded ORDER BY id"
    )
    .all(venueId)) as PaymentRow[];
  return Promise.all(rows.map(toPayment));
}

/** Staff have made the refund in the gateway. */
export async function markRefunded(
  paymentId: number,
  venueId: number
): Promise<{ ok: true; payment: OnlinePayment } | { ok: false; error: string }> {
  const db = getDb();
  const done = await db
    .prepare(
      "UPDATE online_payments SET refunded = refund_due WHERE id = ? AND venue_id = ? AND refund_due > refunded"
    )
    .run(paymentId, venueId);
  if (done.changes === 0) return { ok: false, error: "Nothing is owed back on that payment." };
  return {
    ok: true,
    payment: await toPayment(await db.prepare("SELECT * FROM online_payments WHERE id = ?").get(paymentId) as PaymentRow),
  };
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
              b.status AS booking_status, b.payment_status, c.venue_id, c.name AS court_name, b.date, b.start_hour, b.end_hour
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
        start_hour: number;
        end_hour: number;
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
    bill = await createBill(account, {
      amount: row.share,
      name: user.name,
      email: user.email,
      mobile: toWhatsAppNumber(user.phone),
      description: `${venue.name}: share of ${row.court_name}, ${row.date} ${formatHour(row.start_hour)}-${formatHour(row.end_hour)} (${row.code})`,
      callbackUrl: `${baseUrl()}/api/payments/billplz/callback`,
      redirectUrl: `${await venueBaseUrl(row.venue_id)}/payments/return`,
      reference: { label: "Booking", value: row.code },
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "The payment page could not be opened.", status: 502 };
  }
  await db
    .prepare(
      `INSERT INTO online_payments (provider, bill_id, url, venue_id, amount, payer_name, payer_phone, purpose, game_player_id)
       VALUES ('billplz', ?, ?, ?, ?, ?, ?, 'share', ?)`
    )
    .run(bill.id, bill.url, row.venue_id, row.share, user.name, user.phone, row.player_id);
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
  // Shares alone covered the court: nothing is left for the host to pay.
  if (sharesPaid >= target.total_price)
    await db
      .prepare("UPDATE bookings SET payment_status = 'paid', paid_at = datetime('now'), paid_via = 'online' WHERE id = ?")
      .run(target.booking_id);
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
    bill = await createBill(account, {
      amount: row.fee,
      name: user.name,
      email: user.email,
      mobile: toWhatsAppNumber(user.phone),
      description: `${venue.name}: entry, ${row.name} (${row.starts_on})`,
      callbackUrl: `${baseUrl()}/api/payments/billplz/callback`,
      redirectUrl: `${await venueBaseUrl(row.venue_id)}/payments/return`,
      reference: { label: "Entry", value: `T${tournamentId}-${row.id}` },
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "The payment page could not be opened.", status: 502 };
  }
  await db
    .prepare(
      `INSERT INTO online_payments (provider, bill_id, url, venue_id, amount, payer_name, payer_phone, purpose, tournament_entry_id)
       VALUES ('billplz', ?, ?, ?, ?, ?, ?, 'entry', ?)`
    )
    .run(bill.id, bill.url, row.venue_id, row.fee, user.name, user.phone, row.id);
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
  if (!Number.isInteger(amount) || amount < MIN_ONLINE_TOP_UP || amount > MAX_TOP_UP)
    return { ok: false, error: `Top up RM${MIN_ONLINE_TOP_UP}–${MAX_TOP_UP}, in whole ringgit.`, status: 400 };
  const venue = await getVenue(venueId);
  if (!venue || !isOpen(venue)) return { ok: false, error: "That venue is not taking payment online at the moment.", status: 409 };
  const account = await venueAccount(venueId);
  if (!account) return { ok: false, error: `${venue.name} does not take payment online. Top up at the counter.`, status: 409 };
  let bill;
  try {
    bill = await createBill(account, {
      amount,
      name: user.name,
      email: user.email,
      mobile: toWhatsAppNumber(user.phone),
      description: `${venue.name}: credit top-up`,
      callbackUrl: `${baseUrl()}/api/payments/billplz/callback`,
      redirectUrl: `${await venueBaseUrl(venueId)}/payments/return`,
      reference: { label: "Top-up", value: `U${user.id}` },
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "The payment page could not be opened.", status: 502 };
  }
  await getDb()
    .prepare(
      `INSERT INTO online_payments (provider, bill_id, url, venue_id, amount, payer_name, payer_phone, purpose, topup_user_id)
       VALUES ('billplz', ?, ?, ?, ?, ?, ?, 'topup', ?)`
    )
    .run(bill.id, bill.url, venueId, amount, user.name, user.phone, user.id);
  return { ok: true, url: bill.url, amount, reused: false };
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
    bill = await createBill(account, {
      amount: row.fee,
      name: user.name,
      email: user.email,
      mobile: toWhatsAppNumber(user.phone),
      description: `${venue.name}: ${row.name}, season ${row.number}`,
      callbackUrl: `${baseUrl()}/api/payments/billplz/callback`,
      redirectUrl: `${await venueBaseUrl(row.venue_id)}/payments/return`,
      reference: { label: "League", value: `L${leagueId}-${row.id}` },
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "The payment page could not be opened.", status: 502 };
  }
  await db
    .prepare(
      `INSERT INTO online_payments (provider, bill_id, url, venue_id, amount, payer_name, payer_phone, purpose, league_place_id)
       VALUES ('billplz', ?, ?, ?, ?, ?, ?, 'league', ?)`
    )
    .run(bill.id, bill.url, row.venue_id, row.fee, user.name, user.phone, row.id);
  return { ok: true, url: bill.url, amount: row.fee, reused: false };
}
