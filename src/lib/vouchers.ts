import crypto from "crypto";
import { getDb, withTransaction } from "./db";
import { creditReceipt, issueReceipt, paidHowOf, paidVia as paidViaLabel, saidLine, type PaidHow } from "./documents";
import { errorText, isLocale, translator, type ErrorCode, type Locale } from "./i18n";
import { creditScope } from "./mode";
import { enqueue } from "./outbox";
import { isAmount, money, roundMoney } from "./region";
import { keyedHash } from "./secrets";
import { siteName } from "./site";
import { said, withPhrase } from "./staff-text";
import { venueBaseUrl } from "./storefront";
import { venueTax } from "./tax";
import { addDays, todayISO } from "./time";
import { MAX_TOP_UP, type Refusal } from "./types";
import { linkIn } from "./link-locale";

/**
 * Gift vouchers: an amount somebody buys for somebody else, at the counter or
 * online, which whoever holds it turns into stored credit at the venue from
 * their account. The money is the venue's from the sale; like credit, it is
 * taxed when it is spent, on what it buys, so the voucher's receipt carries
 * no tax.
 *
 * A voucher is good for a year. Once it is credit it is credit, with that
 * account's history. Staff can cancel one that has not been used: a counter
 * sale is given back by hand against a credit note, one bought online is
 * listed as owed back on its payment.
 */

export const MIN_VOUCHER = 10;
export const VOUCHER_DAYS = 365;

export type VoucherStatus = "pending" | "active" | "redeemed" | "void";

export interface Voucher {
  id: number;
  code: string;
  venueId: number;
  venueName: string;
  amount: number;
  buyerName: string;
  buyerEmail: string | null;
  buyerPhone: string | null;
  recipientName: string | null;
  message: string | null;
  status: VoucherStatus;
  expiresOn: string;
  createdAt: string;
  paidVia: string | null;
  /** The same, as a method, for a screen in another language; null when it says something else. */
  paidHow: PaidHow | null;
  redeemedAt: string | null;
  /** Who it became credit for. */
  redeemedByName: string | null;
  /** The language it was bought in, for the email that sends it. */
  locale: Locale;
}

interface VoucherRow {
  id: number;
  code: string;
  venue_id: number;
  venue_name: string;
  amount: number;
  buyer_name: string;
  buyer_email: string | null;
  buyer_phone: string | null;
  recipient_name: string | null;
  message: string | null;
  status: VoucherStatus;
  expires_on: string;
  created_at: string;
  paid_via: string | null;
  locale: string;
  redeemed_at: string | null;
  redeemed_by_name: string | null;
}

const SELECT = `
  SELECT g.*, v.name AS venue_name, u.name AS redeemed_by_name
    FROM gift_vouchers g JOIN venues v ON v.id = g.venue_id LEFT JOIN users u ON u.id = g.redeemed_by
`;

function toVoucher(r: VoucherRow): Voucher {
  return {
    id: r.id,
    code: r.code,
    venueId: r.venue_id,
    venueName: r.venue_name,
    amount: Number(r.amount),
    buyerName: r.buyer_name,
    buyerEmail: r.buyer_email,
    buyerPhone: r.buyer_phone,
    recipientName: r.recipient_name,
    message: r.message,
    status: r.status,
    expiresOn: r.expires_on,
    createdAt: r.created_at,
    paidVia: r.paid_via,
    paidHow: paidHowOf(r.paid_via),
    redeemedAt: r.redeemed_at,
    redeemedByName: r.redeemed_by_name,
    locale: isLocale(r.locale) ? r.locale : "en",
  };
}

const ENGLISH = translator("en");
function refuse(code: ErrorCode, vars?: Record<string, string | number>): Refusal {
  return { ok: false, error: errorText(ENGLISH, code, vars), code, ...(vars ? { vars } : {}) };
}

/** No 0/O or 1/I: read aloud at a counter, or typed off a printed card. */
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function newCode(): string {
  const pick = (n: number) => Array.from({ length: n }, () => ALPHABET[crypto.randomInt(ALPHABET.length)]).join("");
  return `GV-${pick(4)}-${pick(4)}`;
}

/** The signature on a voucher's printable page, so its address is not just its code. */
export function voucherToken(code: string): string {
  return keyedHash("gift-voucher", code.toUpperCase()).slice(0, 24);
}

export function voucherPath(code: string): string {
  return `/gift/${encodeURIComponent(code)}?t=${voucherToken(code)}`;
}

export interface VoucherInput {
  venueId: number;
  amount: number;
  buyerName: string;
  buyerEmail?: string | null;
  buyerPhone?: string | null;
  recipientName?: string | null;
  message?: string | null;
  locale?: Locale;
}

export type VoucherResult = { ok: true; voucher: Voucher } | Refusal | { ok: false; error: string };

const clean = (s: string | null | undefined, max: number) => {
  const t = (s ?? "").trim();
  return t === "" ? null : t.slice(0, max);
};

function checkInput(input: VoucherInput): string | null {
  if (!isAmount(input.amount, MIN_VOUCHER, MAX_TOP_UP)) return `A voucher is ${money(MIN_VOUCHER)}–${MAX_TOP_UP}.`;
  if ((input.buyerName ?? "").trim().length < 2) return "Who is buying it?";
  const email = clean(input.buyerEmail, 200);
  if (email !== null && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return "That email address does not look right.";
  return null;
}

async function insert(input: VoucherInput, status: "pending" | "active", extra: { soldBy?: number; paidVia?: string | null }) {
  // 32^8 codes: a clash is not worth a retry inside somebody's transaction.
  const row = (await getDb()
    .prepare(
      `INSERT INTO gift_vouchers (code, venue_id, amount, buyer_name, buyer_email, buyer_phone, recipient_name, message,
                                  status, expires_on, sold_by, paid_via, locale)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
    )
    .get(
      newCode(),
      input.venueId,
      roundMoney(input.amount),
      input.buyerName.trim().slice(0, 100),
      clean(input.buyerEmail, 200),
      clean(input.buyerPhone, 30),
      clean(input.recipientName, 100),
      clean(input.message, 300),
      status,
      addDays(todayISO(), VOUCHER_DAYS),
      extra.soldBy ?? null,
      extra.paidVia ?? null,
      input.locale ?? "en"
    )) as { id: number };
  return (await voucherById(row.id))!;
}

export async function voucherById(id: number): Promise<Voucher | null> {
  const row = (await getDb().prepare(`${SELECT} WHERE g.id = ?`).get(id)) as VoucherRow | undefined;
  return row ? toVoucher(row) : null;
}

export async function voucherByCode(code: string): Promise<Voucher | null> {
  const row = (await getDb().prepare(`${SELECT} WHERE g.code = ?`).get(code.trim().toUpperCase())) as VoucherRow | undefined;
  return row ? toVoucher(row) : null;
}

/** Everything a venue has sold, newest first; not those still being paid for. */
export async function listVouchers(venueId: number): Promise<Voucher[]> {
  const rows = (await getDb()
    .prepare(`${SELECT} WHERE g.venue_id = ? AND g.status <> 'pending' ORDER BY g.id DESC LIMIT 200`)
    .all(venueId)) as VoucherRow[];
  return rows.map(toVoucher);
}

/** Staff selling one at the counter: it is good at once, with a receipt. */
export async function sellVoucher(
  input: VoucherInput & { adminId: number; via: string | null }
): Promise<VoucherResult> {
  const wrong = checkInput(input);
  if (wrong) return { ok: false, error: wrong };
  return withTransaction(async () => {
    const venue = await getDb().prepare("SELECT id FROM venues WHERE id = ?").get(input.venueId);
    if (!venue) return refuse("VENUE_NOT_FOUND");
    const voucher = await insert(input, "active", { soldBy: input.adminId, paidVia: paidViaLabel(input.via) ?? "At the counter" });
    await receiptVoucher(voucher, `voucher:${voucher.id}`, voucher.paidVia);
    return { ok: true, voucher };
  });
}

/** One being bought online: nobody's until it is paid for (lib/payments.ts). */
export async function pendingVoucher(input: VoucherInput): Promise<VoucherResult> {
  const wrong = checkInput(input);
  if (wrong) return { ok: false, error: wrong };
  return { ok: true, voucher: await insert(input, "pending", {}) };
}

/** Paid for online: good from now, and sent to whoever bought it. Once. */
export async function activateVoucher(voucherId: number, paidVia: string | null): Promise<Voucher | null> {
  const done = await getDb()
    .prepare("UPDATE gift_vouchers SET status = 'active', paid_via = ? WHERE id = ? AND status = 'pending'")
    .run(paidVia, voucherId);
  return done.changes === 1 ? await voucherById(voucherId) : null;
}

async function receiptVoucher(voucher: Voucher, source: string, paidVia: string | null): Promise<void> {
  await issueReceipt({
    source,
    venueId: voucher.venueId,
    name: voucher.buyerName,
    phone: voucher.buyerPhone,
    lines: [saidLine(said("srv.line.voucher", { code: voucher.code }), voucher.amount)],
    paidVia,
    // Taxed when it is spent, on what it buys, like the credit it becomes.
    taxable: false,
    note: (await venueTax(voucher.venueId)).registered ? "receipt.creditNoTax" : null,
  });
}

/** Email the voucher to whoever bought it, to print or send on. */
export async function sendVoucher(voucher: Voucher, locale: Locale = voucher.locale): Promise<void> {
  if (!voucher.buyerEmail) return;
  await enqueue({
    venueId: voucher.venueId,
    kind: "gift_voucher",
    channel: "email",
    recipient: voucher.buyerEmail,
    locale,
    subject: "msg.voucherSubject",
    body: "msg.voucher",
    dedupeKey: `voucher:${voucher.id}`,
    vars: {
      name: voucher.buyerName.split(/\s+/)[0],
      amount: money(voucher.amount),
      venue: voucher.venueName,
      code: voucher.code,
      until: voucher.expiresOn,
      link: linkIn(`${await venueBaseUrl(voucher.venueId)}${voucherPath(voucher.code)}`, locale),
      site: siteName(),
    },
  });
}

export type RedeemResult = { ok: true; voucher: Voucher } | Refusal;

/** Whoever holds the code turns it into credit at the venue, on their account. */
export async function redeemVoucher(userId: number, code: string): Promise<RedeemResult> {
  return withTransaction(async () => {
    const voucher = await voucherByCode(code);
    if (!voucher || voucher.status === "pending") return refuse("VOUCHER_NOT_FOUND");
    if (voucher.status === "redeemed") return refuse("VOUCHER_USED");
    if (voucher.status === "void") return refuse("VOUCHER_VOID");
    if (voucher.expiresOn < todayISO()) return refuse("VOUCHER_EXPIRED", { date: voucher.expiresOn });
    const db = getDb();
    const claimed = await db
      .prepare("UPDATE gift_vouchers SET status = 'redeemed', redeemed_by = ?, redeemed_at = datetime('now') WHERE id = ? AND status = 'active'")
      .run(userId, voucher.id);
    if (claimed.changes !== 1) return refuse("VOUCHER_USED");
    // Credit belongs to the venue where credit is per venue, as a top-up's does.
    await db
      .prepare("INSERT INTO wallet_entries (user_id, amount, reason, reason_phrase, venue_id) VALUES (?, ?, ?, ?, ?)")
      .run(userId, voucher.amount, ...withPhrase(said("srv.wallet.voucher", { code: voucher.code })), creditScope() === "venue" ? voucher.venueId : null);
    return { ok: true, voucher: (await voucherById(voucher.id))! };
  });
}

/**
 * Staff cancelling one nobody has used. Sold at the counter: its receipt is
 * credited and the money given back by hand. Bought online: what was paid is
 * owed back on the payment, under refunds owed, whose refund credits it.
 */
export async function voidVoucher(voucherId: number, venueId: number): Promise<VoucherResult> {
  return withTransaction(async () => {
    const db = getDb();
    const done = await db
      .prepare("UPDATE gift_vouchers SET status = 'void' WHERE id = ? AND venue_id = ? AND status = 'active'")
      .run(voucherId, venueId);
    if (done.changes !== 1) return { ok: false, error: "Only a voucher nobody has used can be cancelled." };
    const payment = (await db
      .prepare("SELECT id, amount FROM online_payments WHERE voucher_id = ? AND status = 'paid'")
      .get(voucherId)) as { id: number; amount: number } | undefined;
    if (payment) await db.prepare("UPDATE online_payments SET refund_due = amount WHERE id = ?").run(payment.id);
    else await creditReceipt(`voucher:${voucherId}`, "receipt.why.voided");
    return { ok: true, voucher: (await voucherById(voucherId))! };
  });
}

/** The voucher behind a printable page's address, when its signature is right. */
export async function voucherForPage(code: string, token: string): Promise<Voucher | null> {
  const want = Buffer.from(voucherToken(code));
  const got = Buffer.from(token);
  if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
  const voucher = await voucherByCode(code);
  return voucher && voucher.status !== "pending" ? voucher : null;
}

/** The voucher a payment bought, for the page the customer comes back to. */
export async function voucherOfPayment(paymentId: number): Promise<Voucher | null> {
  const row = (await getDb().prepare("SELECT voucher_id FROM online_payments WHERE id = ?").get(paymentId)) as
    | { voucher_id: number | null }
    | undefined;
  return row?.voucher_id ? await voucherById(row.voucher_id) : null;
}
