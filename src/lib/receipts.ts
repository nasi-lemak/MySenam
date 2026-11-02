import crypto from "crypto";
import { keyedHash } from "./secrets";
import { findBookingByCode, getVenue } from "./store";
import { taxIncluded, taxName, venueTax } from "./tax";
import { bookingSale, documentById, documentFor, documentId, lineText, paidVia, type Document, type Line } from "./documents";
import { siteName } from "./site";
import { DICTIONARIES, type Phrase, type T } from "./i18n";
import { isConcessionPreset } from "./concessions-shared";
import { activityName } from "./activity-registry";
import { formatMinute } from "./interval";

/**
 * Receipts as the customer sees them: a page to keep or print, and — when
 * the venue is registered for SST or GST — a tax invoice, with the tax
 * inside the price and the venue's registration number.
 *
 * Two kinds sit behind the same address. A booking's receipt is drawn from
 * the booking (its code is its number). Everything else sold — memberships,
 * passes, credit, entries, league fees, shares — and every credit note is a
 * document written when the money moved (lib/documents.ts), at "R<id>".
 *
 * The address carries a token signed with the install's secret rather than
 * the customer's phone number, so it can go in an email and a browser's
 * history without giving anybody else a way in.
 */

export function receiptToken(code: string): string {
  return keyedHash("receipt", code.toUpperCase()).slice(0, 24);
}

/** The receipt's path, to put after the venue's own address. */
export function receiptPath(code: string): string {
  return `/receipt/${encodeURIComponent(code)}?t=${receiptToken(code)}`;
}

export interface Receipt {
  /** What is in its address: a booking code, or "R42". */
  code: string;
  kind: "receipt" | "credit_note";
  /** The number printed on it. */
  number: string;
  venue: { name: string; address: string; phone: string };
  customer: string;
  /** When it was paid (or credited); the booking's date for one paid as it was made. */
  paidAt: string | null;
  paidVia: string | null;
  lines: Line[];
  total: number;
  /** The tax inside the total, with what the venue is registered as. Null with none. */
  tax: { name: string; rate: number; amount: number; regNo: string | null } | null;
  cancelled: boolean;
  /** A credit note: the number of what it reverses. */
  credits: string | null;
  /** A cancelled booking's credit note, to link to. */
  creditNote: { number: string; path: string } | null;
  /**
   * A line under it: a phrase key ("receipt.why.refunded"), shown in the
   * reader's language with the issuer's `taxName`.
   */
  note: string | null;
  taxName: string;
  /** Paid with a pass at a registered venue: the tax it carries was on the pass's receipt. */
  passTax: string | null;
}

function tokenMatches(code: string, token: string): boolean {
  const expected = receiptToken(code);
  return token.length === expected.length && crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected));
}

async function issuer(venueId: number | null): Promise<Receipt["venue"] | null> {
  if (venueId === null) return { name: siteName(), address: "", phone: "" };
  const venue = await getVenue(venueId);
  return venue ? { name: venue.name, address: venue.address, phone: venue.phone } : null;
}

/**
 * A line as this reader sees it. A built-in concession's price (*Student
 * price*) is said in their language; everything else, and a concession the
 * venue named itself, as written. One person's own price on their place
 * (*Member price, Alya*; *Child (under 12) price, Alya*) is said the same
 * way, with their name as written. Only the words change: the amount, and
 * the line kept in the venue's books, are the same in every language. A
 * language with no words for it says it as written.
 */
export function receiptLineText(t: T, line: Pick<Line, "description" | "concessionPreset" | "place" | "slot" | "who" | "adjusted">): string {
  const words = DICTIONARIES[t.locale];
  if (line.slot && words?.["lo6.rcpt.slot"]) return slotText(t, line.slot);
  // A manager's change to the price (lib/price-adjustments.ts), in the reader's language.
  if (line.adjusted) {
    const key: Phrase = line.adjusted === "complimentary" ? "p8b.rcpt.complimentary" : "p8b.rcpt.adjusted";
    if (words?.[key]) return t(key);
  }
  const preset = line.concessionPreset;
  const said = (key: Phrase) => Boolean(words?.[key]);
  let price: string | null = null;
  if (line.place?.kind === "membership") price = said("fin5.memberPrice") ? t("fin5.memberPrice") : null;
  else if (isConcessionPreset(preset)) {
    const name = `pre.con.${preset}` as Phrase;
    price = said(name) && said("rcpt.concessionPrice") ? t("rcpt.concessionPrice", { name: t(name) }) : null;
  }
  // As written, with whom it is for where the line keeps that apart (lib/documents.ts `lineText`).
  if (price === null) return lineText(line);
  const who = line.place?.name;
  if (!who) return price;
  return said("fin5.placeFor") ? t("fin5.placeFor", { price, name: who }) : lineText(line);
}

/**
 * A booking's court time as this reader reads it: the activity's name and the
 * hours in their language (lib/time.ts `formatHour`), and whom its places are
 * for, by name, where the booking names anybody other than its customer
 * ("…, for Alya, Bilal"), so a guardian paying for two children sees which is
 * which. In English it reads as the line was written, the names added.
 */
function slotText(t: T, s: NonNullable<Line["slot"]>): string {
  let text = t("lo6.rcpt.slot", {
    // A lane still to be given on arrival is said so in the reader's language (lib/lanes.ts).
    court: s.onArrival ? t("bowl.laneOnArrival") : s.court,
    activity: activityName(s.sport, t.locale),
    date: s.date,
    from: formatMinute(s.startMin, t.locale),
    to: formatMinute(s.endMin, t.locale),
  });
  if (s.players > 1) text = t("lo6.rcpt.players", { line: text, n: s.players });
  return s.for.length > 0 ? t("pbk.msg.for", { what: text, names: s.for.join(", ") }) : text;
}

/**
 * The lines of a document kept from a booking (its credit note, or its
 * receipt written down when it stopped being paid), with the concession's
 * key where one written before lines kept it can be told for certain: the
 * booking's own line today says the same words and amount, and knows its key.
 */
async function withConcessionKeys(doc: Document): Promise<Line[]> {
  const from = /^booking(?:-paid)?:(\d+)(?::|$)/.exec(doc.source);
  if (!from || !doc.lines.some((l) => l.amount < 0 && !l.concessionPreset)) return doc.lines;
  // The booking's own concession only: one person's line written before lines kept it stays as stored.
  const keyed = ((await bookingSale(Number(from[1])))?.lines ?? []).filter((l) => l.concessionPreset && !l.place);
  if (keyed.length === 0) return doc.lines;
  return doc.lines.map((l) => {
    if (l.concessionPreset || l.place || l.amount >= 0) return l;
    const same = keyed.find((k) => k.description === l.description && k.amount === l.amount);
    return same ? { ...l, concessionPreset: same.concessionPreset } : l;
  });
}

async function fromDocument(code: string, doc: Document): Promise<Receipt | null> {
  const venue = await issuer(doc.venueId);
  if (!venue) return null;
  return {
    code,
    kind: doc.kind,
    number: doc.number,
    venue,
    customer: doc.customerName,
    paidAt: doc.issuedAt,
    paidVia: doc.paidVia,
    lines: await withConcessionKeys(doc),
    total: doc.total,
    tax: doc.tax,
    cancelled: false,
    credits: doc.credits,
    creditNote: null,
    note: doc.note,
    taxName: doc.venueId === null ? taxName() : (await venueTax(doc.venueId)).name,
    passTax: null,
  };
}

/** The receipt behind a signed link, or null: a wrong token, no such thing, or nothing paid. */
export async function receiptFor(code: string, token: string): Promise<Receipt | null> {
  if (!tokenMatches(code, token)) return null;

  const id = documentId(code);
  if (id !== null) {
    const doc = await documentById(id);
    return doc ? fromDocument(code, doc) : null;
  }

  const booking = await findBookingByCode(code);
  if (!booking || booking.paymentStatus !== "paid") return null;
  const sale = await bookingSale(booking.id);
  if (!sale || sale.total <= 0) return null;
  const venue = await issuer(sale.venueId);
  if (!venue) return null;
  const registered = await venueTax(sale.venueId);
  const credit = await documentFor(`booking:${booking.id}`);
  return {
    code: booking.code,
    kind: "receipt",
    number: booking.code,
    venue,
    customer: booking.name,
    paidAt: booking.paidAt,
    paidVia: paidVia(booking.paidVia),
    lines: sale.lines,
    total: sale.total,
    tax: sale.taxRate
      ? { name: registered.name, rate: sale.taxRate, amount: taxIncluded(sale.total, sale.taxRate), regNo: registered.regNo }
      : null,
    cancelled: booking.status === "cancelled",
    credits: null,
    creditNote: credit ? { number: credit.number, path: receiptPath(credit.ref) } : null,
    note: null,
    taxName: registered.name,
    passTax: booking.paidVia === "pass" && registered.registered ? registered.name : null,
  };
}
