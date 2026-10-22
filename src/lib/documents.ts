import { getDb, isUniqueViolation } from "./db";
import { roundMoney } from "./region";
import { taxIncluded, venueTax } from "./tax";
import { formatHour } from "./time";
import { PAID_VIA_LABELS, SPORT_LABELS, type PaidVia } from "./types";

/**
 * Receipts and credit notes kept as documents (migration 0040): one for each
 * sale that is not court time — a membership, a pass, credit, a tournament
 * entry, a league fee, a share of a game — and a credit note when a sale or
 * a paid booking is reversed.
 *
 * Each is written once, when the money changes hands, with the next serial
 * number at its venue and the tax as it stood that day, and is never edited:
 * a mistake is put right with a credit note, as an accountant expects. The
 * page that shows one is lib/receipts.ts.
 */

export interface Line {
  description: string;
  amount: number;
}

export interface Document {
  id: number;
  /** What goes in the address: "R42". */
  ref: string;
  kind: "receipt" | "credit_note";
  /** The serial number printed on it: R-000012, CN-000003. */
  number: string;
  venueId: number | null;
  userId: number | null;
  customerName: string;
  customerPhone: string | null;
  lines: Line[];
  total: number;
  tax: { name: string; rate: number; amount: number; regNo: string | null } | null;
  paidVia: string | null;
  note: string | null;
  /** A credit note: the number of what it reverses. */
  credits: string | null;
  issuedAt: string;
  source: string;
}

interface Row {
  id: number;
  venue_id: number | null;
  kind: "receipt" | "credit_note";
  number: string;
  source: string;
  credits_id: number | null;
  credits_ref: string | null;
  user_id: number | null;
  customer_name: string;
  customer_phone: string | null;
  lines: string;
  total: number | string;
  tax_name: string | null;
  tax_rate: number | string | null;
  tax_amount: number | string;
  tax_reg_no: string | null;
  paid_via: string | null;
  note: string | null;
  issued_at: string;
}

export const documentRef = (id: number) => `R${id}`;

/** The id inside "R42", or null for anything else (a booking code). */
export function documentId(ref: string): number | null {
  const m = /^R(\d{1,9})$/.exec(ref);
  return m ? Number(m[1]) : null;
}

function toDocument(r: Row): Document {
  return {
    id: r.id,
    ref: documentRef(r.id),
    kind: r.kind,
    number: r.number,
    venueId: r.venue_id,
    userId: r.user_id,
    customerName: r.customer_name,
    customerPhone: r.customer_phone,
    lines: JSON.parse(r.lines) as Line[],
    total: Number(r.total),
    tax:
      r.tax_rate === null || r.tax_name === null
        ? null
        : { name: r.tax_name, rate: Number(r.tax_rate), amount: Number(r.tax_amount), regNo: r.tax_reg_no },
    paidVia: r.paid_via,
    note: r.note,
    credits: r.credits_ref,
    issuedAt: r.issued_at,
    source: r.source,
  };
}

export async function documentById(id: number): Promise<Document | null> {
  const row = (await getDb().prepare("SELECT * FROM receipts WHERE id = ?").get(id)) as Row | undefined;
  return row ? toDocument(row) : null;
}

export async function documentFor(source: string): Promise<Document | null> {
  const row = (await getDb().prepare("SELECT * FROM receipts WHERE source = ?").get(source)) as Row | undefined;
  return row ? toDocument(row) : null;
}

/** A customer's receipts and credit notes, newest first. */
export async function documentsForUser(userId: number, limit = 50): Promise<(Document & { venueName: string | null })[]> {
  const rows = (await getDb()
    .prepare(
      `SELECT r.*, v.name AS venue_name FROM receipts r LEFT JOIN venues v ON v.id = r.venue_id
        WHERE r.user_id = ? ORDER BY r.id DESC LIMIT ?`
    )
    .all(userId, limit)) as (Row & { venue_name: string | null })[];
  return rows.map((r) => ({ ...toDocument(r), venueName: r.venue_name }));
}

/** A venue's receipts and credit notes, newest first: its book of them. */
export async function documentsForVenue(venueId: number, limit = 100): Promise<Document[]> {
  const rows = (await getDb()
    .prepare("SELECT * FROM receipts WHERE venue_id = ? ORDER BY id DESC LIMIT ?")
    .all(venueId, limit)) as Row[];
  return rows.map(toDocument);
}

/** How a payment was made, as a receipt says it. */
export function paidVia(via: string | null | undefined, gatewayName?: string): string | null {
  if (!via) return null;
  if (via === "online" && gatewayName) return `Online (${gatewayName})`;
  return PAID_VIA_LABELS[via as PaidVia] ?? via;
}

type Fields = Omit<Row, "id" | "number" | "issued_at" | "total" | "tax_rate" | "tax_amount"> & {
  total: number;
  tax_rate: number | null;
  tax_amount: number;
};

/**
 * Write a document with the next serial number at its venue, or return the
 * one already written for the same source. Two sales at the same moment both
 * reaching for the same number: one gets it, the other tries the next.
 */
async function write(fields: Fields): Promise<Document> {
  const db = getDb();
  for (let attempt = 0; ; attempt++) {
    try {
      const id = await db.transaction(async () => {
        const existing = (await db.prepare("SELECT id FROM receipts WHERE source = ?").get(fields.source)) as { id: number } | undefined;
        if (existing) return existing.id;
        const { n } = (await db
          .prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM receipts WHERE COALESCE(venue_id, 0) = ? AND kind = ?")
          .get(fields.venue_id ?? 0, fields.kind)) as { n: number | string };
        const seq = Number(n);
        const number = `${fields.kind === "receipt" ? "R" : "CN"}-${String(seq).padStart(6, "0")}`;
        const made = (await db
          .prepare(
            `INSERT INTO receipts (venue_id, kind, seq, number, source, credits_id, credits_ref, user_id, customer_name,
               customer_phone, lines, total, tax_name, tax_rate, tax_amount, tax_reg_no, paid_via, note)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id`
          )
          .get(
            fields.venue_id, fields.kind, seq, number, fields.source, fields.credits_id, fields.credits_ref, fields.user_id,
            fields.customer_name, fields.customer_phone, fields.lines, fields.total, fields.tax_name, fields.tax_rate,
            fields.tax_amount, fields.tax_reg_no, fields.paid_via, fields.note
          )) as { id: number };
        return made.id;
      })();
      return (await documentById(id))!;
    } catch (err) {
      if (!isUniqueViolation(err) || attempt >= 5) throw err;
    }
  }
}

export interface Sale {
  /** What it is for: "membership:12". One receipt per source. */
  source: string;
  venueId: number | null;
  userId?: number | null;
  name: string;
  phone?: string | null;
  lines: Line[];
  paidVia: string | null;
  /**
   * Whether the venue's SST or GST is inside the price. Not for credit,
   * which is taxed when it is spent on something.
   */
  taxable: boolean;
  note?: string | null;
}

/** Receipt a sale. Nothing for a free one. */
export async function issueReceipt(sale: Sale): Promise<Document | null> {
  const total = roundMoney(sale.lines.reduce((sum, l) => sum + l.amount, 0));
  if (total <= 0) return null;
  const tax = sale.taxable && sale.venueId !== null ? await venueTax(sale.venueId) : null;
  const rate = tax?.registered ? tax.rate : null;
  return write({
    venue_id: sale.venueId,
    kind: "receipt",
    source: sale.source,
    credits_id: null,
    credits_ref: null,
    user_id: sale.userId ?? null,
    customer_name: sale.name,
    customer_phone: sale.phone ?? null,
    lines: JSON.stringify(sale.lines),
    total,
    tax_name: rate ? tax!.name : null,
    tax_rate: rate,
    tax_amount: rate ? taxIncluded(total, rate) : 0,
    tax_reg_no: rate ? tax!.regNo : null,
    paid_via: sale.paidVia,
    note: sale.note ?? null,
  });
}

/**
 * Reverse a receipted sale: a credit note for all of it, or for `share` of it
 * (a late cancellation), at the tax it was sold at. Nothing when the sale was
 * never receipted (it was free, or made before receipts were kept). Once only.
 */
export async function creditReceipt(source: string, why: string, share = 1): Promise<Document | null> {
  const full = await documentFor(source);
  if (!full || full.kind !== "receipt" || share <= 0) return null;
  const part = roundMoney(full.total * Math.min(share, 1));
  const receipt =
    share >= 1
      ? full
      : {
          ...full,
          total: part,
          lines: [{ description: `${Math.round(share * 100)}% of ${full.number}, cancelled late`, amount: part }],
          tax: full.tax ? { ...full.tax, amount: taxIncluded(part, full.tax.rate) } : null,
        };
  return write({
    venue_id: receipt.venueId,
    kind: "credit_note",
    source: `credit:${receipt.id}`,
    credits_id: receipt.id,
    credits_ref: receipt.number,
    user_id: receipt.userId,
    customer_name: receipt.customerName,
    customer_phone: receipt.customerPhone,
    lines: JSON.stringify(receipt.lines),
    total: receipt.total,
    tax_name: receipt.tax?.name ?? null,
    tax_rate: receipt.tax?.rate ?? null,
    tax_amount: receipt.tax?.amount ?? 0,
    tax_reg_no: receipt.tax?.regNo ?? null,
    paid_via: receipt.paidVia,
    note: why,
  });
}

/** What a booking's receipt is made of: drawn from the booking each time. */
export interface BookingSale {
  code: string;
  venueId: number;
  userId: number | null;
  name: string;
  phone: string;
  paymentStatus: string;
  paidVia: string | null;
  status: string;
  lines: Line[];
  /** What this customer paid: the booking, less shares other players paid. */
  total: number;
  /** The rate inside the price; null when untaxed, or paid with a pass (taxed when the pass was sold). */
  taxRate: number | null;
}

export async function bookingSale(bookingId: number): Promise<BookingSale | null> {
  const db = getDb();
  const b = (await db
    .prepare(
      `SELECT b.code, b.user_id, b.name, b.phone, b.date, b.start_hour, b.end_hour, b.total_price::float AS total_price,
              b.shares_paid::float AS shares_paid, b.deposit_paid::float AS deposit_paid, b.tax_rate, b.status, b.payment_status, b.paid_via,
              b.coach_fee::float AS coach_fee, k.name AS coach_name,
              b.concession_name, b.concession_off::float AS concession_off, b.concession_check,
              c.name AS court_name, c.sport, c.venue_id
         FROM bookings b JOIN courts c ON c.id = b.court_id LEFT JOIN coaches k ON k.id = b.coach_id WHERE b.id = ?`
    )
    .get(bookingId)) as
    | {
        code: string; user_id: number | null; name: string; phone: string; date: string; start_hour: number; end_hour: number;
        total_price: number; shares_paid: number; deposit_paid: number; tax_rate: number | string | null; status: string; payment_status: string;
        paid_via: string | null; court_name: string; sport: string; venue_id: number;
        coach_fee: number; coach_name: string | null;
        concession_name: string | null; concession_off: number; concession_check: string | null;
      }
    | undefined;
  if (!b) return null;
  const extras = (await db
    .prepare("SELECT name, quantity, unit_price::float AS unit_price FROM booking_addons WHERE booking_id = ? ORDER BY id")
    .all(bookingId)) as { name: string; quantity: number; unit_price: number }[];
  const promo = (await db
    .prepare("SELECT u.discount::float AS discount, p.code FROM promo_uses u JOIN promo_codes p ON p.id = u.promo_id WHERE u.booking_id = ?")
    .get(bookingId)) as { discount: number; code: string } | undefined;

  const extrasTotal = extras.reduce((sum, e) => sum + e.quantity * e.unit_price, 0);
  // A concession price stands as a line of its own; charged in full when no proof was shown.
  const concession = b.concession_name && b.concession_check !== "refused" ? Number(b.concession_off) : 0;
  const discount = (promo?.discount ?? 0) + concession;
  const lines: Line[] = [
    {
      description: `${b.court_name} (${SPORT_LABELS[b.sport as keyof typeof SPORT_LABELS] ?? b.sport}), ${b.date} ${formatHour(b.start_hour)}–${formatHour(b.end_hour)}`,
      amount: roundMoney(b.total_price - extrasTotal + discount - b.coach_fee),
    },
    ...(b.coach_fee > 0 ? [{ description: `Coaching with ${b.coach_name ?? "a coach"}`, amount: b.coach_fee }] : []),
    ...extras.map((e) => ({ description: `${e.quantity} × ${e.name}`, amount: roundMoney(e.quantity * e.unit_price) })),
    ...(promo ? [{ description: `Promo ${promo.code}`, amount: -promo.discount }] : []),
    ...(concession > 0 ? [{ description: `${b.concession_name} price`, amount: -concession }] : []),
    ...(b.deposit_paid > 0 ? [{ description: "Deposit paid online, on its own receipt", amount: -b.deposit_paid }] : []),
    ...(b.shares_paid - b.deposit_paid > 0.005
      ? [{ description: "Paid by other players, on their own receipts", amount: -roundMoney(b.shares_paid - b.deposit_paid) }]
      : []),
  ];
  return {
    code: b.code,
    venueId: b.venue_id,
    userId: b.user_id,
    name: b.name,
    phone: b.phone,
    paymentStatus: b.payment_status,
    paidVia: b.paid_via,
    status: b.status,
    lines,
    total: roundMoney(b.total_price - b.shares_paid),
    taxRate: b.paid_via === "pass" || b.tax_rate === null ? null : Number(b.tax_rate),
  };
}

/**
 * A paid booking cancelled: a credit note for what its receipt showed, so
 * the tax on it comes off the venue's books. Once only.
 */
export async function creditBooking(bookingId: number, why: string, share = 1): Promise<Document | null> {
  const full = await bookingSale(bookingId);
  if (!full || full.paymentStatus !== "paid" || full.total <= 0 || share <= 0) return null;
  // A late cancellation gives back only part: the credit note is for that part, the fee kept stays sold.
  const sale =
    share >= 1
      ? full
      : {
          ...full,
          total: roundMoney(full.total * share),
          lines: [{ description: `${Math.round(share * 100)}% of ${full.code}, cancelled late`, amount: roundMoney(full.total * share) }],
        };
  const tax = sale.taxRate ? await venueTax(sale.venueId) : null;
  return write({
    venue_id: sale.venueId,
    kind: "credit_note",
    source: `booking:${bookingId}`,
    credits_id: null,
    credits_ref: sale.code,
    user_id: sale.userId,
    customer_name: sale.name,
    customer_phone: sale.phone,
    lines: JSON.stringify(sale.lines),
    total: sale.total,
    tax_name: sale.taxRate ? tax!.name : null,
    tax_rate: sale.taxRate,
    tax_amount: sale.taxRate ? taxIncluded(sale.total, sale.taxRate) : 0,
    tax_reg_no: sale.taxRate ? tax!.regNo : null,
    paid_via: paidVia(sale.paidVia),
    note: why,
  });
}

/** What a tournament entry or league season sold: for its receipt, however it was paid. */
interface FeeSale {
  venueId: number;
  userId: number | null;
  name: string;
  phone: string | null;
  description: string;
  fee: number;
}

export async function entrySale(entryId: number): Promise<FeeSale | null> {
  const row = (await getDb()
    .prepare(
      `SELECT t.venue_id, t.name AS tournament, t.entry_fee::float AS fee, e.user_id, e.name, u.phone
         FROM tournament_entries e JOIN tournaments t ON t.id = e.tournament_id LEFT JOIN users u ON u.id = e.user_id
        WHERE e.id = ?`
    )
    .get(entryId)) as { venue_id: number; tournament: string; fee: number; user_id: number | null; name: string; phone: string | null } | undefined;
  return row
    ? { venueId: row.venue_id, userId: row.user_id, name: row.name, phone: row.phone, description: `Entry: ${row.tournament}`, fee: row.fee }
    : null;
}

export async function placeSale(placeId: number): Promise<FeeSale | null> {
  const row = (await getDb()
    .prepare(
      `SELECT l.venue_id, l.name AS league, l.fee::float AS fee, s.number, p.user_id, p.name, u.phone
         FROM league_places lp JOIN league_seasons s ON s.id = lp.season_id JOIN leagues l ON l.id = s.league_id
         JOIN league_players p ON p.id = lp.player_id LEFT JOIN users u ON u.id = p.user_id
        WHERE lp.id = ?`
    )
    .get(placeId)) as
    | { venue_id: number; league: string; fee: number; number: number; user_id: number | null; name: string; phone: string | null }
    | undefined;
  return row
    ? {
        venueId: row.venue_id,
        userId: row.user_id,
        name: row.name,
        phone: row.phone,
        description: `League fee: ${row.league}, season ${row.number}`,
        fee: row.fee,
      }
    : null;
}

/**
 * A fee marked paid at the counter: receipted, and credited if the mark is
 * taken back. Marked paid again, it is a payment of its own with its own
 * receipt, so each is told apart by when it was made.
 */
export async function receiptFee(kind: "entry" | "place", id: number, paid: boolean): Promise<void> {
  if (!paid) {
    const last = (await getDb()
      .prepare(
        `SELECT r.source FROM receipts r
          WHERE r.source LIKE ? AND r.kind = 'receipt'
            AND NOT EXISTS (SELECT 1 FROM receipts c WHERE c.credits_id = r.id)
          ORDER BY r.id DESC LIMIT 1`
      )
      .get(`${kind}:${id}@%`)) as { source: string } | undefined;
    if (last) await creditReceipt(last.source, "receipt.why.unpaid");
    return;
  }
  const sale = kind === "entry" ? await entrySale(id) : await placeSale(id);
  if (!sale) return;
  await issueReceipt({
    source: `${kind}:${id}@${Date.now()}`,
    venueId: sale.venueId,
    userId: sale.userId,
    name: sale.name,
    phone: sale.phone,
    lines: [{ description: sale.description, amount: sale.fee }],
    paidVia: "At the counter",
    taxable: true,
  });
}

/** The receipt an online payment produced, if any: its own, or the membership it bought. */
export async function receiptOfPayment(paymentId: number): Promise<Document | null> {
  const row = (await getDb()
    .prepare(
      `SELECT r.* FROM receipts r
        WHERE r.source = 'payment:' || ? OR r.source = 'membership:' || (SELECT membership_id FROM online_payments WHERE id = ?)
        ORDER BY r.id LIMIT 1`
    )
    .get(String(paymentId), paymentId)) as Row | undefined;
  return row ? toDocument(row) : null;
}
