import { getDb } from "./db";
import { toCsv } from "./export";
import { currencySymbol, roundMoney } from "./region";
import { taxIncluded, taxName } from "./tax";
import { venueZoneOf } from "./zones";
import { PAID_VIA_LABELS, type PaidVia } from "./types";

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
}

const PURPOSE: Record<string, Category> = {
  topup: "Stored credit",
  voucher: "Gift vouchers",
  membership: "Memberships",
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
    case "booking-part": {
      const b = (await db.prepare("SELECT class_id, coach_id FROM bookings WHERE id = ?").get(id)) as
        | { class_id: number | null; coach_id: number | null }
        | undefined;
      return b?.class_id ? "Classes" : b?.coach_id ? "Coaching" : "Court hire";
    }
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
    case "sale":
      return "Counter sales";
    case "payment": {
      const p = (await db.prepare("SELECT purpose FROM online_payments WHERE id = ?").get(id)) as { purpose: string } | undefined;
      return PURPOSE[p?.purpose ?? ""] ?? "Other";
    }
    case "credit": {
      const original = (await db.prepare("SELECT source FROM receipts WHERE id = ?").get(id)) as { source: string } | undefined;
      return original ? await categoryOf(original.source) : "Other";
    }
    default:
      return "Other";
  }
}

const label = (via: string | null) => (via ? (PAID_VIA_LABELS[via as PaidVia] ?? via) : "Not recorded");

/** Every receipt and credit note dated in the period, oldest first. */
export async function salesJournal(venueId: number, from: string, to: string): Promise<JournalRow[]> {
  const db = getDb();
  const zone = await zoneOf(venueId);
  const onDay = (column: string) => `to_char((${column}::timestamp AT TIME ZONE 'UTC') AT TIME ZONE ?, 'YYYY-MM-DD')`;

  // Bookings' receipts are drawn from the bookings themselves (lib/documents.ts), when they were paid.
  const bookings = (await db
    .prepare(
      `SELECT ${onDay("b.paid_at")} AS day, b.code, b.name, b.class_id, b.coach_id, b.date, c.name AS court,
              (b.total_price - b.shares_paid)::float AS gross, b.tax_rate, b.paid_via
         FROM bookings b JOIN courts c ON c.id = b.court_id
        WHERE c.venue_id = ? AND b.payment_status = 'paid' AND b.paid_at IS NOT NULL
          AND COALESCE(b.paid_via, '') <> 'pass' AND b.total_price - b.shares_paid > 0
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
  }[];

  const documents = (await db
    .prepare(
      `SELECT ${onDay("issued_at")} AS day, kind, number, source, customer_name, lines, total::float AS total,
              tax_rate, tax_amount::float AS tax_amount, paid_via
         FROM receipts
        WHERE venue_id = ? AND ${onDay("issued_at")} BETWEEN ? AND ?`
    )
    .all(zone, venueId, zone, from, to)) as {
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
    };
  });
  for (const d of documents) {
    const category = await categoryOf(d.source);
    const sign = d.kind === "credit_note" ? -1 : 1;
    let description = "";
    try {
      description = (JSON.parse(d.lines) as { description: string }[])[0]?.description ?? "";
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
    });
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date) || a.number.localeCompare(b.number));
}

const money = (n: number) => n.toFixed(2);

export async function journalCsv(venueId: number, from: string, to: string): Promise<string> {
  const rows = await salesJournal(venueId, from, to);
  const cur = currencySymbol();
  return toCsv(
    ["Date", "Number", "Type", "Customer", "Description", "Category", "Takings", `Net (${cur})`, `${taxName()} (${cur})`, `${taxName()} rate (%)`, `Gross (${cur})`, "Paid by"],
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
