import { activityName } from "./activity-registry";
import { laneWords } from "./lanes";
import { getDb, isUniqueViolation } from "./db";
import { roundMoney } from "./region";
import { taxIncluded, venueTax } from "./tax";
import { formatHour } from "./time";
import { hoursOf } from "./interval";
import { PAID_VIA_LABELS, type CounterMethod, type PaidVia } from "./types";
import { englishOf, said, type StaffText } from "./staff-text";
import { derivedPreset } from "./concession-presets";
import { isConcessionPreset, type ConcessionPreset } from "./concessions-shared";
import { actingStaff } from "./acting-staff";
import { pageSql, paged, textMatch, type ListQuery, type Page } from "./list-search";

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
  /** The description as a phrase a staff screen says in the staff language, where MySenam wrote it; the receipt itself says the English. */
  phrase?: StaffText;
  /**
   * A line for a built-in concession's price (*Student price*): its key, so
   * the receipt says it in the reader's language (lib/receipts.ts
   * `receiptLineText`). `description` stays as written, for the books.
   */
  concessionPreset?: ConcessionPreset;
  /**
   * One person's own price on their place (lib/entitlements.ts): a member's
   * price or a concession's (its key in `concessionPreset` where it is a
   * built-in one), and whose place it was, so the receipt says it in the
   * reader's language with their name (lib/receipts.ts `receiptLineText`).
   * `description` stays as written, for the books.
   */
  place?: { kind: "membership" | "concession"; name: string | null };
  /**
   * A booking's court time, so the receipt says it in the reader's language
   * (lib/receipts.ts `receiptLineText`): the court, the activity, the day and
   * hours, how many places, and whom the places are for where the booking
   * names somebody other than its customer (a guardian's children, in the
   * order they were put on it; the customer too where they take part).
   * Names only: nothing else about them. `description` stays as written, for
   * the books.
   */
  slot?: {
    court: string;
    sport: string;
    date: string;
    startMin: number;
    endMin: number;
    players: number;
    for: string[];
    /** Its lane was still to be given on arrival when the line was drawn: said so, the lane not named (lib/lanes.ts). */
    onArrival?: true;
  };
  /**
   * Whom the line is for, by name, where it names somebody (a child taken off
   * a booking, the family a membership covers): kept apart from the words, so
   * retention and erasure clear it (lib/receipt-names.ts). `description`, and
   * the phrase's `who`, then hold `{who}` where the names are said, and every
   * reader fills it in (`lineText`, `linePhrase`). Lines written before it
   * have the names in `description`.
   */
  who?: string[];
  /**
   * A manager's change to a booking's price before it was paid
   * (lib/price-adjustments.ts): the difference, as a line of its own, so the
   * receipt says it in the reader's language (lib/receipts.ts
   * `receiptLineText`). `description` stays as written, for the books.
   */
  adjusted?: "adjusted" | "complimentary";
}

/** Where a line's names go in its words (`Line.who`). */
export const WHO = "{who}";

/** What a reader says where a line's names were, once they are cleared (lib/privacy.ts `ANONYMOUS`). */
const REMOVED = "(removed)";

/**
 * A line as the books, a list of receipts and an e-invoice say it: in
 * English, with whom it is for where it names somebody (`who`, or one
 * person's own price on their place). A booking's court time reads as it
 * always did there, without its people; the receipt page says them
 * (lib/receipts.ts `receiptLineText`).
 */
export function lineText(line: Pick<Line, "description" | "place" | "who">): string {
  if (line.description.includes(WHO)) return line.description.split(WHO).join(line.who?.length ? line.who.join(", ") : REMOVED);
  const name = line.place?.name;
  if (name && !line.description.endsWith(`, ${name}`)) return `${line.description}, ${name}`;
  return line.description;
}

/** A line's phrase, for a staff screen, its names filled in where it holds them apart. */
export function linePhrase(line: Pick<Line, "phrase" | "who">): StaffText | null {
  if (!line.phrase) return null;
  if (line.who === undefined || line.phrase.vars?.who !== WHO) return line.phrase;
  return { ...line.phrase, vars: { ...line.phrase.vars, who: line.who.length ? line.who.join(", ") : REMOVED } };
}

/** A line MySenam words: the receipt's English, with its phrase kept beside it. */
export function saidLine(text: StaffText, amount: number): Line {
  return { description: englishOf(text), amount, phrase: text };
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
  /** Who took or gave back the money, where staff did (migration 0234). */
  staffName: string | null;
  /** The install's own (no `venueId`): whose till the money went into, where staff said (migration 0234). */
  counterVenueId: number | null;
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
  staff_id?: number | null;
  staff_name?: string | null;
  counter_venue_id?: number | null;
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
    staffName: r.staff_name ?? null,
    counterVenueId: r.counter_venue_id ?? null,
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

/** What the venue's book of receipts filters by (lib/list-search.ts). */
export const DOCUMENT_LIST_STATUSES = ["receipt", "credit_note"] as const;

/**
 * A venue's receipts and credit notes found by number, the booking a credit
 * note is for, the customer's name or number; receipts or credit notes only;
 * a page at a time, newest first (lib/list-search.ts).
 */
export async function searchDocuments(venueId: number, query: ListQuery): Promise<Page<Document>> {
  const match = textMatch(query.q, { codes: ["number", "credits_ref"], names: ["customer_name"], phones: ["customer_phone"] });
  const rows = (await getDb()
    .prepare(
      `SELECT * FROM receipts WHERE venue_id = ? AND ${match.sql}${query.status ? " AND kind = ?" : ""}
        ORDER BY id DESC ${pageSql(query.page)}`
    )
    .all(venueId, ...match.params, ...(query.status ? [query.status] : []))) as Row[];
  const page = paged(rows, query.page);
  return { ...page, items: page.items.map(toDocument) };
}

/** How a payment was made, as a receipt says it. */
export function paidVia(via: string | null | undefined, gatewayName?: string): string | null {
  if (!via) return null;
  if (via === "online" && gatewayName) return `Online (${gatewayName})`;
  return PAID_VIA_LABELS[via as PaidVia] ?? via;
}

/** How a payment was made, as a method: `counter` when a sale says only that it was at the counter. */
export interface PaidHow {
  via: PaidVia | "counter";
  /** The gateway's name, for one paid online. */
  gateway?: string;
}

/** The method behind what `paidVia` wrote (or "At the counter"), so a screen can say it in its own language; null for anything else. */
export function paidHowOf(label: string | null | undefined): PaidHow | null {
  if (!label) return null;
  if (label === "At the counter") return { via: "counter" };
  const online = /^Online \((.+)\)$/.exec(label);
  if (online) return { via: "online", gateway: online[1] };
  const via = (Object.keys(PAID_VIA_LABELS) as PaidVia[]).find((k) => PAID_VIA_LABELS[k] === label);
  return via ? { via } : null;
}

type Fields = Omit<Row, "id" | "number" | "issued_at" | "total" | "tax_rate" | "tax_amount"> & {
  total: number;
  tax_rate: number | null;
  tax_amount: number;
  /** When it was paid, if not now (YYYY-MM-DD HH:MM:SS, UTC). */
  issued_at?: string | null;
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
      // Who is acting, where staff are (lib/acting-staff.ts): the cash-up counts what each took and gave back.
      const staff = actingStaff();
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
               customer_phone, lines, total, tax_name, tax_rate, tax_amount, tax_reg_no, paid_via, note, issued_at, staff_id, staff_name,
               counter_venue_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')), ?, ?, ?) RETURNING id`
          )
          .get(
            fields.venue_id, fields.kind, seq, number, fields.source, fields.credits_id, fields.credits_ref, fields.user_id,
            fields.customer_name, fields.customer_phone, fields.lines, fields.total, fields.tax_name, fields.tax_rate,
            fields.tax_amount, fields.tax_reg_no, fields.paid_via, fields.note, fields.issued_at ?? null,
            staff?.id ?? null, staff?.name ?? null,
            // Only for the install's own: a venue's document is in its own till already.
            fields.venue_id === null ? (fields.counter_venue_id ?? null) : null
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
  /** When it was paid, if before now (YYYY-MM-DD HH:MM:SS, UTC), so it falls in the right period. */
  issuedAt?: string | null;
  /** The install's own sale (`venueId` null) taken at a venue's counter: whose till, for its cash-up. */
  counterVenueId?: number | null;
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
    issued_at: sale.issuedAt ?? null,
    counter_venue_id: sale.counterVenueId ?? null,
  });
}

/**
 * Reverse a receipted sale: a credit note for all of it, or for `share` of it
 * (a late cancellation), at the tax it was sold at. Nothing when the sale was
 * never receipted (it was free, or made before receipts were kept). Once only.
 *
 * A receipt that covered several things (a deposit on two bookings) is
 * credited a part at a time: `part` names the thing (`key`, so each is
 * credited once) and how much of the receipt was for it. However it is cut,
 * a receipt is never credited for more than it was.
 */
export async function creditReceipt(
  source: string,
  why: string,
  share = 1,
  /**
   * `key` makes the credit note's source, so it names nobody; `text` is how
   * the part is said on it (the key where not given), with `{who}` where
   * `who`, the people it was for, go (`Line.who`).
   */
  part?: { key: string; amount: number; text?: string; who?: string[] }
): Promise<Document | null> {
  const full = await documentFor(source);
  if (!full || full.kind !== "receipt" || share <= 0) return null;
  const creditSource = part ? `credit:${full.id}:${part.key}` : `credit:${full.id}`;
  const already = await documentFor(creditSource);
  if (already) return already;
  const { credited } = (await getDb()
    .prepare("SELECT COALESCE(SUM(total), 0)::float AS credited FROM receipts WHERE kind = 'credit_note' AND credits_id = ?")
    .get(full.id)) as { credited: number };
  const wanted = roundMoney((part ? Math.min(part.amount, full.total) : full.total) * Math.min(share, 1));
  const amount = Math.min(wanted, roundMoney(full.total - Number(credited)));
  if (amount <= 0) return null;
  const receipt =
    amount >= full.total
      ? full
      : {
          ...full,
          total: amount,
          lines: [
            {
              description:
                share < 1
                  ? `${Math.round(share * 100)}% of ${full.number}${part ? `, ${part.text ?? part.key}` : ""}, cancelled late`
                  : `Part of ${full.number}${part ? `, ${part.text ?? part.key}` : ""}`,
              amount,
              ...(part?.who ? { who: part.who } : {}),
            },
          ],
          tax: full.tax ? { ...full.tax, amount: taxIncluded(amount, full.tax.rate) } : null,
        };
  return write({
    venue_id: receipt.venueId,
    kind: "credit_note",
    source: creditSource,
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
    // Given back over the same counter it was taken at.
    counter_venue_id: receipt.counterVenueId,
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
      `SELECT b.code, b.user_id, b.name, b.phone, b.date, b.start_min, b.end_min, b.total_price::float AS total_price,
              b.shares_paid::float AS shares_paid, b.deposit_paid::float AS deposit_paid, b.tax_rate, b.status, b.payment_status, b.paid_via,
              b.coach_fee::float AS coach_fee, k.name AS coach_name,
              b.concession_name, b.concession_off::float AS concession_off, b.concession_check, b.players,
              b.concession_preset, cn.name AS cn_name, cn.proof AS cn_proof, cn.preset AS cn_preset,
              c.name AS court_name, b.sport, c.venue_id,
              -- A lane given on arrival, not yet checked in: not named to the customer (lib/lanes.ts).
              (b.lane_on_arrival AND NOT EXISTS (SELECT 1 FROM check_ins ci WHERE ci.booking_id = b.id)) AS lane_hidden
         FROM bookings b JOIN courts c ON c.id = b.court_id LEFT JOIN coaches k ON k.id = b.coach_id
         LEFT JOIN concessions cn ON cn.id = b.concession_id WHERE b.id = ?`
    )
    .get(bookingId)) as
    | {
        code: string; user_id: number | null; name: string; phone: string; date: string; start_min: number; end_min: number;
        total_price: number; shares_paid: number; deposit_paid: number; tax_rate: number | string | null; status: string; payment_status: string;
        paid_via: string | null; court_name: string; sport: string; venue_id: number; lane_hidden: boolean;
        coach_fee: number; coach_name: string | null;
        concession_name: string | null; concession_off: number; concession_check: string | null; players: number;
        concession_preset: string | null; cn_name: string | null; cn_proof: string | null; cn_preset: string | null;
      }
    | undefined;
  if (!b) return null;
  if (b.lane_hidden) b.court_name = laneWords("en");
  const extras = (await db
    .prepare("SELECT name, quantity, unit_price::float AS unit_price FROM booking_addons WHERE booking_id = ? ORDER BY id")
    .all(bookingId)) as { name: string; quantity: number; unit_price: number }[];
  const promo = (await db
    .prepare("SELECT u.discount::float AS discount, p.code FROM promo_uses u JOIN promo_codes p ON p.id = u.promo_id WHERE u.booking_id = ?")
    .get(bookingId)) as { discount: number; code: string } | undefined;

  // A paid lesson given to another coach since (lib/lesson-coaches.ts) keeps on its receipt the coach and fee it was sold with.
  const sold = (await db
    .prepare("SELECT from_fee::float AS fee, from_coach_name AS name FROM lesson_coach_changes WHERE booking_id = ? AND paid ORDER BY id LIMIT 1")
    .get(bookingId)) as { fee: number; name: string } | undefined;
  if (sold) {
    b.coach_fee = Number(sold.fee);
    b.coach_name = sold.name;
  }

  const extrasTotal = extras.reduce((sum, e) => sum + e.quantity * e.unit_price, 0);
  // A concession price stands as a line of its own; charged in full when no proof was shown.
  const concession = b.concession_name && b.concession_check !== "refused" ? Number(b.concession_off) : 0;
  // One person's concession or member price on their own place (lib/entitlements.ts): a line each, naming them.
  const perPlace = (await db
    .prepare(
      `SELECT pb.kind, pb.concession_name, pb.concession_preset, pb.amount::float AS amount, bp.name
         FROM place_benefits pb LEFT JOIN booking_participants bp ON bp.id = pb.place_id
        WHERE pb.booking_id = ? AND pb.reversed_at IS NULL AND pb.amount > 0 ORDER BY pb.id`
    )
    .all(bookingId)) as { kind: string; concession_name: string | null; concession_preset: string | null; amount: number; name: string | null }[];
  const placeOff = perPlace.reduce((sum, p) => sum + Number(p.amount), 0);
  // Whom the places are for, where the booking names anybody other than its customer (lib/entitlements.ts placesOf).
  const people = (await db.prepare("SELECT takes_part_as, name FROM booking_participants WHERE booking_id = ? ORDER BY id").all(bookingId)) as {
    takes_part_as: string;
    name: string | null;
  }[];
  const forNames = people.some((p) => p.takes_part_as === "participant") ? people.flatMap((p) => (p.name ? [p.name] : [])) : [];
  // A manager's change to the price before it was paid (lib/price-adjustments.ts): the difference, last, after every
  // discount. One made after it was paid is a credit note of its own; the receipt stays as sold.
  const adjusted = (await db
    .prepare(
      `SELECT COALESCE(SUM(delta), 0)::float AS delta,
              COALESCE((SELECT complimentary FROM booking_price_adjustments WHERE booking_id = ? AND NOT paid ORDER BY id DESC LIMIT 1), false) AS free
         FROM booking_price_adjustments WHERE booking_id = ? AND NOT paid`
    )
    .get(bookingId, bookingId)) as { delta: number; free: boolean | number };
  const adjustment = roundMoney(Number(adjusted.delta));
  const discount = (promo?.discount ?? 0) + concession + placeOff;
  // A built-in one is said in the reader's language; the venue's own name stays as typed.
  const preset = derivedPreset({
    concessionName: b.concession_name,
    concessionPreset: b.concession_preset,
    concession: b.cn_name === null ? null : { name: b.cn_name, proof: b.cn_proof ?? "", preset: b.cn_preset },
  });
  const lines: Line[] = [
    {
      description: `${b.court_name} (${activityName(b.sport)}), ${b.date} ${formatHour(hoursOf(b.start_min))}–${formatHour(hoursOf(b.end_min))}${
        Number(b.players) > 1 ? `, ${b.players} players` : ""
      }`,
      amount: roundMoney(b.total_price - extrasTotal + discount - b.coach_fee - adjustment),
      slot: {
        court: b.court_name,
        sport: b.sport,
        date: b.date,
        startMin: b.start_min,
        endMin: b.end_min,
        players: Number(b.players),
        for: forNames,
        ...(b.lane_hidden ? { onArrival: true as const } : {}),
      },
    },
    ...(b.coach_fee > 0 ? [{ description: `Coaching with ${b.coach_name ?? "a coach"}`, amount: b.coach_fee }] : []),
    ...extras.map((e) => ({ description: `${e.quantity} × ${e.name}`, amount: roundMoney(e.quantity * e.unit_price) })),
    // Each discount a line of its own, in the order they were worked out (lib/discounts.ts): concessions and member prices, then the code.
    ...(concession > 0
      ? [
          {
            description: `${b.concession_name} price`,
            amount: -concession,
            ...(preset ? { concessionPreset: preset } : {}),
          },
        ]
      : []),
    ...perPlace.map((p) => ({
      // Whose place it was is `place.name`, apart from the words (`lineText` says it), so it can be cleared.
      description: p.kind === "membership" ? "Member price" : `${p.concession_name ?? "Concession"} price`,
      amount: -roundMoney(Number(p.amount)),
      // Its key and whose place, so the receipt says it in the reader's language; a concession the venue named stays as typed.
      ...(p.kind === "concession" && isConcessionPreset(p.concession_preset) ? { concessionPreset: p.concession_preset } : {}),
      place: { kind: p.kind === "membership" ? ("membership" as const) : ("concession" as const), name: p.name },
    })),
    ...(promo ? [{ description: `Promo ${promo.code}`, amount: -promo.discount }] : []),
    ...(adjustment !== 0
      ? [
          {
            description: adjusted.free === true || adjusted.free === 1 ? "Complimentary" : "Price adjusted by the venue",
            amount: adjustment,
            adjusted: adjusted.free === true || adjusted.free === 1 ? ("complimentary" as const) : ("adjusted" as const),
          },
        ]
      : []),
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
 * A paid booking's receipt, drawn from the booking, written down as a
 * document of its own: for when the booking is about to stop being paid (a
 * chargeback lost), so the sale stays in the period it was paid in rather
 * than vanishing from it. Dated when it was paid; at the tax it was sold at.
 */
export async function keepBookingReceipt(bookingId: number, source: string, paidAt: string | null): Promise<Document | null> {
  const sale = await bookingSale(bookingId);
  if (!sale || sale.paymentStatus !== "paid" || sale.total <= 0) return null;
  const tax = sale.taxRate ? await venueTax(sale.venueId) : null;
  return write({
    venue_id: sale.venueId,
    kind: "receipt",
    source,
    credits_id: null,
    credits_ref: null,
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
    note: `Booking ${sale.code}`,
    issued_at: paidAt ? paidAt.replace("T", " ").slice(0, 19) : null,
  });
}

/**
 * A paid booking cancelled: a credit note for what its receipt showed, so
 * the tax on it comes off the venue's books. Once only.
 */
export async function creditBooking(
  bookingId: number,
  why: string,
  share = 1,
  /**
   * What is left of the booking's price once places taken off it while it was
   * paid are left out (lib/place-withdrawals.ts): each has its own credit note.
   */
  remaining = 1,
  /** How it went back, where not the way it was paid: given as stored credit at the counter (lib/counter-refunds.ts). */
  via?: string
): Promise<Document | null> {
  const full = await bookingSale(bookingId);
  if (!full || full.paymentStatus !== "paid" || full.total <= 0 || share <= 0 || remaining <= 0) return null;
  // A booking a pass paid has no receipt (the pass was the sale) and takes back entries, not money (ADR 0068): there is nothing to credit.
  // The trail is the pass's own ledger (lib/store.ts `refundBookingToPass`) and the activity log.
  if (full.paidVia === "pass") return null;
  // A late cancellation gives back only part: the credit note is for that part, the fee kept stays sold.
  const amount = roundMoney(full.total * share * remaining);
  const sale =
    share >= 1 && remaining >= 1
      ? full
      : {
          ...full,
          total: amount,
          lines: [
            share < 1
              ? saidLine(said("srv.line.lateShare", { pct: Math.round(share * 100), code: full.code }), amount)
              : { description: `${full.code}, the places still on it`, amount },
          ],
        };
  const tax = sale.taxRate ? await venueTax(sale.venueId) : null;
  // A late cancellation's fee kept carries its own tax, worked out on it (as the period report counts it): the
  // credit note takes the rest of the receipt's, so the two never drift a cent apart.
  const base = roundMoney(full.total * remaining);
  const taxBack = !sale.taxRate ? 0 : share < 1 ? roundMoney(taxIncluded(base, sale.taxRate) - taxIncluded(roundMoney(base - sale.total), sale.taxRate)) : taxIncluded(sale.total, sale.taxRate);
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
    tax_amount: taxBack,
    tax_reg_no: sale.taxRate ? tax!.regNo : null,
    paid_via: via ?? paidVia(sale.paidVia),
    note: why,
  });
}

/**
 * A place taken off a paid booking (lib/place-withdrawals.ts): a credit note
 * for what went back for it, at the tax the booking was sold at. The
 * booking's receipt stays what was sold; the fee kept on a late withdrawal
 * stays sold. Once per withdrawal.
 */
export async function creditBookingPlace(bookingId: number, withdrawalId: number, who: PlaceTaken, amount: number, why: string): Promise<Document | null> {
  const full = await bookingSale(bookingId);
  if (!full || full.paymentStatus !== "paid" || amount <= 0) return null;
  const total = roundMoney(amount);
  const tax = full.taxRate ? await venueTax(full.venueId) : null;
  return write({
    venue_id: full.venueId,
    kind: "credit_note",
    source: `booking:${bookingId}:place:${withdrawalId}`,
    credits_id: null,
    credits_ref: full.code,
    user_id: full.userId,
    customer_name: full.name,
    customer_phone: full.phone,
    lines: JSON.stringify([takenOffLine(who, full.code, total)]),
    total,
    tax_name: full.taxRate ? tax!.name : null,
    tax_rate: full.taxRate,
    tax_amount: full.taxRate ? taxIncluded(total, full.taxRate) : 0,
    tax_reg_no: full.taxRate ? tax!.regNo : null,
    paid_via: paidVia(full.paidVia),
    note: why,
  });
}

/** Who was taken off a booking: the person, by name, or so many places nobody was named on. */
export interface PlaceTaken {
  name: string | null;
  places: number;
}

/** A credit note's line for a place taken off: the person's name apart from the words (`Line.who`). */
function takenOffLine(who: PlaceTaken, code: string, amount: number): Line {
  return who.name
    ? { description: `${WHO}, taken off ${code}`, amount, who: [who.name] }
    : { description: `${who.places} place${who.places === 1 ? "" : "s"}, taken off ${code}`, amount };
}

/**
 * A place taken off a booking charged to a company or school account after
 * its invoice was issued (lib/place-withdrawals.ts, lib/accounts.ts): a
 * credit note to the account, against that invoice, at the tax the booking
 * was invoiced at. The invoice stays as it was issued; the credit comes off
 * the account's next one. Once per credit.
 */
export async function creditAccountPlace(credit: {
  creditId: number;
  venueId: number;
  accountName: string;
  invoiceNumber: string | null;
  code: string;
  who: PlaceTaken;
  amount: number;
  taxRate: number | null;
  why: string;
  /** Its line where it is not for one place: a whole booking cancelled (lib/accounts.ts `creditAccountForCancellation`). */
  line?: Line;
}): Promise<Document | null> {
  const total = roundMoney(credit.amount);
  if (total <= 0) return null;
  // At the rate the booking was invoiced at, as the invoice's own lines were.
  const rate = credit.taxRate;
  const tax = rate ? await venueTax(credit.venueId) : null;
  return write({
    venue_id: credit.venueId,
    kind: "credit_note",
    source: `account-credit:${credit.creditId}`,
    credits_id: null,
    credits_ref: credit.invoiceNumber ?? credit.code,
    user_id: null,
    customer_name: credit.accountName,
    customer_phone: null,
    lines: JSON.stringify([credit.line ?? takenOffLine(credit.who, credit.code, total)]),
    total,
    tax_name: rate ? tax!.name : null,
    tax_rate: rate,
    tax_amount: rate ? taxIncluded(total, rate) : 0,
    tax_reg_no: rate ? tax!.regNo : null,
    paid_via: null,
    note: credit.why,
  });
}

/**
 * A paid lesson given to a cheaper coach, the difference given back
 * (lib/lesson-coaches.ts): a credit note for it, at the tax the booking was
 * sold at. The booking's receipt stays what was sold. Once per change.
 */
export async function creditBookingCoach(bookingId: number, changeId: number, what: string, amount: number): Promise<Document | null> {
  const full = await bookingSale(bookingId);
  if (!full || full.paymentStatus !== "paid" || amount <= 0) return null;
  const total = roundMoney(amount);
  const tax = full.taxRate ? await venueTax(full.venueId) : null;
  return write({
    venue_id: full.venueId,
    kind: "credit_note",
    source: `booking:${bookingId}:coach:${changeId}`,
    credits_id: null,
    credits_ref: full.code,
    user_id: full.userId,
    customer_name: full.name,
    customer_phone: full.phone,
    lines: JSON.stringify([{ description: `${what}, ${full.code}: the difference`, amount: total }]),
    total,
    tax_name: full.taxRate ? tax!.name : null,
    tax_rate: full.taxRate,
    tax_amount: full.taxRate ? taxIncluded(total, full.taxRate) : 0,
    tax_reg_no: full.taxRate ? tax!.regNo : null,
    paid_via: paidVia(full.paidVia),
    note: "receipt.why.coachChanged",
  });
}

/**
 * A paid booking moved to a cheaper time (lib/move-money.ts): a credit note for the difference that goes back, at the tax the booking
 * was sold at, on the way it was paid (or `backAs`, a counter payment given as stored credit). The booking's receipt stays what was
 * sold. Once per move: it is keyed by the move's row.
 */
export async function creditBookingMove(bookingId: number, moveId: number, amount: number, backAs?: string): Promise<Document | null> {
  const full = await bookingSale(bookingId);
  if (!full || full.paymentStatus !== "paid" || amount <= 0) return null;
  const total = roundMoney(amount);
  const tax = full.taxRate ? await venueTax(full.venueId) : null;
  return write({
    venue_id: full.venueId,
    kind: "credit_note",
    source: `booking:${bookingId}:move:${moveId}`,
    credits_id: null,
    credits_ref: full.code,
    user_id: full.userId,
    customer_name: full.name,
    customer_phone: full.phone,
    lines: JSON.stringify([{ description: `${full.code}: moved to a time that costs less, the difference`, amount: total }]),
    total,
    tax_name: full.taxRate ? tax!.name : null,
    tax_rate: full.taxRate,
    tax_amount: full.taxRate ? taxIncluded(total, full.taxRate) : 0,
    tax_reg_no: full.taxRate ? tax!.regNo : null,
    paid_via: backAs ?? paidVia(full.paidVia),
    note: "receipt.why.movedCheaperBack",
  });
}

/**
 * A paid booking's price lowered by a manager afterwards
 * (lib/price-adjustments.ts): a credit note for the difference, at the tax the
 * booking was sold at, given back the way it was paid. The booking's receipt
 * stays what was sold. Once per adjustment.
 */
export async function creditBookingAdjustment(bookingId: number, adjustmentId: number, amount: number, complimentary: boolean): Promise<Document | null> {
  const full = await bookingSale(bookingId);
  if (!full || full.paymentStatus !== "paid" || amount <= 0) return null;
  const total = roundMoney(amount);
  const tax = full.taxRate ? await venueTax(full.venueId) : null;
  return write({
    venue_id: full.venueId,
    kind: "credit_note",
    source: `booking:${bookingId}:adjust:${adjustmentId}`,
    credits_id: null,
    credits_ref: full.code,
    user_id: full.userId,
    customer_name: full.name,
    customer_phone: full.phone,
    lines: JSON.stringify([
      {
        description: complimentary ? "Complimentary" : "Price adjusted by the venue",
        amount: total,
        adjusted: complimentary ? "complimentary" : "adjusted",
      } satisfies Line,
    ]),
    total,
    tax_name: full.taxRate ? tax!.name : null,
    tax_rate: full.taxRate,
    tax_amount: full.taxRate ? taxIncluded(total, full.taxRate) : 0,
    tax_reg_no: full.taxRate ? tax!.regNo : null,
    paid_via: paidVia(full.paidVia),
    note: "receipt.p8b.adjusted",
  });
}

/** What a tournament entry or league season sold: for its receipt, however it was paid. */
interface FeeSale {
  venueId: number;
  userId: number | null;
  name: string;
  phone: string | null;
  description: StaffText;
  fee: number;
}

export async function entrySale(entryId: number): Promise<FeeSale | null> {
  const row = (await getDb()
    .prepare(
      `SELECT t.venue_id, t.name AS tournament, COALESCE(e.fee, t.entry_fee)::float AS fee, e.user_id, e.name, u.phone
         FROM tournament_entries e JOIN tournaments t ON t.id = e.tournament_id LEFT JOIN users u ON u.id = e.user_id
        WHERE e.id = ?`
    )
    .get(entryId)) as { venue_id: number; tournament: string; fee: number; user_id: number | null; name: string; phone: string | null } | undefined;
  return row
    ? { venueId: row.venue_id, userId: row.user_id, name: row.name, phone: row.phone, description: said("srv.line.entry", { name: row.tournament }), fee: row.fee }
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
        description: said("srv.line.leagueFee", { name: row.league, n: row.number }),
        fee: row.fee,
      }
    : null;
}

/**
 * A fee marked paid at the counter: receipted, and credited if the mark is
 * taken back. Marked paid again, it is a payment of its own with its own
 * receipt, so each is told apart by when it was made.
 */
export async function receiptFee(
  kind: "entry" | "place",
  id: number,
  paid: boolean,
  /** How the desk took it (lib/types.ts COUNTER_METHODS); "At the counter" where not said. */
  via?: CounterMethod | null
): Promise<void> {
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
    lines: [saidLine(sale.description, sale.fee)],
    paidVia: paidVia(via) ?? "At the counter",
    taxable: true,
  });
}

/** The receipt an online payment produced, if any: its own, or the membership or pass it bought. */
export async function receiptOfPayment(paymentId: number): Promise<Document | null> {
  const row = (await getDb()
    .prepare(
      `SELECT r.* FROM receipts r
        WHERE r.source = 'payment:' || ? OR r.source = 'membership:' || (SELECT membership_id FROM online_payments WHERE id = ?)
           OR r.source = 'pass:' || (SELECT pass_id FROM online_payments WHERE id = ?)
        ORDER BY r.id LIMIT 1`
    )
    .get(String(paymentId), paymentId, paymentId)) as Row | undefined;
  return row ? toDocument(row) : null;
}
