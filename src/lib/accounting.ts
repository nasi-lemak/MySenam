import { getDb } from "./db";
import { toCsv } from "./export";
import { currencySymbol, roundMoney } from "./region";
import { taxIncluded, taxName } from "./tax";
import { venueZoneOf } from "./zones";
import { PAID_VIA_LABELS, type PaidVia } from "./types";
import { lineText, paidHowOf, type Line } from "./documents";

/**
 * A venue's sales journal for its accountant: every receipt and credit note
 * in a period, one row each, sorted into what it was for, with the tax inside
 * it and how it was paid, and a summary of the same by category and by how it
 * was paid. Made to be keyed or imported into SQL Accounting, AutoCount, Xero
 * or QuickBooks against the venue's own accounts.
 *
 * Two kinds of money are not takings yet, and say so: stored credit and gift
 * vouchers are owed to customers until they are spent, so their sale is a
 * liability and the booking they pay for is the sale. A booking paid with a
 * pass is not a row at all: the pass was the sale, taxed when it was sold.
 *
 * Dated on the venue's own calendar, as the reports are.
 */

export type Category =
  | "Court hire"
  | "Classes"
  | "Coaching"
  | "Memberships"
  | "Passes"
  | "Tournament entries"
  | "League fees"
  | "Game shares"
  | "Stored credit"
  | "Gift vouchers"
  | "Counter sales"
  | "Hire deposits kept"
  | "Hire: damage and loss"
  | "Hire: extra charges"
  | "Hire: penalties"
  | "Other";

/** Money held for customers, not takings, until spent. */
const OWED: Category[] = ["Stored credit", "Gift vouchers"];

export interface JournalRow {
  date: string;
  number: string;
  type: "Receipt" | "Credit note";
  customer: string;
  description: string;
  category: Category;
  revenue: boolean;
  gross: number;
  tax: number;
  taxRate: number | null;
  paidVia: string;
  /**
   * For money kept from a hire deposit: on what footing its tax was decided —
   * the country's provisional default, the venue's own unreviewed choice, or
   * a configuration an adviser reviewed (lib/deposit-deductions.ts).
   */
  taxBasis: "provisional" | "venue" | "reviewed" | null;
  /** When the money moved (UTC, as stored), for the cash-up's order. */
  at: string;
  /**
   * How, as a method (lib/types.ts PaidVia; `counter` for "At the counter"
   * with no method said), or null where nothing says: the cash-up's columns.
   */
  method: string | null;
  /** Who took or gave back the money, where staff did (migration 0234). */
  staffId: number | null;
  staffName: string | null;
  /**
   * Of a test booking, made while the venue was not yet live (lib/test-bookings.ts): its receipt, or a credit note
   * reversing it. Listed like every document, and left out of the cash-up and the consolidated e-invoice.
   */
  test: boolean;
}

const BASIS_LABEL = { provisional: "Provisional default, not reviewed", venue: "Venue's choice, not reviewed", reviewed: "Reviewed by the venue's adviser" };

/** A hire deduction's tax basis, from the sale it was (or the sale a credit note reverses). */
async function basisOf(source: string): Promise<JournalRow["taxBasis"]> {
  const [kind, rest] = source.split(":");
  const id = Number.parseInt(rest ?? "", 10);
  if (kind === "credit") {
    const original = (await getDb().prepare("SELECT source FROM receipts WHERE id = ?").get(id)) as { source: string } | undefined;
    return original ? await basisOf(original.source) : null;
  }
  if (kind !== "sale") return null;
  const sale = (await getDb().prepare("SELECT tax_basis FROM counter_sales WHERE id = ?").get(id)) as { tax_basis: JournalRow["taxBasis"] } | undefined;
  return sale?.tax_basis ?? null;
}

const PURPOSE: Record<string, Category> = {
  topup: "Stored credit",
  voucher: "Gift vouchers",
  membership: "Memberships",
  pass: "Passes",
  entry: "Tournament entries",
  league: "League fees",
  share: "Game shares",
  split: "Court hire",
};

async function zoneOf(venueId: number): Promise<string> {
  const v = (await getDb().prepare("SELECT time_zone, lat, lng FROM venues WHERE id = ?").get(venueId)) as
    | { time_zone: string | null; lat: number | null; lng: number | null }
    | undefined;
  return venueZoneOf(v ?? {});
}

/** What a stored document was for, from what it was written for. */
async function categoryOf(source: string): Promise<Category> {
  const [kind, rest] = source.split(":");
  const id = Number.parseInt(rest ?? "", 10);
  const db = getDb();
  switch (kind) {
    case "booking":
    case "booking-part":
    case "booking-paid": {
      const b = (await db.prepare("SELECT class_id, coach_id FROM bookings WHERE id = ?").get(id)) as
        | { class_id: number | null; coach_id: number | null }
        | undefined;
      return b?.class_id ? "Classes" : b?.coach_id ? "Coaching" : "Court hire";
    }
    // The difference for a dearer coach, taken on its own receipt (lib/lesson-coaches.ts).
    case "lesson-coach":
      return "Coaching";
    case "membership":
      return "Memberships";
    case "pass": {
      // A pack of lessons is coaching sold ahead.
      const p = (await db.prepare("SELECT coach_id FROM passes WHERE id = ?").get(id)) as { coach_id: number | null } | undefined;
      return p?.coach_id ? "Coaching" : "Passes";
    }
    case "wallet":
      return "Stored credit";
    case "voucher":
      return "Gift vouchers";
    case "entry":
      return "Tournament entries";
    case "place":
      return "League fees";
    case "sale": {
      const sale = (await db.prepare("SELECT hire_record_id, hire_reason FROM counter_sales WHERE id = ?").get(id)) as
        | { hire_record_id: number | null; hire_reason: string | null }
        | undefined;
      if (!sale?.hire_record_id) return "Counter sales";
      // Kept from a hire deposit: under its reason's heading (damage, extra charges, penalties); kept before reasons, as it was.
      const { DEDUCTION_INFO, isDeductionReason } = await import("./deposit-deductions");
      return isDeductionReason(sale.hire_reason) ? DEDUCTION_INFO[sale.hire_reason].category : "Hire deposits kept";
    }
    case "payment": {
      const p = (await db.prepare("SELECT purpose FROM online_payments WHERE id = ?").get(id)) as { purpose: string } | undefined;
      // A deposit is part of the booking it holds, and sold as that is.
      if (p?.purpose === "booking") {
        const held = (await db.prepare("SELECT MIN(booking_id) AS id FROM online_payment_bookings WHERE payment_id = ?").get(id)) as
          | { id: number | null }
          | undefined;
        if (held?.id) return categoryOf(`booking:${held.id}`);
      }
      return PURPOSE[p?.purpose ?? ""] ?? "Other";
    }
    case "credit": {
      const original = (await db.prepare("SELECT source FROM receipts WHERE id = ?").get(id)) as { source: string } | undefined;
      return original ? await categoryOf(original.source) : "Other";
    }
    // A credit note on a company account (lib/accounts.ts): under its booking's heading, as the booking's receipt is.
    case "account-credit": {
      const credit = (await db.prepare("SELECT booking_id FROM account_credits WHERE id = ?").get(id)) as { booking_id: number | null } | undefined;
      return credit?.booking_id ? await categoryOf(`booking:${credit.booking_id}`) : "Other";
    }
    default:
      return "Other";
  }
}

const label = (via: string | null) => (via ? (PAID_VIA_LABELS[via as PaidVia] ?? via) : "Not recorded");

/**
 * A booking's own receipt, as the journal draws it from the booking (lib/documents.ts `bookingSale`): what its
 * customer paid, less the shares other players paid on their own receipts. SQL, for the booking aliased `b`.
 */
export const bookingGross = (b: string) => `(${b}.total_price - ${b}.shares_paid)`;

/**
 * What the journal's credit notes took back of a booking's own receipt (`column`: their totals or their tax): its
 * cancellation (`booking:<id>`), places taken off it and a cheaper coach (`booking:<id>:…`), and, charged to a
 * company account and invoiced, its credit notes on the account (`account-credit:<id>`). With `bookingGross`, the
 * one sum the period report keeps of a booking cancelled late (lib/reports.ts), so the two always agree.
 */
export const bookingCredited = (b: string, column: "total" | "tax_amount") =>
  `(SELECT COALESCE(SUM(r.${column}), 0) FROM receipts r
     WHERE r.kind = 'credit_note'
       AND (r.source = 'booking:' || ${b}.id OR r.source LIKE 'booking:' || ${b}.id || ':%'
            OR r.source IN (SELECT 'account-credit:' || ac.id FROM account_credits ac WHERE ac.booking_id = ${b}.id)))`;

/**
 * The booking a stored document was written for, where it was one's: its receipt kept or credit notes
 * (`booking:<id>…`, `booking-part:<id>…`, `booking-paid:<id>…`), a dearer coach's difference (`lesson-coach:<change>`),
 * its credit on a company account (`account-credit:<id>`), its deposit paid online (`payment:<id>`), or a credit note
 * reversing any of those (`credit:<receipt>`). Null for anything else.
 */
async function bookingOfSource(source: string): Promise<number | null> {
  const m = /^([a-z-]+):(\d+)/.exec(source);
  if (!m) return null;
  const id = Number(m[2]);
  const db = getDb();
  const one = async (sql: string) => ((await db.prepare(sql).get(id)) as { id: number | null } | undefined)?.id ?? null;
  switch (m[1]) {
    case "booking":
    case "booking-part":
    case "booking-paid":
      return id;
    case "lesson-coach":
      return one("SELECT booking_id AS id FROM lesson_coach_changes WHERE id = ?");
    case "account-credit":
      return one("SELECT booking_id AS id FROM account_credits WHERE id = ?");
    case "payment":
      return one("SELECT MIN(booking_id) AS id FROM online_payment_bookings WHERE payment_id = ?");
    case "credit": {
      const original = (await db.prepare("SELECT source FROM receipts WHERE id = ?").get(id)) as { source: string } | undefined;
      return original ? bookingOfSource(original.source) : null;
    }
    default:
      return null;
  }
}

/** A stored time as one ISO string, whichever way the driver hands it back. */
const stamp = (v: unknown): string => {
  if (v instanceof Date) return v.toISOString();
  const s = String(v ?? "");
  // "YYYY-MM-DD HH:MM:SS" (UTC, as `datetime('now')` writes it) or an ISO string.
  return /^\d{4}-\d{2}-\d{2} \d/.test(s) ? `${s.replace(" ", "T")}Z` : s;
};

/**
 * Every receipt and credit note dated in the period, oldest first. With
 * `counter`, for the cash-up (lib/cash-up.ts): also what the install sold as
 * its own over this venue's counter (credit, where it is the install's,
 * `receipts.counter_venue_id`), which is in this venue's till but not its
 * books.
 */
export async function salesJournal(venueId: number, from: string, to: string, opts: { counter?: boolean } = {}): Promise<JournalRow[]> {
  const db = getDb();
  const zone = await zoneOf(venueId);
  const onDay = (column: string) => `to_char((${column}::timestamp AT TIME ZONE 'UTC') AT TIME ZONE ?, 'YYYY-MM-DD')`;

  // Bookings' receipts are drawn from the bookings themselves (lib/documents.ts), when they were paid.
  const bookings = (await db
    .prepare(
      `SELECT ${onDay("b.paid_at")} AS day, b.code, b.name, b.class_id, b.coach_id, b.date, c.name AS court,
              ${bookingGross("b")}::float AS gross, b.tax_rate, b.paid_via, b.paid_at, b.paid_by, b.paid_by_name, b.test
         FROM bookings b JOIN courts c ON c.id = b.court_id
        WHERE c.venue_id = ? AND b.payment_status = 'paid' AND b.paid_at IS NOT NULL
          AND COALESCE(b.paid_via, '') <> 'pass' AND ${bookingGross("b")} > 0
          AND ${onDay("b.paid_at")} BETWEEN ? AND ?`
    )
    .all(zone, venueId, zone, from, to)) as {
    day: string;
    code: string;
    name: string;
    class_id: number | null;
    coach_id: number | null;
    date: string;
    court: string;
    gross: number;
    tax_rate: number | string | null;
    paid_via: string | null;
    paid_at: unknown;
    paid_by: number | null;
    paid_by_name: string | null;
    test: boolean;
  }[];

  const documents = (await db
    .prepare(
      `SELECT ${onDay("issued_at")} AS day, kind, number, source, customer_name, lines, total::float AS total,
              tax_rate, tax_amount::float AS tax_amount, paid_via, issued_at, staff_id, staff_name
         FROM receipts
        WHERE (venue_id = ?${opts.counter ? " OR (venue_id IS NULL AND counter_venue_id = ?)" : ""}) AND ${onDay("issued_at")} BETWEEN ? AND ?
          -- A booking paid with a pass has no receipt here (the pass was the sale): nor do its credit notes, which give
          -- entries back, not money.
          AND NOT (kind = 'credit_note' AND source LIKE 'booking:%'
                   AND (SELECT b.paid_via FROM bookings b WHERE b.id = split_part(source, ':', 2)::int) = 'pass')`
    )
    .all(zone, venueId, ...(opts.counter ? [venueId] : []), zone, from, to)) as {
    day: string;
    kind: "receipt" | "credit_note";
    number: string;
    source: string;
    customer_name: string;
    lines: string;
    total: number;
    tax_rate: number | string | null;
    tax_amount: number;
    paid_via: string | null;
    issued_at: unknown;
    staff_id: number | null;
    staff_name: string | null;
  }[];

  const rows: JournalRow[] = bookings.map((b) => {
    const rate = b.tax_rate === null ? null : Number(b.tax_rate);
    const category: Category = b.class_id ? "Classes" : b.coach_id ? "Coaching" : "Court hire";
    return {
      date: b.day,
      number: b.code,
      type: "Receipt",
      customer: b.name,
      description: `${b.court}, ${b.date}`,
      category,
      revenue: true,
      gross: roundMoney(b.gross),
      tax: rate ? taxIncluded(b.gross, rate) : 0,
      taxRate: rate,
      paidVia: label(b.paid_via),
      taxBasis: null,
      at: stamp(b.paid_at),
      method: b.paid_via,
      staffId: b.paid_by,
      staffName: b.paid_by_name,
      test: b.test === true,
    };
  });
  // Test bookings' documents, where the venue has any (usually none, and nothing more is read).
  const tests = new Set(
    ((await db
      .prepare("SELECT b.id FROM bookings b JOIN courts c ON c.id = b.court_id WHERE c.venue_id = ? AND b.test")
      .all(venueId)) as { id: number }[]).map((r) => r.id)
  );
  for (const d of documents) {
    const category = await categoryOf(d.source);
    const sign = d.kind === "credit_note" ? -1 : 1;
    let description = "";
    try {
      // With whom it is for, where the line keeps that apart (lib/documents.ts `lineText`).
      const first = (JSON.parse(d.lines) as Line[])[0];
      description = first ? lineText(first) : "";
    } catch {
      // An unreadable line is still a document with a total.
    }
    rows.push({
      date: d.day,
      number: d.number,
      type: d.kind === "credit_note" ? "Credit note" : "Receipt",
      customer: d.customer_name,
      description,
      category,
      revenue: !OWED.includes(category),
      gross: roundMoney(sign * d.total),
      tax: roundMoney(sign * d.tax_amount),
      taxRate: d.tax_rate === null ? null : Number(d.tax_rate),
      paidVia: d.paid_via ?? (d.kind === "credit_note" ? "—" : "Not recorded"),
      taxBasis: category.startsWith("Hire") ? await basisOf(d.source) : null,
      at: stamp(d.issued_at),
      method: paidHowOf(d.paid_via)?.via ?? null,
      staffId: d.staff_id,
      staffName: d.staff_name,
      test: tests.size > 0 && tests.has((await bookingOfSource(d.source)) ?? 0),
    });
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number));
}

const money = (n: number) => n.toFixed(2);

export async function journalCsv(venueId: number, from: string, to: string): Promise<string> {
  const rows = await salesJournal(venueId, from, to);
  const cur = currencySymbol();
  return toCsv(
    ["Date", "Number", "Type", "Customer", "Description", "Category", "Takings", `Net (${cur})`, `${taxName()} (${cur})`, `${taxName()} rate (%)`, `Gross (${cur})`, "Paid by", "Tax basis", "Test booking"],
    rows.map((r) => [
      r.date,
      r.number,
      r.type,
      r.customer,
      r.description,
      r.category,
      r.revenue ? "Yes" : "No, owed to customers until spent",
      money(r.gross - r.tax),
      money(r.tax),
      r.taxRate ?? "",
      money(r.gross),
      r.paidVia,
      r.taxBasis ? BASIS_LABEL[r.taxBasis] : "",
      // Made before the venue went live: not in the cash-up or the consolidated e-invoice (lib/test-bookings.ts).
      r.test ? "Yes, before going live" : "",
    ])
  );
}

export interface JournalTotals {
  byCategory: { category: Category; revenue: boolean; net: number; tax: number; gross: number }[];
  byPaidVia: { paidVia: string; gross: number }[];
  takings: { net: number; tax: number; gross: number };
}

export function totals(rows: JournalRow[]): JournalTotals {
  const cats = new Map<Category, { net: number; tax: number; gross: number }>();
  const vias = new Map<string, number>();
  for (const r of rows) {
    const c = cats.get(r.category) ?? { net: 0, tax: 0, gross: 0 };
    c.net += r.gross - r.tax;
    c.tax += r.tax;
    c.gross += r.gross;
    cats.set(r.category, c);
    if (r.type === "Receipt") vias.set(r.paidVia, (vias.get(r.paidVia) ?? 0) + r.gross);
  }
  const byCategory = [...cats.entries()].map(([category, t]) => ({
    category,
    revenue: !OWED.includes(category),
    net: roundMoney(t.net),
    tax: roundMoney(t.tax),
    gross: roundMoney(t.gross),
  }));
  const takings = byCategory
    .filter((c) => c.revenue)
    .reduce((s, c) => ({ net: s.net + c.net, tax: s.tax + c.tax, gross: s.gross + c.gross }), { net: 0, tax: 0, gross: 0 });
  return {
    byCategory,
    byPaidVia: [...vias.entries()].map(([paidVia, gross]) => ({ paidVia, gross: roundMoney(gross) })).sort((a, b) => b.gross - a.gross),
    takings: { net: roundMoney(takings.net), tax: roundMoney(takings.tax), gross: roundMoney(takings.gross) },
  };
}

export async function summaryCsv(venueId: number, from: string, to: string): Promise<string> {
  const t = totals(await salesJournal(venueId, from, to));
  const cur = currencySymbol();
  return toCsv(
    ["Group", "Name", "Takings", `Net (${cur})`, `${taxName()} (${cur})`, `Gross (${cur})`],
    [
      ...t.byCategory.map((c) => ["Category", c.category, c.revenue ? "Yes" : "No", money(c.net), money(c.tax), money(c.gross)]),
      ["Total takings", "", "Yes", money(t.takings.net), money(t.takings.tax), money(t.takings.gross)],
      ...t.byPaidVia.map((v) => ["Received by", v.paidVia, "", "", "", money(v.gross)]),
    ]
  );
}
